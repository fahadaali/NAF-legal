// عميل Claude API — استدعاءات عادية، streaming، وأدوات البحث الأصلية
import type { Env } from '../types';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | any[];
}

export interface ClaudeCallOptions {
  model: string;
  system?: string;
  messages: ClaudeMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: any[];
  tool_choice?: any;
}

// استدعاء غير متدفّق يعيد النص الكامل (يُستخدم للمُخطِّط والتصنيف)
export async function callClaude(env: Env, opts: ClaudeCallOptions): Promise<{ text: string; raw: any }> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.max_tokens ?? 4096,
      temperature: opts.temperature ?? 0.3,
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
      tool_choice: opts.tool_choice,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API error ${res.status}: ${body}`);
  }
  const data = (await res.json()) as any;
  const text = (data.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');
  return { text, raw: data };
}

// استدعاء متدفّق (SSE) — يعيد ReadableStream من مقاطع النص لعرضها تدريجيًا
export async function streamClaude(env: Env, opts: ClaudeCallOptions): Promise<ReadableStream<Uint8Array>> {
  const upstream = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.max_tokens ?? 8192,
      temperature: opts.temperature ?? 0.4,
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
      tool_choice: opts.tool_choice,
      stream: true,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text().catch(() => '');
    throw new Error(`Claude stream error ${upstream.status}: ${body}`);
  }

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

export const TRACKING_SOURCES = [
  { name: 'جريدة أم القرى', domain: 'uqn.gov.sa' },
  { name: 'المركز الوطني للوثائق والمحفوظات', domain: 'ncar.gov.sa' },
  { name: 'هيئة الخبراء بمجلس الوزراء', domain: 'boe.gov.sa' },
];
