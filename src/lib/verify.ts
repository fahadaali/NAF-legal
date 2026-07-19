// طبقة التحقّق بعد التوليد + الاقتباس المُتحقَّق منه — §2 موثوقية، §1 جوهر
import { callClaude } from './claude';
import { logUsage, usageFromRaw } from './usage';
import type { Env } from '../types';

export interface VerifyResult {
  verified: boolean;
  unsupported: string[]; // مواد ذُكرت دون سند في السياق
  note: string;
}

// يستخرج إشارات المواد المذكورة في نصّ المخرَج
export function extractCitedArticles(text: string): string[] {
  const set = new Set<string>();
  const re = /(?:المادة|مادة)\s+([\(]?\s*[\d٠-٩]+\s*[\)]?)/g;
  let m;
  while ((m = re.exec(text))) set.add(`المادة ${m[1].replace(/[()\s]/g, '')}`);
  return Array.from(set);
}

// يتحقّق أن كل مادة مذكورة مسنودة في السياق المسترجَع.
// إن لم يوجد سياق (قاعدة معرفة غير مهيّأة) نتجاوز التحقّق بلا إفشال.
export async function verifyGrounding(
  env: Env,
  userId: string | null,
  generated: string,
  ragContext: string,
  consultationType: string
): Promise<VerifyResult | null> {
  const cited = extractCitedArticles(generated);
  if (!ragContext.trim() || cited.length === 0) return null;

  const system = `أنت مدقّق إسناد قانوني. لديك «السياق النظامي» المسترجَع من مصادر رسمية، و«المخرَج» المولَّد.
مهمّتك: التأكّد أن كل مادة نظامية ذُكرت في المخرَج لها سند فعلي في السياق (نصًّا أو رقمًا).
أعِد JSON فقط:
{
  "unsupported": [ "المادة X التي ذُكرت دون سند في السياق" ],
  "note": "ملاحظة موجزة"
}
إن كانت كل المواد مسنودة أعِد unsupported = [].`;

  try {
    const { text, raw } = await callClaude(env, {
      model: env.PLANNER_MODEL,
      system,
      messages: [
        { role: 'user', content: `السياق النظامي:\n${ragContext.slice(0, 12000)}\n\n---\n\nالمخرَج:\n${generated.slice(0, 12000)}` },
      ],
      max_tokens: 800,
      temperature: 0,
    });
    const u = usageFromRaw(raw);
    await logUsage(env, { userId, kind: 'verify', model: env.PLANNER_MODEL, ...u, consultationType });

    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : { unsupported: [], note: '' };
    const unsupported: string[] = Array.isArray(parsed.unsupported) ? parsed.unsupported : [];
    return {
      verified: unsupported.length === 0,
      unsupported,
      note: parsed.note ?? '',
    };
  } catch {
    return null;
  }
}
