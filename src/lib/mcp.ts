/**
 * عميل MCP أدنى ما يكفي — نقلُ Streamable HTTP، بـ`fetch` خام لا حزمة.
 *
 * (المستودع لا يستورد حزمةً لعميل: `lib/claude.ts` نفسه `fetch` خام على واجهة
 * Anthropic. والسببُ هنا أقوى: عاملُ Cloudflare، وحزمةُ MCP الرسمية تفترض
 * بيئة Node بنقلٍ عبر stdio.)
 *
 * ── أيّ مراجعةٍ من المواصفة ──
 *
 * `2025-11-25`، وهي آخر مراجعات الحقبة القديمة: مصافحةٌ وجلسة. وقد صدرت بعدها
 * `2026-07-28` فأسقطت المصافحة والجلسة معاً وأضافت ترويستين لازمتين —
 * `Mcp-Method` و`Mcp-Name`. والخوادم المنشورة اليوم على القديمة، وموصِّل
 * Anthropic نفسه يشير إلى تفويض `2025-11-25`.
 *
 * فالعميل يبني على القديمة **ويرسل الترويستين الجديدتين على كل حال**: الخادم
 * القديم يتجاهل ترويسةً لا يعرفها، والحديث الصارم يرفض من لا يرسلهما. تأمينٌ
 * بسطرين.
 *
 * ── ثلاثةُ أخطاءٍ لا واحد ──
 *
 * تفريقُها هو كلُّ الفرق بين «المصدر معطَّل» و«سؤالك لم يجد شيئاً»:
 *   1. `!res.ok` أو انقطاع الشبكة   → عطلُ نقل. يُعاد مرّةً إن كان ٤٠٤ جلسة.
 *   2. `body.error`                  → عطلُ بروتوكول: أداةٌ لا وجود لها أو
 *                                      معاملاتٌ خاطئة. خطؤنا، ولا يُعاد.
 *   3. `body.result.isError === true`→ عطلُ أداة: الاتصال سليم والأداة رفضت.
 *
 * ── ولا يرمي إلى المنادي أبداً ──
 *
 * `callTool` تردّ `McpOutcome` لا تستثناءً. مصدرٌ ساقط يُنقص التغطية ولا
 * يُسقط استشارةً — وهي سياسةُ `retrieve()` نفسها حين لا تكون قاعدة المعرفة
 * مهيّأة (`lib/rag.ts`).
 */
import type { Env } from '../types';
import type { ExternalSource } from './sources';

const PROTOCOL_VERSION = '2025-11-25';
const CLIENT_INFO = { name: 'naf-legal', version: '1.0.0' };

/** عمرُ الجلسة في KV. قصيرٌ عمداً: انتهاؤها عند الخادم يكلّف مصافحةً واحدة. */
const SESSION_TTL_S = 600;

export interface McpOk {
  ok: true;
  /** الجسم المهيكل إن وُجد، وإلا ما حُلّل من كتلة النصّ. */
  data: unknown;
}
export interface McpFail {
  ok: false;
  /** `transport` عطلُ شبكة أو حالة · `protocol` خطؤنا · `tool` رفضُ الأداة. */
  kind: 'transport' | 'protocol' | 'tool' | 'config';
  message: string;
}
export type McpOutcome = McpOk | McpFail;

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: any;
  error?: { code?: number; message?: string };
}

function sessionKey(sourceId: string): string {
  return `mcp:${sourceId}`;
}

