// كشف الأنظمة الغائبة عن قاعدة المعرفة — §6: لا إسناد بلا مصدر.
//
// المُخطِّط يُسمّي الأنظمة التي تتوقّف عليها المسألة، وهذه الوحدة تجيب سؤالاً
// واحداً: أيُّها لا تعرفه المنصة؟ وما لا تعرفه يُعرض على المستخدم ليطلب
// إضافته.
//
// وخطأ هذا الكشف في اتجاهٍ أسوأ من الآخر. أن نقول «موجود» عن غائب يعني
// إسناداً بلا مصدر يكشفه المستخدم في السطر التالي. أما أن نقول «غير موجود»
// عن موجود — وهو ما كان يقع — فيطلب من المحامي إضافة نظام العمل وهو في
// القاعدة أمامه، فيفقد ثقته بالتنبيه كلِّه ويتجاهله حين يصدق. لذلك تميل
// المطابقة هنا إلى «موجود» عند الشكّ.

import { normalizeArabic } from './arabic';
import type { Env } from '../types';

/** أكثر ما يُعرض على المستخدم في ردٍّ واحد. */
export const MISSING_REGULATIONS_MAX = 3;

/** أقصر اسمٍ يُعتدّ به. ما دونه يطابق كل شيء فلا يميّز شيئاً. */
const MIN_NAME_LENGTH = 4;

/** سقفُ ما يُقرأ من العناوين — حارسٌ لا حدٌّ متوقَّع بلوغه. */
const TITLE_SCAN_LIMIT = 2000;

/**
 * مصدرا المعرفة النظامية، وكلاهما يُسأل.
 *
 * `kb_documents` وثائق تُرفَع فتُقطَّع، و`legal_chunks` مقاطع تُستورَد مقطوعة
 * سلفاً. وهما جدولان مستقلّان لا واجهة بينهما.
 *
 * **وقصرُ السؤال على الأول كان السبب الأول للتنبيه الكاذب:** كل نظام دخل
 * المنصة عبر الاستيراد النظامي — وهو المسار المقصود للأنظمة — كان يُبلَّغ
 * عنه «غير موجود» مهما تطابق اسمه، لأن الاستعلام لا يمرّ على جدوله أصلاً.
 *
 * وعناوين الأنظمة تُقرأ بالتجميع على `law_id` لا بـ`DISTINCT law_title`:
 * الأول يمرّ على `idx_legal_law` والثاني يمسح الجدول كلَّه في كل دور محادثة.
 * ويُشترط أن يبقى للنظام مقطعٌ ساري: نظامٌ نُسخت كل مواده ليس مرجعاً يُسنَد
 * إليه، وطلبُ إضافته المحدَّث في محلّه.
 */
async function knownTitles(env: Env): Promise<string[]> {
  const titles: string[] = [];

  try {
    const docs = await env.DB.prepare(
      `SELECT title FROM kb_documents
       WHERE status != 'repealed' AND title IS NOT NULL
       LIMIT ?`
    )
      .bind(TITLE_SCAN_LIMIT)
      .all<{ title: string }>();
    for (const r of docs.results ?? []) titles.push(r.title);
  } catch (e: any) {
    console.error('kb_documents title scan failed:', e?.message ?? e);
  }

  try {
    const laws = await env.DB.prepare(
      `SELECT MAX(law_title) AS law_title
       FROM legal_chunks
       WHERE law_id IS NOT NULL AND law_title IS NOT NULL
       GROUP BY law_id
       HAVING SUM(CASE WHEN is_repealed = 0 AND status IN ('active','amended') THEN 1 ELSE 0 END) > 0
       LIMIT ?`
    )
      .bind(TITLE_SCAN_LIMIT)
      .all<{ law_title: string }>();
    for (const r of laws.results ?? []) titles.push(r.law_title);
  } catch (e: any) {
    // جدول غير مهيّأ بعد (هجرة لم تُطبَّق) — نتابع بالوثائق وحدها.
    console.error('legal_chunks title scan failed:', e?.message ?? e);
  }

  return titles;
}

