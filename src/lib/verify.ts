// طبقة التحقّق بعد التوليد + الاقتباس المُتحقَّق منه — §2 موثوقية، §1 جوهر
import { callClaude } from './claude';
import { logUsage, usageFromRaw } from './usage';
import { normalizeArabic, normalizeArticleNo } from './arabic';
import { formatRagContext, type RagResult } from './rag';
import { knownLaws } from './research/links';
import type { Env } from '../types';

/** سقفُ ما يُقرأ من المخرَج — مذكرةٌ طويلة لا تبلغه. */
const MAX_OUTPUT_CHARS = 200_000;

export interface VerifyResult {
  verified: boolean;
  unsupported: string[]; // مواد ذُكرت دون سند في السياق
  note: string;
}

/** إشارةُ مادةٍ في المخرَج: رقمُها، ونظامُها إن ذُكر بعدها، ونصُّها كما يُعرض. */
export interface CitedMention {
  article: string;
  law: string | null;
  label: string;
}

/**
 * الموادّ المذكورة في المخرَج بأنظمتها — «المادة (77) من نظام العمل».
 *
 * على النصّ كما كُتب لا المطبَّع: التسمية تُعرض للمحامي بإملائها. والمقارنة بعدها
 * مطبَّعة. ورقمٌ بلا نظامٍ بعده يُذكر بلا نظام، ويُطابق أيَّ مادةٍ مسترجعة برقمه.
 */
/** ألفاظٌ لا تقع في عنوان نظام — عندها ينتهي اسمٌ لم يُعرف في القاعدة. */
const NOT_IN_TITLE = new Set(
  ['على', 'يجب', 'التي', 'الذي', 'فإن', 'إذا', 'وفق', 'في', 'من', 'عن', 'إلى', 'الى', 'بأن', 'أن', 'لا', 'ما', 'حيث', 'كما', 'وهو', 'وهي'].map(
    (w) => normalizeArabic(w)
  )
);

/**
 * اسمُ النظام كما يُعرض: العنوانُ الرسميّ إن بدأ به المكتوب، وإلا المكتوبُ إلى أوّل
 * لفظٍ لا يقع في عنوان («نظام العمل يستحق…» ← «نظام العمل»).
 */
function lawLabel(raw: string, titles: { title: string; titleNorm: string }[]): string {
  const n = normalizeArabic(raw);
  const hit = titles
    .filter((t) => n === t.titleNorm || n.startsWith(`${t.titleNorm} `))
    .sort((a, b) => b.titleNorm.length - a.titleNorm.length)[0];
  if (hit) return hit.title;
  const words = raw.split(/\s+/);
  const end = words.findIndex((w, i) => i > 1 && (NOT_IN_TITLE.has(normalizeArabic(w)) || /^ي\S{3,}/.test(w)));
  return (end === -1 ? words : words.slice(0, end)).join(' ').replace(/[…]+$/, '');
}

export function citedMentions(text: string, titles: { title: string; titleNorm: string }[] = []): CitedMention[] {
  const out = new Map<string, CitedMention>();
  const re =
    /(?:المادة|مادة|للمادة|بالمادة)\s*\(?\s*([\d٠-٩]{1,4})\s*\)?(?:\s*(?:من|في)\s+((?:اللائحة التنفيذية ل)?نظام(?:\s+[^\s،.؛:\n()«»]+){1,6}))?/g;
  for (const m of text.matchAll(re)) {
    const article = normalizeArticleNo(m[1]) ?? m[1];
    const law = m[2] ? lawLabel(m[2].trim(), titles) : null;
    const label = law ? `${law} — المادة ${article}` : `المادة ${article}`;
    const key = `${law ? normalizeArabic(law) : ''}|${article}`;
    if (!out.has(key)) out.set(key, { article, law, label });
  }
  return [...out.values()];
}

/** هل في المسترجَع مادةٌ تطابق الإشارة — رقماً، ونظاماً إن ذُكر؟ */
function supported(m: CitedMention, results: RagResult[]): boolean {
  const law = m.law ? normalizeArabic(m.law) : null;
  return results.some((r) => {
    if (r.source !== 'legal' || !r.articleNo || normalizeArticleNo(r.articleNo) !== m.article) return false;
    if (!law) return true;
    const title = normalizeArabic(r.title);
    // «نظام العمل على أن…» تبدأ بعنوان النظام ثم تمضي في الجملة.
    return law === title || law.startsWith(`${title} `);
  });
}

