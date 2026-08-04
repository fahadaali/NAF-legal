// عميل Claude API — استدعاءات عادية، streaming، وأدوات البحث الأصلية
import type { Env } from '../types';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/**
 * البديل التلقائي عند رفض المصنّف — **مطفأ حتى يُتحقَّق منه**.
 *
 * Opus 5 يحمل ضوابط أمنية مشدَّدة، ومصنّفاتها قد تردّ طلباً مشروعاً بـ200
 * و `stop_reason: "refusal"` لا بخطأ. والقيمة `default` تجعل الخادم يعيد
 * الطلب على النموذج المناسب حسب صنف الرفض بدل أن يعود الرفض إلينا.
 *
 * وهو تجريبيّ: `fallbacks` حقلٌ في جسم الطلب، وحقلٌ لا يعرفه الـAPI يردّه
 * بـ400 — الصنفُ نفسه الذي عطّل المنصة. فلا يُشغَّل في النشرة التي تُعيدها
 * إلى العمل: خطرٌ غير مُتحقَّق منه يُركَب على إصلاحٍ مُتحقَّق منه يجعل
 * الفشل مبهماً، ولا يُعرَف أيُّ التغييرين سببُه.
 *
 * **التشغيل بعد أن يقول «فحص Claude» في لوحة الإدارة: مربوط.** عندئذٍ
 * ارفع هذا السطر إلى `true` وانشر: مسارُ الطلب معلومُ السلامة، فأيُّ عطبٍ
 * بعده يعود إلى البديل وحده.
 */
const FALLBACK_ENABLED = false;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODE = 'default';

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | any[];
}

/**
 * مستوى الجهد — يضبط عمق التفكير وحجم الإنفاق (§GA، بلا ترويسة تجربة).
 * الإغفال يعني `high`، وهو الافتراضي في الـAPI.
 */
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * لا معامِلات عيّنة هنا ولا في أي مستدعٍ لهذا الملف — لا `temperature` ولا
 * `top_p` ولا `top_k`.
 *
 * أُزيلت هذه المعامِلات من عائلة Opus 4.7 فصاعداً، وهي عائلة النموذج
 * المضبوط في `wrangler.toml`. فإرسال أيٍّ منها يردّه الـAPI بـ400 **قبل أن
 * يبدأ التوليد**، فيفشل كل استدعاء في المنصة: المُخطِّط والتصنيف والاستخراج
 * والتحقّق والتوليد. وأثر ذلك في الواجهة جملةٌ واحدة عند أول رسالة، لأن كل
 * مستدعٍ عدا التوليد يبتلع خطأه ويكمل بخطة احتياطية.
 *
 * وحذفها آمن على أي نموذج: الإغفال يعني القيمة الافتراضية لا قيمة شاذّة.
 * التوجيه يكون بالبرومبت لا بمعامِل عيّنة.
 *
 * **والتفكير مُفعَّل على Opus 5 بإغفال الحقل، لا مُعطَّل.** هذا انقلابٌ عن
 * Opus 4.8 حيث كان الإغفال يعني «بلا تفكير». وأثره أن `max_tokens` صار
 * سقفاً للتفكير **والنص معاً**، فحدٌّ ضيّق يبتلعه التفكير ويعود الردّ مقتطعاً
 * أو فارغاً — وفي استدعاءات JSON (المُخطِّط، التصنيف، التحقّق) يعني ذلك
 * تحليلاً فاشلاً وخطةً احتياطية صامتة. ومن هنا `MIN_MAX_TOKENS` أدناه.
 *
 * ولا يُعطَّل التفكير لتوفير الحدّ: تعطيله على Opus 5 يُخرج نداءَ الأداة
 * نصّاً عادياً فلا يُنفَّذ ولا يُبلَّغ عنه، ويُسرّب وسوم `<thinking>` إلى
 * الردّ. الضبط يكون بـ`effort` لا بتعطيل التفكير.
 */
