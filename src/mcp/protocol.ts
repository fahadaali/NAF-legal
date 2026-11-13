/**
 * خادم MCP — طبقةُ البروتوكول وحدها.
 *
 * `lib/mcp.ts` عميلٌ تقرأ به المنصةُ من خوادم غيرها (الشاملة، تراث). وهذا عكسه:
 * خادمٌ تقرأ منه أدواتُ الذكاء الاصطناعي التي يستعملها الأعضاء — Claude وChatGPT
 * وغيرهما — أنظمةَ المنصة. والاسمان متقاربان والاتجاهان متعاكسان، فلكلٍّ مجلّده.
 *
 * ── لماذا بلا جلسة ──
 *
 * مراجعةُ `2025-11-25` تسمح بالجلسة ولا توجبها، و`2026-07-28` أسقطتها أصلاً
 * (انظر رأس `lib/mcp.ts`). فخادمٌ بلا جلسة يخدم المراجعتين معاً: يُجيب المصافحةَ
 * لمن يرسلها، ويُجيب أيَّ طلبٍ بعدها أو بدونها، ولا يحفظ بين طلبين شيئاً سوى
 * رمز الدخول. وعاملُ Cloudflare لا يضمن أن يصل طلبان متتاليان إلى النسخة نفسها،
 * فالجلسة كانت ستحتاج KV لا تحتاجه الأدوات.
 *
 * ── ولا مجرى ──
 *
 * كلُّ أداةٍ هنا قراءةٌ من D1 تنتهي في جزءٍ من الثانية، فلا تقدّمَ يُبلَّغ ولا
 * مجرى SSE يُفتح: الردُّ JSON واحد. و`GET` على النقطة — وهو طلبُ مجرى من
 * الخادم — يُردّ بـ٤٠٥ كما تنصّ المواصفة لخادمٍ لا يقدّمه.
 *
 * ── وهذا الملف لا يعرف D1 ولا Hono ──
 *
 * يأخذ الطلب والأدوات والمصادقة حقناً ويردّ `Response`. فيُشغَّل في فحص
 * `audit/mcp-server-check.mjs` على Node بأدواتٍ صورية، كما يُشغَّل العميل في
 * `audit/mcp-client-check.mjs`: ما يُخشى هنا سلوكٌ لا سطر.
 */

/** المراجعات التي يُجاب بها إن طلبها العميل. والأولى هي ما يُردّ لمن طلب غيرها. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/**
 * من يطلب: عضوٌ دخل من المركز، أو ضيفٌ دخل برمز التحقق.
 *
 * والفرق ليس في الهوية وحدها بل في الأدوات: الضيف لا تُعرض له أداةُ كتابة
 * أصلاً (`naf-terms.md` §١٥)، فلا يُرفض نداؤه لها — هي غير موجودة عنده.
 */
export type McpPrincipal =
  | {
      kind: 'member';
      /** `users.id` — المعرّف المحلي الذي تعلّق عليه المحادثات. */
      userId: string;
      /** `members.user_id` — `sub` القادم من المركز. */
      memberId: string;
      role: string;
      name: string | null;
      /** اسم الأداة كما أعلنته عند التسجيل — لعلامة مصدر المحادثة. */
      clientName: string | null;
      tokenId: string;
    }
  | {
      kind: 'guest';
      guestId: string;
      email: string;
      clientName: string | null;
      tokenId: string;
    };

export interface McpToolResult {
  /** نصٌّ تقرؤه الأداة. ولا يُعرض للإنسان إلا عبرها. */
  text: string;
  /** رفضُ الأداة: الاتصال سليم والطلب لا يُجاب. يُعاد `isError` لا خطأ بروتوكول. */
  isError?: boolean;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** للقراءة وحدها؟ يظهر للأداة تلميحاً، ويقرّر من تُعرض عليه. */
  readOnly: boolean;
  /** من تُعرض له. الافتراضي: الجميع. */
  visibleTo?: (p: McpPrincipal) => boolean;
  run: (args: Record<string, unknown>, principal: McpPrincipal) => Promise<McpToolResult>;
}

export interface McpServerDeps {
  /**
   * هويّةُ الخادم كما تعرضها الأداة. و`icons` و`websiteUrl` من مراجعة
   * `2025-11-25`: بهما تعرض الأداة شعارَ ناف بجانب الموصّل بدل أيقونةٍ عامّة.
   * والعميلُ الأقدم يتجاهل حقلاً لا يعرفه.
   */
  serverInfo: {
    name: string;
    title: string;
    version: string;
    icons?: { src: string; mimeType: string; sizes: string[] }[];
    websiteUrl?: string;
  };
  instructions: string;
  tools: McpTool[];
  /** يقرأ ترويسة `Authorization` ويردّ صاحبها، أو `null` إن لم تصلح. */
  authenticate: (req: Request) => Promise<McpPrincipal | null>;
  /** عنوانُ وثيقة الموارد المحمية (RFC 9728) — يُدلّ عليه في تحدّي ٤٠١. */
  resourceMetadataUrl: string;
  /** يُنادى بعد كل نداء أداة — للسجلّ. لا يُنتظر ولا يُسقط الردّ إن فشل. */
  onToolCall?: (principal: McpPrincipal, tool: string, ok: boolean) => void;
}