/** ترويسات كل طلب. والرمز على **كلِّ** طلب — الجلسة لا تنوب عنه (المواصفة). */
function headers(
  source: ExternalSource,
  token: string | null,
  protocolVersion: string | null,
  sessionId: string | null,
  method: string,
  name?: string
): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    // كلاهما لازم بنصّ المواصفة: الخادم يختار أيّهما يردّ به.
    accept: 'application/json, text/event-stream',
    // تأمينُ الحقبة الحديثة — القديمة تتجاهلهما.
    'mcp-method': method,
  };
  if (name) h['mcp-name'] = name;
  if (protocolVersion) h['mcp-protocol-version'] = protocolVersion;
  if (sessionId) h['mcp-session-id'] = sessionId;
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/**
 * يقرأ جسم الردّ: إمّا JSON واحد، وإمّا مجرى SSE يُقرأ حتى يصل ردُّ طلبنا.
 *
 * **والحلقة `while` لا قراءةٌ واحدة.** مجرى SSE في MCP قد يسبق ردَّه إشعاراتُ
 * تقدّم (`notifications/progress`) لا تعنينا — فقراءةٌ واحدة تعود بلا نتيجة
 * وتُسقط ردّاً وصل بعدها. وهو الفخّ نفسه الموثَّق في `lib/claude.ts`.
 *
 * والسطور التي تبدأ بـ`:` تعليقاتُ إبقاءٍ على قيد الحياة تُتجاهل بحكم البناء:
 * لا تبدأ بـ`data: `.
 */