export interface ClaudeCallOptions {
  model: string;
  system?: string;
  messages: ClaudeMessage[];
  max_tokens?: number;
  /** الإغفال يعني `high`. */
  effort?: ClaudeEffort;
  tools?: any[];
  tool_choice?: any;
}

/**
 * أرضيّةُ حدّ المخرَج.
 *
 * `max_tokens` سقفٌ لا حجز — لا يُدفع إلا عمّا وُلِّد فعلاً — فرفعُه مجّاني،
 * وخفضُه إلى ما دون هذا الحدّ مع تفكيرٍ مُفعَّل يعني ردّاً مقتطعاً. والأرضيّة
 * هنا لا في كل مستدعٍ: مستدعٍ جديد يُكتب غداً بحدٍّ صغير لا يُسقط نفسه بصمت.
 */
const MIN_MAX_TOKENS = 4096;

/** رسالة بلا محتوى يردّها الـAPI بـ400، والفراغ يقع من نصٍّ مقتطع أو حقل ناقص. */
function hasContent(m: ClaudeMessage): boolean {
  if (typeof m.content === 'string') return m.content.trim().length > 0;
  return Array.isArray(m.content) && m.content.length > 0;
}

/**
 * تنقية سجلّ الرسائل قبل إرساله.
 *
 * الـAPI يردّ 400 على رسالةٍ بمحتوى فارغ، وعلى سجلٍّ أوّلُه دور المساعد.
 * وكلتا الحالتين تقعان من سجلّ محادثةٍ تكتبه المنصة نفسها: محادثةٌ قُصَّ
 * أوّلها بحدّ الأربعين رسالة قد تبدأ برد مساعد. فالمنع في موضع البناء
 * أوثق من تتبّعه في كل مستدعٍ على حدة.
 */
function sanitizeMessages(messages: ClaudeMessage[]): ClaudeMessage[] {
  const kept = (messages ?? []).filter(hasContent);
  let start = 0;
  while (start < kept.length && kept[start].role !== 'user') start++;
  return kept.slice(start);
}

/** جسمُ الطلب — موضعٌ واحد يبنيه للاستدعاءين، فما صحّ لأحدهما صحّ للآخر. */
function buildBody(opts: ClaudeCallOptions, defaultMaxTokens: number, stream: boolean): string {
  const messages = sanitizeMessages(opts.messages);
  if (!messages.length) throw new Error('Claude request has no usable messages');

  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: Math.max(opts.max_tokens ?? defaultMaxTokens, MIN_MAX_TOKENS),
    messages,
  };
  if (FALLBACK_ENABLED) body.fallbacks = FALLBACK_MODE;
  // الحقول الاختيارية تُحذف ولا تُرسل فارغة: `system` فارغ و`tools` فارغة
  // كلاهما 400، والإغفال هو ما يعنيه غيابُها أصلاً.
  if (opts.system?.trim()) body.system = opts.system;
  if (opts.effort) body.output_config = { effort: opts.effort };
  if (opts.tools?.length) body.tools = opts.tools;
  if (opts.tool_choice) body.tool_choice = opts.tool_choice;
  if (stream) body.stream = true;
  return JSON.stringify(body);
}

function headers(env: Env): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': env.ANTHROPIC_API_KEY,
    'anthropic-version': API_VERSION,
  };
  if (FALLBACK_ENABLED) h['anthropic-beta'] = FALLBACK_BETA;
  return h;
}

/**
 * خطأ الـAPI يُسجَّل هنا لا في المستدعي.
 *
 * كل مستدعٍ لهذا الملف — عدا التوليد — يبتلع خطأه ويكمل بخطة احتياطية،
 * فهذا السطر هو الوحيد الذي يقول ما ردّ به الـAPI فعلاً. وبدونه يظهر
 * انقطاعٌ كامل في الخدمة كأنه خللٌ في صلاحيات المستخدم.
 */
async function apiError(res: Response, stage: string): Promise<Error> {
  const body = await res.text().catch(() => '');
  console.error(`claude ${stage} ${res.status}: ${body.slice(0, 500)}`);
  return new Error(`Claude API ${res.status}: ${body.slice(0, 300)}`);
}

