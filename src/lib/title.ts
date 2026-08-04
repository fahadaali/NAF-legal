/**
 * عنوان المحادثة — يُصاغ من موضوعها، لا من نوع الخدمة.
 *
 * كان العنوان أوّلَ ستّين حرفاً من رسالة البدء، ورسالةُ البدء تبدأ دائماً
 * بترويسة النموذج: «أرجو إنجاز المطلوب (استشارة قانونية) بناءً على البيانات
 * التالية:». فكل استشارةٍ قانونية تحمل العنوان نفسه، وكل صحيفة دعوى تحمل
 * عنوانها، ولا يُميَّز في القائمة بين محادثةٍ وأخرى إلا بالوقت.
 */
import { callClaude } from './claude';
import { logUsage, usageFromRaw } from './usage';
import type { Env } from '../types';

/** العنوان الافتراضي عند الإنشاء — مسجَّل في `naf-terms.md`. */
export const DEFAULT_TITLE = 'محادثة جديدة';

/** ترويسة رسالة البدء التي يبنيها نموذج الإدخال في الواجهة. */
const INTAKE_PREFIX = 'أرجو إنجاز المطلوب';

/** حدُّ العنوان: يُعرَض في شريطٍ ضيّق، وما زاد يُقصّ في الشاشة لا في القاعدة. */
const MAX_TITLE = 60;

const TITLE_SYSTEM = `أنت تصوغ عنواناً لمحادثة في منصّة استشارات قانونية سعودية.

القواعد:
- العنوان يصف **موضوع** المسألة لا نوع الخدمة: «فصل تعسفي ومستحقات نهاية الخدمة» لا «استشارة قانونية».
- من ثلاث إلى سبع كلمات، ولا يتجاوز ٦٠ حرفاً.
- بالعربية الفصحى، بلا علامات اقتباس، وبلا نقطة أو نقطتين في آخره.
- الأرقام بالخانات الغربية (2024 لا ٢٠٢٤).
- لا تكتب شيئاً غير العنوان: لا مقدّمة ولا شرح ولا خيارات.`;

/**
 * هل تحتاج هذه المحادثة عنواناً مولَّداً؟
 *
 * الافتراضي يحتاجه، والعناوين القديمة المشتقّة من ترويسة النموذج تحتاجه —
 * فتُصلَح عند أول رسالة تالية. أما عنوانٌ سمّاه صاحبه بيده فلا يُمسّ.
 */
export function needsGeneratedTitle(title: string | null | undefined): boolean {
  const t = (title ?? '').trim();
  return !t || t === DEFAULT_TITLE || t.startsWith(INTAKE_PREFIX);
}

/**
 * عنوانٌ من موضوع المحادثة. لا يرمي أبداً: عنوانٌ احتياطيّ خيرٌ من دورٍ يسقط.
 */
export async function generateTitle(
  env: Env,
  opts: { question: string; answer?: string; userId?: string | null; consultationType?: string | null }
): Promise<string> {
  const fallback = fallbackTitle(opts.question);
  const body = [
    `رسالة المستخدم:\n${opts.question.slice(0, 1500)}`,
    opts.answer?.trim() ? `مطلع الرد:\n${opts.answer.slice(0, 800)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const { text, raw } = await callClaude(env, {
      model: env.PLANNER_MODEL,
      system: TITLE_SYSTEM,
      messages: [{ role: 'user', content: body }],
      // تسميةٌ لا اجتهاد، وهي على مسار أول دور في كل محادثة.
      effort: 'low',
      max_tokens: 4096,
    });
    await logUsage(env, {
      userId: opts.userId,
      kind: 'title',
      model: env.PLANNER_MODEL,
      ...usageFromRaw(raw),
      consultationType: opts.consultationType ?? null,
    });
    return sanitize(text) || fallback;
  } catch (e) {
    // العنوان تفصيلٌ لا يُسقط ردّاً اكتمل، لكن صمتَه يخفي انقطاعاً في Claude.
    console.error('title generation failed:', e instanceof Error ? e.message : e);
    return fallback;
  }
}

/**
 * عنوانٌ احتياطيّ من الرسالة نفسها.
 *
 * تُطرح ترويسة النموذج وأسطرُ العناوين («السؤال:») — وهي ما كان يملأ العنوان
 * القديم — ويُؤخذ أوّل سطرٍ يحمل معنى.
 */
export function fallbackTitle(message: string): string {
  const lines = (message ?? '')
    .split('\n')
    .map((l) => l.replace(/\*\*/g, '').replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith(INTAKE_PREFIX))
    // سطرُ عنوانِ حقلٍ وحده لا يصلح عنواناً للمحادثة
    .filter((l) => !/^[^:]{1,30}:$/.test(l));
  return clip(lines[0] ?? DEFAULT_TITLE);
}

/** يستخرج العنوان من رد النموذج: أوّل سطر، بلا زخرفة ولا ترقيم في طرفيه. */
function sanitize(text: string): string {
  const line = (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return '';
  const stripped = line
    .replace(/^[«"'*#\s]+/, '')
    // «العنوان: …» — النموذج يسبق العنوان بلافتته أحياناً رغم التوجيه
    .replace(/^(العنوان|عنوان المحادثة|Title)\s*[:،-]\s*/i, '')
    .replace(/[»"'*\s]+$/, '')
    .replace(/[.:،؛]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clip(stripped);
}

/** يقصّ عند حدّ الكلمات لا في وسط كلمة. */
function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= MAX_TITLE) return one;
  const cut = one.slice(0, MAX_TITLE);
  const space = cut.lastIndexOf(' ');
  return (space > 20 ? cut.slice(0, space) : cut).trim();
}