async function readBody(res: Response, id: number): Promise<JsonRpcResponse | null> {
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('text/event-stream')) {
    return (await res.json().catch(() => null)) as JsonRpcResponse | null;
  }
  if (!res.body) return null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const evt of events) {
        const line = evt.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        let parsed: JsonRpcResponse;
        try {
          parsed = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        // إشعارٌ بلا `id` ليس ردَّنا؛ وردُّ طلبٍ آخر ليس ردَّنا.
        if (parsed.id === id) return parsed;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

let nextId = 1;

async function rpc(
  source: ExternalSource,
  token: string | null,
  protocolVersion: string | null,
  sessionId: string | null,
  method: string,
  params: unknown,
  name?: string
): Promise<{ res: Response; body: JsonRpcResponse | null; id: number }> {
  const id = nextId++;
  const res = await fetch(source.endpoint!, {
    method: 'POST',
    headers: headers(source, token, protocolVersion, sessionId, method, name),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(source.timeoutMs),
  });
  const body = res.ok ? await readBody(res, id) : null;
  return { res, body, id };
}

interface Session {
  id: string | null;
  protocolVersion: string;
}

/**
 * مصافحة: `initialize` ثم `notifications/initialized`.
 *
 * ونسخةُ البروتوكول المُعادة هي التي تُرسَل بعدُ، لا التي طُلبت: الخادم قد
 * يتفاوض على غيرها، وإرسالُ ما طلبناه يجعله يرفض كلَّ طلبٍ تالٍ بـ٤٠٠.
 */
async function handshake(
  env: Env,
  source: ExternalSource,
  token: string | null
): Promise<Session | McpFail> {
  let res: Response;
  let body: JsonRpcResponse | null;
  try {
    ({ res, body } = await rpc(source, token, null, null, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }));
  } catch (e) {
    return { ok: false, kind: 'transport', message: reason(e) };
  }

  if (!res.ok) {
    return {
      ok: false,
      kind: res.status === 401 || res.status === 403 ? 'config' : 'transport',
      message: `initialize ${res.status}`,
    };
  }
  if (body?.error) return { ok: false, kind: 'protocol', message: body.error.message ?? 'initialize error' };

  const negotiated: string =
    typeof body?.result?.protocolVersion === 'string' ? body.result.protocolVersion : PROTOCOL_VERSION;
  const id = res.headers.get('mcp-session-id');

  /* الإشعار يعود ٢٠٢ بلا جسم، فلا يُقرأ. وفشلُه لا يُبطل المصافحة: خوادمُ
     عديمةُ الحالة تقبل النداء بعده على أي حال، وإسقاطُ مصدرٍ لأجل إشعارٍ
     لم يُستقبل أشدُّ ضرراً من المضيّ. */
  try {
    await fetch(source.endpoint!, {
      method: 'POST',
      headers: headers(source, token, negotiated, id, 'notifications/initialized'),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(source.timeoutMs),
    });
  } catch (e) {
    console.error(`mcp ${source.id}: initialized notification failed: ${reason(e)}`);
  }

  const session: Session = { id, protocolVersion: negotiated };
  if (id) {
    await env.KV.put(sessionKey(source.id), JSON.stringify(session), { expirationTtl: SESSION_TTL_S }).catch(
      () => {}
    );
  }
  return session;
}

async function cachedSession(env: Env, sourceId: string): Promise<Session | null> {
  try {
    const raw = await env.KV.get(sessionKey(sourceId));
    if (!raw) return null;
    const s = JSON.parse(raw);
    return typeof s?.protocolVersion === 'string' ? s : null;
  } catch {
    return null;
  }
}

/**
 * ينادي أداةً على المصدر ويردّ جسمها.
 *
 * ولا يُصافح في كل استعلام: الجلسة في KV. وانتهاؤها عند الخادم يعود ٤٠٤ —
 * فتُمحى وتُعاد المصافحة **مرّةً واحدة**، لا حلقةً تتكرّر على خادمٍ معطوب.
 */
export async function callTool(
  env: Env,
  source: ExternalSource,
  token: string | null,
  tool: string,
  args: Record<string, unknown>
): Promise<McpOutcome> {
  if (!source.endpoint) return { ok: false, kind: 'config', message: 'لا عنوان للمصدر' };
  if (source.tokenKey && !token) return { ok: false, kind: 'config', message: 'رمز المصدر غير مضبوط' };

  let session = await cachedSession(env, source.id);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!session) {
      const fresh = await handshake(env, source, token);
      if ('ok' in fresh) return fresh; // فشلت المصافحة — يُردّ سببُها كما هو
      session = fresh;
    }

    let res: Response;
    let body: JsonRpcResponse | null;
    try {
      ({ res, body } = await rpc(
        source,
        token,
        session.protocolVersion,
        session.id,
        'tools/call',
        { name: tool, arguments: args },
        tool
      ));
    } catch (e) {
      return { ok: false, kind: 'transport', message: reason(e) };
    }

    /* ٤٠٤ على طلبٍ يحمل جلسة = الخادم أنهاها. والمواصفة صريحة: تُترك الجلسة
       وتُبدأ أخرى بـ`initialize` بلا معرّف. مرّةً واحدة — ومصدرٌ يردّ ٤٠٤
       على جلسةٍ جديدة معطوبٌ، وحلقةُ إعادةٍ عليه تستنفد الطلبات الفرعية. */
    if (res.status === 404 && session.id && attempt === 0) {
      await env.KV.delete(sessionKey(source.id)).catch(() => {});
      session = null;
      continue;
    }
    if (!res.ok) {
      return {
        ok: false,
        kind: res.status === 401 || res.status === 403 ? 'config' : 'transport',
        message: `${tool} ${res.status}`,
      };
    }
    if (body?.error) return { ok: false, kind: 'protocol', message: body.error.message ?? 'خطأ بروتوكول' };
    if (!body?.result) return { ok: false, kind: 'protocol', message: 'ردٌّ بلا نتيجة' };
    if (body.result.isError === true) {
      return { ok: false, kind: 'tool', message: textOf(body.result) || 'رفضت الأداة الطلب' };
    }
    return { ok: true, data: payloadOf(body.result) };
  }
  return { ok: false, kind: 'transport', message: 'تعذّرت المصافحة' };
}

/**
 * الجسم المفيد من نتيجة الأداة.
 *
 * `structuredContent` أوّلاً إن وُجد. وإلا كتلةُ النصّ — والمواصفة تنصّ أن
 * الخادم الذي يردّ مهيكلاً **ينبغي** أن يردّ سلسلته نصّاً أيضاً، فالكتلة
 * غالباً JSON. فإن لم تكن، تُردّ نصّاً كما هي: محوّلٌ عامّ قد يفهمها.
 */
function payloadOf(result: any): unknown {
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const text = textOf(result);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // كتلةٌ داخل سياجٍ ```json … ``` — شائعةٌ في خوادم تكتب للقارئ لا للآلة.
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {}
    }
    return text;
  }
}

function textOf(result: any): string {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n')
    .trim();
}

function reason(e: unknown): string {
  if (e instanceof Error) return e.name === 'TimeoutError' ? 'انقضت المهلة' : e.message;
  return String(e);
}