// استدعاء غير متدفّق يعيد النص الكامل (يُستخدم للمُخطِّط والتصنيف)
export async function callClaude(env: Env, opts: ClaudeCallOptions): Promise<{ text: string; raw: any }> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: headers(env),
    body: buildBody(opts, 4096, false),
  });

  if (!res.ok) throw await apiError(res, 'call');
  const data = (await res.json()) as any;
  const text = (data.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');

  /* رفضُ المصنّف ليس خطأ HTTP: يعود بـ200 و `content` فارغة أو ناقصة.
     ولولا هذا الفحص لعاد نصٌّ فارغ يفشل تحليله فتمضي المنصة بخطة احتياطية
     صامتة — وهو الصنف نفسه الذي أخفى الانقطاع السابق. */
  if (!text.trim() && data.stop_reason === 'refusal') {
    const category = data.stop_details?.category ?? 'unknown';
    console.error(`claude call refused (${category})`);
    throw new Error(`Claude refused the request (${category})`);
  }
  return { text, raw: data };
}

// استدعاء متدفّق (SSE) — يعيد ReadableStream من مقاطع النص لعرضها تدريجيًا
export async function streamClaude(env: Env, opts: ClaudeCallOptions): Promise<ReadableStream<Uint8Array>> {
  const upstream = await fetch(API_URL, {
    method: 'POST',
    headers: headers(env),
    body: buildBody(opts, 8192, true),
  });

  if (!upstream.ok || !upstream.body) throw await apiError(upstream, 'stream');

  // نحوّل أحداث Anthropic SSE إلى أحداث SSE مبسّطة للواجهة:
  //   event: delta   data: {"text": "..."}
  //   event: citation data: {...}
  //   event: done    data: {}
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  let buffer = '';

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`));
        controller.close();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const evt of events) {
        const line = evt.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const json = line.slice(6);
        if (json === '[DONE]') continue;
        try {
          const parsed = JSON.parse(json);
          if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
            controller.enqueue(encoder.encode(`event: delta\ndata: ${JSON.stringify({ text: parsed.delta.text })}\n\n`));
          } else if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'web_search_tool_result') {
            controller.enqueue(encoder.encode(`event: search\ndata: ${JSON.stringify({ active: true })}\n\n`));
          } else if (parsed.type === 'message_start' && parsed.message?.usage) {
            controller.enqueue(encoder.encode(`event: usage\ndata: ${JSON.stringify({ input_tokens: parsed.message.usage.input_tokens ?? 0 })}\n\n`));
          } else if (parsed.type === 'message_delta' && parsed.usage) {
            controller.enqueue(encoder.encode(`event: usage\ndata: ${JSON.stringify({ output_tokens: parsed.usage.output_tokens ?? 0 })}\n\n`));
          }
        } catch {
          // تجاهل الأحداث غير القابلة للتحليل
        }
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

// أداة البحث في الإنترنت الأصلية (§10)
export function webSearchTool(allowedDomains?: string[]) {
  const tool: any = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };
  if (allowedDomains && allowedDomains.length) tool.allowed_domains = allowedDomains;
  return tool;
}

// المصادر الرسمية السعودية للبحث العام في الاستشارات (§1)
export const OFFICIAL_DOMAINS = [
  'uqn.gov.sa', // جريدة أم القرى
  'boe.gov.sa', // هيئة الخبراء بمجلس الوزراء
  'laws.boe.gov.sa',
  'ncar.gov.sa', // المركز الوطني للوثائق والمحفوظات
  'my.gov.sa', // البوابة الوطنية
  'moj.gov.sa',
  'mc.gov.sa',
  'hrsd.gov.sa',
];

// مصادر تتبّع الأنظمة الرسمية المعتمدة حصريًا (§7):
// جريدة أم القرى · المركز الوطني للوثائق والمحفوظات · هيئة الخبراء بمجلس الوزراء
export const TRACKING_DOMAINS = ['uqn.gov.sa', 'ncar.gov.sa', 'boe.gov.sa', 'laws.boe.gov.sa'];