/**
 * يتحقّق أن كل مادة مذكورة مسنودة في المسترجَع — بنيوياً أولاً ثم بنموذج.
 *
 * البنيويّ: كل «المادة X من نظام Y» في المخرَج يجب أن تكون مادةً مسترجَعة بعينها،
 * على النصّ كلِّه لا على أوّله. **وإن لم يُسترجَع شيء وذكر المخرَج موادّ فكلُّها بلا
 * سند** — وكانت هذه الحالُ، أخطرُ الحالات، تمرّ بلا شارة. والنموذجُ بعده يحكم على
 * الموادّ المسنودة رقماً: هل نصُّها يحمل ما نُسب إليها؟ ويقرأ نصوصها وحدها لا السياق كلّه.
 */
export async function verifyGrounding(
  env: Env,
  userId: string | null,
  generated: string,
  results: RagResult[],
  consultationType: string
): Promise<VerifyResult | null> {
  const mentions = citedMentions(generated, await knownLaws(env).catch(() => []));
  if (!mentions.length) return null;
  const structural = mentions.filter((m) => !supported(m, results)).map((m) => m.label);
  const backed = results.filter(
    (r) => r.source === 'legal' && mentions.some((m) => r.articleNo && normalizeArticleNo(r.articleNo) === m.article)
  );
  if (!backed.length) {
    return { verified: structural.length === 0, unsupported: structural, note: 'structural' };
  }
  const ragContext = formatRagContext(backed);

  const system = `أنت مدقّق إسناد قانوني. لديك «السياق النظامي» المسترجَع من مصادر رسمية، و«المخرَج» المولَّد.
مهمّتك: التأكّد أن كل مادة نظامية ذُكرت في المخرَج لها سند فعلي في السياق، وأن ما نُسب إليها يحمله نصُّها.
أعِد JSON فقط:
{
  "unsupported": [ "اسم النظام — المادة X التي ذُكرت دون سند في السياق أو نُسب إليها ما لا يحمله نصّها" ],
  "note": "ملاحظة موجزة"
}
إن كانت كل المواد مسنودة أعِد unsupported = [].`;

  try {
    const { text, raw } = await callClaude(env, {
      model: env.ANALYSIS_MODEL,
      system,
      messages: [
        // السياقُ موادُّ المخرَج وحدها، والمخرَجُ كاملاً — كان كلاهما يُقصّ عند اثني عشر
        // ألف حرف، فتمرّ موادُّ آخر المذكرة بلا فحص وتُحسب «مسنودة».
        { role: 'user', content: `السياق النظامي:\n${ragContext}\n\n---\n\nالمخرَج:\n${generated.slice(0, MAX_OUTPUT_CHARS)}` },
      ],
      // حكمٌ على سند المواد لا نقلٌ لها، فلا يُنزَل به إلى `low`.
      effort: 'medium',
      max_tokens: 4096,
    });
    const u = usageFromRaw(raw);
    await logUsage(env, { userId, kind: 'verify', model: env.ANALYSIS_MODEL, ...u, consultationType });

    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : { unsupported: [], note: '' };
    const judged: string[] = Array.isArray(parsed.unsupported) ? parsed.unsupported : [];
    const unsupported = [...new Set([...structural, ...judged])];
    return {
      verified: unsupported.length === 0,
      unsupported,
      note: parsed.note ?? '',
    };
  } catch (e) {
    // التحقّق لا يُفشل التوليد، لكن صمتَه يخفي انقطاعاً في Claude يطال
    // المنصة كلها — فيُسجَّل السبب ويتابع الردّ بلا شارة تحقّق.
    console.error('verify failed:', e instanceof Error ? e.message : e);
    // والبنيويُّ لا يحتاج نموذجاً: يبقى حكمُه وإن تعذّر الثاني.
    return { verified: structural.length === 0, unsupported: structural, note: 'structural' };
  }
}
