/**
 * الترتيب الدلاليّ — من أين تأتي الدلالة في نتائج مصدرٍ لا نملك فهرسه.
 *
 * خوادم الكتب تبحث لفظياً أو صرفياً: تراث ردّ سبعةَ عشرَ ألفَ نتيجةٍ على
 * استعلامٍ واحد، والشاملة تطابق الاشتقاق لا المعنى. فأوّلُ ما يردّانه أوّلُ ما
 * طابق لفظاً، لا أقربُ ما يجيب السؤال.
 *
 * ولا سبيل إلى بحثٍ متجهيّ في فهرسٍ عند غيرنا. فالدلالة تقع **بعد**
 * الاسترجاع: يُضمَّن ما رجع ويُرتَّب بجيب التمام — وهو ما يسمّيه أهل الصنعة
 * إعادةَ ترتيب. المصدر يوسّع، ونحن نضيّق.
 *
 * **ولا يحتاج Vectorize.** التضمين من Workers AI مباشرةً وجيبُ التمام يُحسب
 * هنا — فيعمل والفهرس المتجهي معطَّلٌ، وهو معطَّلٌ افتراضياً في `wrangler.toml`.
 *
 * وفشلُه لا يُسقط شيئاً: يبقى ترتيب المصدر كما ردّه. نتائجُ مرتَّبةٌ لفظياً
 * أنفعُ من لا نتائج.
 */
import { embed, embedBatch } from './embed';
import type { ExternalHit } from './external';
import type { Env } from '../types';

/** سقفُ ما يُضمَّن من مقطعٍ واحد — التضمين يقتطع ما زاد على أي حال. */
const EMBED_CHARS = 2000;

/** دفعةُ `embedBatch` — هي دفعةُ `lib/legal.ts` نفسها. */
const BATCH = 10;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  // متجهٌ صفريّ: لا اتجاه له فلا تشابه — وقسمةٌ على صفرٍ تُخرج NaN يُفسد الترتيب.
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * يعيد ترتيب المقاطع بقربها من معنى الاستعلام، ويكتب الدرجة في `score`.
 *
 * ويردّ ما أخذ كما هو عند أي تعذّر — فالمنادي لا يحتاج فرعاً للفشل.
 */
export async function rerankByMeaning<T extends ExternalHit>(
  env: Env,
  query: string,
  hits: T[]
): Promise<T[]> {
  if (hits.length < 2 || !query.trim()) return hits;

  try {
    const queryVector = await embed(env, query);

    const texts = hits.map((h) => `${h.title} ${h.text}`.slice(0, EMBED_CHARS));
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      vectors.push(...(await embedBatch(env, texts.slice(i, i + BATCH))));
    }
    /* `embedBatch` كلٌّ أو رمي، لكن الحرس هنا لأن الاقتران موضعيّ:
       `vectors[i]` لـ`hits[i]`. وانزلاقٌ بواحد يعطي كلَّ مقطعٍ درجةَ جاره —
       وهو أسوأ من الغياب لأنه يُرتِّب ويبدو صحيحاً. */
    if (vectors.length !== hits.length) {
      console.error(`rerank: ${vectors.length} vectors for ${hits.length} hits — ترتيب المصدر يبقى`);
      return hits;
    }

    return hits
      .map((h, i) => ({ ...h, score: cosine(queryVector, vectors[i]) }))
      .sort((a, b) => b.score - a.score);
  } catch (e) {
    console.error(`rerank failed, keeping source order: ${e instanceof Error ? e.message : e}`);
    return hits;
  }
}