/**
 * هل يدلّ الاسمان على شيء واحد؟
 *
 * المطابقة على النصّ **المطبَّع** في الاتجاهين. والتطبيع ليس ترفاً: العنوان
 * الرسمي مشكولٌ منقوط، والمُخطِّط يكتب بلا همزات ولا تشكيل، فـ«نظام العمل»
 * لا يساوي «نِظَام العَمَل» حرفياً ولا يطابقه `instr`. وهذا كان السبب
 * الثاني — و`lower()` في SQLite لا يمسّ العربية أصلاً فلم يكن يصنع شيئاً.
 *
 * والاتجاهان لازمان: العنوان قد يطول عن الاسم المرشَّح («نظام العمل السعودي»
 * مقابل «نظام العمل») وقد يقصر عنه («نظام العمل» مقابل «اللائحة التنفيذية
 * لنظام العمل»). والاحتواء النصّي لا مطابقة الكلمات: العربية تلصق حروف
 * الجرّ بما بعدها، فـ«لنظام» كلمةٌ أخرى غير «نظام» وهي هي.
 */
function refersToSame(a: string, b: string): boolean {
  if (a.length < MIN_NAME_LENGTH || b.length < MIN_NAME_LENGTH) return false;
  return a.includes(b) || b.includes(a);
}

/**
 * هل يدلّ الاسمان الخامان على نظام واحد؟ — للمقارنة خارج هذه الوحدة.
 *
 * يُطبِّع طرفَيه ثم يقارن. وتطبيق التطبيع على طرف واحد أسوأ من تركه.
 */
export function sameRegulationName(a: string, b: string): boolean {
  return refersToSame(normalizeArabic(a ?? ''), normalizeArabic(b ?? ''));
}

/**
 * الأنظمة التي سمّاها المُخطِّط ولا تعرفها المنصة.
 *
 * والعناوين تُقرأ مرّة واحدة لا مرّة لكل اسم: الأسماء ثلاثة على الأكثر
 * والعناوين مئات، فالمقارنة في الذاكرة أرخص من استعلامٍ لكل اسم.
 */
export async function findMissingRegulations(env: Env, names: string[], userId: string): Promise<string[]> {
  const candidates = (names ?? [])
    .map((raw) => (raw ?? '').trim().replace(/\s+/g, ' '))
    .filter((name) => name.length >= MIN_NAME_LENGTH && name.length <= 200);
  if (!candidates.length) return [];

  const known = (await knownTitles(env)).map(normalizeArabic).filter((t) => t.length >= MIN_NAME_LENGTH);

  // الطلبات القائمة لهذا المستخدم: لا يُزعَج بطلب نظامٍ طلبه سابقاً. وتُطبَّع
  // هي الأخرى — المطابقة الحرفية كانت تعيد عليه الطلب نفسه بصيغة أخرى.
  let requested: string[] = [];
  try {
    const rows = await env.DB.prepare(
      `SELECT name FROM regulation_requests
       WHERE user_id = ? AND status != 'rejected'
       LIMIT ?`
    )
      .bind(userId, TITLE_SCAN_LIMIT)
      .all<{ name: string }>();
    requested = (rows.results ?? []).map((r) => normalizeArabic(r.name)).filter(Boolean);
  } catch (e: any) {
    console.error('regulation_requests scan failed:', e?.message ?? e);
  }

  const missing: string[] = [];
  const seen = new Set<string>();
  for (const name of candidates) {
    if (missing.length >= MISSING_REGULATIONS_MAX) break;
    const key = normalizeArabic(name);
    if (key.length < MIN_NAME_LENGTH || seen.has(key)) continue;
    seen.add(key);

    if (known.some((title) => refersToSame(key, title))) continue;
    if (requested.some((asked) => refersToSame(key, asked))) continue;
    missing.push(name);
  }
  return missing;
}
