// تتبّع الاستخدام والتكلفة — §4 (لوحة التحليلات)
import { uuid } from './crypto';
import type { Env } from '../types';

// تسعير بالدولار لكل مليون رمز. يُحدَّث حسب أسعار Anthropic.
// `cacheRead` سعرُ القراءة من التخزين المؤقّت، والكتابةُ فيه (خمس دقائق) 1.25 من المدخلات.
const PRICING: Record<string, { in: number; out: number; cacheRead: number }> = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2 },
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5, cacheRead: 0.1 },
};

const CACHE_WRITE_FACTOR = 1.25;

function priceFor(model: string): { in: number; out: number; cacheRead: number } {
  if (PRICING[model]) return PRICING[model];
  if (model.includes('opus')) return PRICING['claude-opus-5-5'];
  if (model.includes('haiku')) return PRICING['claude-haiku-5-5'];
  return PRICING['claude-sonnet-5-5'];
}

export function computeCost(model: string, inTok: number, outTok: number, cacheRead = 0, cacheWrite = 0): number {
  const p = priceFor(model);
  return (
    (inTok * p.in + outTok * p.out + cacheRead * p.cacheRead + cacheWrite * p.in * CACHE_WRITE_FACTOR) / 1_000_000
  );
}

// يسجّل حدث استخدام من ردّ Claude الخام (raw.usage) — يُستدعى دون كسر التدفّق
export async function logUsage(
  env: Env,
  opts: {
    userId?: string | null;
    kind: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    /** رموزٌ قُرئت من التخزين المؤقّت — خارج `inputTokens` في عدّاد الـAPI. */
    cacheReadTokens?: number;
    /** رموزٌ كُتبت في التخزين المؤقّت — خارج `inputTokens` كذلك. */
    cacheWriteTokens?: number;
    consultationType?: string | null;
  }
): Promise<void> {
  const inTok = opts.inputTokens ?? 0;
  const outTok = opts.outputTokens ?? 0;
  const cacheRead = opts.cacheReadTokens ?? 0;
  const cacheWrite = opts.cacheWriteTokens ?? 0;
  const cost = computeCost(opts.model, inTok, outTok, cacheRead, cacheWrite);
  try {
    await env.DB.prepare(
      `INSERT INTO usage_events (id, user_id, kind, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                                 cost_usd, consultation_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(uuid(), opts.userId ?? null, opts.kind, opts.model, inTok, outTok, cacheRead, cacheWrite, cost,
        opts.consultationType ?? null, Date.now())
      .run();
  } catch {
    // لا نُفشل الطلب بسبب فشل تسجيل التحليلات
  }
}

export function usageFromRaw(raw: any): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  const u = raw?.usage ?? {};
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}