type JsonRpcId = string | number;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

// رموز JSON-RPC المعيارية
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function rpcError(id: JsonRpcId | null, code: number, message: string): Response {
  return json(200, { jsonrpc: '2.0', id, error: { code, message } });
}

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return json(200, { jsonrpc: '2.0', id, result });
}

/**
 * تحدّي ٤٠١ — بلا رمزٍ أو برمزٍ لا يصلح.
 *
 * `resource_metadata` هو ما تبدأ منه الأداة تفويضها: تقرأ الوثيقة فتعرف خادم
 * التفويض، ثم تسجّل نفسها وتفتح للعضو صفحة الدخول. بدونه يقف الربط عند ٤٠١.
 */
function unauthorized(deps: McpServerDeps, hadToken: boolean): Response {
  const parts = [`Bearer resource_metadata="${deps.resourceMetadataUrl}"`];
  if (hadToken) parts.push('error="invalid_token"');
  return json(401, { error: hadToken ? 'invalid_token' : 'unauthorized' }, { 'www-authenticate': parts.join(', ') });
}

function isRequest(v: unknown): v is JsonRpcRequest {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  return m.jsonrpc === '2.0' && typeof m.method === 'string';
}

function visibleTools(deps: McpServerDeps, p: McpPrincipal): McpTool[] {
  return deps.tools.filter((t) => !t.visibleTo || t.visibleTo(p));
}

function describe(t: McpTool) {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      title: t.title,
      readOnlyHint: t.readOnly,
      // الكتابة الوحيدة إضافةٌ إلى محادثات العضو — لا تمحو شيئاً.
      destructiveHint: false,
      idempotentHint: t.readOnly,
      // عالمٌ مغلق: قاعدة المنصة وحدها، لا الشبكة.
      openWorldHint: false,
    },
  };
}

/** المعالج كلّه: طلبُ HTTP داخل، وردُّ HTTP خارج. */
export async function handleMcpRequest(req: Request, deps: McpServerDeps): Promise<Response> {
  if (req.method === 'GET' || req.method === 'DELETE') {
    // لا مجرى من الخادم ولا جلسة تُنهى — كلاهما ٤٠٥ في المواصفة لخادمٍ بلا جلسة.
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });

  // المصادقة قبل قراءة الجسم: من لا رمز له لا يُحلَّل له شيء.
  const auth = req.headers.get('authorization');
  const principal = await deps.authenticate(req);
  if (!principal) return unauthorized(deps, !!auth);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
  }

  // الدُّفعات أُسقطت من المواصفة منذ `2025-06-18`، ولا عميلَ حديثاً يرسلها.
  if (Array.isArray(body)) {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Batch requests are not supported' } });
  }
  if (!isRequest(body)) {
    // ردٌّ من العميل على طلبٍ لم يرسله الخادم قط — يُقبل ويُهمل.
    if (body && typeof body === 'object' && 'jsonrpc' in body && ('result' in body || 'error' in body)) {
      return new Response(null, { status: 202 });
    }
    return json(400, { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid request' } });
  }

  // الإشعار بلا معرّف لا ردَّ له: ٢٠٢ وجسمٌ فارغ.
  if (body.id === undefined || body.id === null) return new Response(null, { status: 202 });
  const id = body.id;
  const params = body.params ?? {};

  switch (body.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
        ? asked
        : LATEST_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: deps.serverInfo,
        instructions: deps.instructions,
      });
    }

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, { tools: visibleTools(deps, principal).map(describe) });

    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = visibleTools(deps, principal).find((t) => t.name === name);
      // أداةٌ لا يراها هذا الطالب كأداةٍ لا وجود لها — لا يُقال له إنها موجودة لغيره.
      if (!tool) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name}`);
      const args =
        params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      let result: McpToolResult;
      try {
        result = await tool.run(args, principal);
      } catch (e) {
        // عطلٌ في القاعدة أو في الأداة: يُقال للأداة أنه عطل، لا يُسقط الاتصال.
        console.error(`mcp tool ${name} failed`, e);
        deps.onToolCall?.(principal, name, false);
        return rpcResult(id, {
          content: [{ type: 'text', text: 'تعذّر تنفيذ الطلب لعطلٍ في المنصة. أعد المحاولة بعد قليل.' }],
          isError: true,
        });
      }
      deps.onToolCall?.(principal, name, !result.isError);
      return rpcResult(id, { content: [{ type: 'text', text: result.text }], isError: !!result.isError });
    }

    // لا موارد ولا قوالب أوامر: قائمتان فارغتان لمن يسأل، لا «طريقة غير معروفة».
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'resources/templates/list':
      return rpcResult(id, { resourceTemplates: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });

    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${body.method}`);
  }
}

/* يُستعمل في الأدوات لقراءة المعاملات بلا مكتبة تحقق. */
export function argString(args: Record<string, unknown>, key: string, max = 500): string | null {
  const v = args[key];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

export function argInt(args: Record<string, unknown>, key: string, def: number, min: number, max: number): number {
  const v = args[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

export function argBool(args: Record<string, unknown>, key: string): boolean {
  const v = args[key];
  return v === true || v === 'true' || v === 1;
}
