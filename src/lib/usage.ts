// تتبّع الاستخدام والتكلفة — §4 (لوحة التحليلات)
import { uuid } from './crypto';
import type { Env } from '../types';

// تسعير تقريبي بالدولار لكل مليون رمز (input/output). يُحدَّث حسب أسعار Anthropic.
const PRICING: Record<string, { in: number; out: number }> = {
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-haiku-4-5-20251001': { in: 0.8, out: 4 },
};

function priceFor(model: string): { in: number; out: number } {
  if (PRICING[model]) return PRICING[model];
  if (model.includes('opus')) return PRICING['claude-opus-4-8'];
  if (model.includes('haiku')) return PRICING['claude-haiku-4-5-20251001'];
  return PRICING['claude-sonnet-5'];
}

export function computeCost(model: string, inTok: number, outTok: number): number {
  const p = priceFor(model);
  return (inTok / 1_000_000) * p.in + (outTok / 1_000_000) * p.out;
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
    consultationType?: string | null;
  }
): Promise<void> {
  const inTok = opts.inputTokens ?? 0;
  const outTok = opts.outputTokens ?? 0;
  const cost = computeCost(opts.model, inTok, outTok);
  try {
    await env.DB.prepare(
      `INSERT INTO usage_events (id, user_id, kind, model, input_tokens, output_tokens, cost_usd, consultation_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(uuid(), opts.userId ?? null, opts.kind, opts.model, inTok, outTok, cost, opts.consultationType ?? null, Date.now())
      .run();
  } catch {
    // لا نُفشل الطلب بسبب فشل تسجيل التحليلات
  }
}

export function usageFromRaw(raw: any): { inputTokens: number; outputTokens: number } {
  const u = raw?.usage ?? {};
  return { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 };
}
