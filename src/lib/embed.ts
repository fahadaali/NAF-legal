// توليد التضمينات عبر Workers AI — §6
//
// مستقلٌّ عن `rag.ts` لأن طبقتَي الاسترجاع (وثائق مرفوعة ومقاطع مستوردة)
// كلتاهما تحتاجه، ووضعه في إحداهما يجعل الأخرى تستوردها فتدور الاستيرادات.
//
// **وعقد النموذج اتحادُ أشكال لا شكلٌ واحد.** `@cf/baai/bge-m3` يردّ — بحسب
// ما يُرسَل إليه وبحسب حاله — أربعة أشكال مختلفة: `{data}` للتضمين، و
// `{response}` للسياقات، و`{response}` آخر للترتيب، و`{request_id}` حين
// يمرّ الطلب على طابور غير متزامن. وقراءةُ `res.data` وحدها تُرجع `undefined`
// في ثلاثة منها بلا خطأ — ومن هناك يمضي `undefined` إلى الفهرس.
//
// فكلُّ ما يخرج من هنا **متحقَّقٌ منه أو رميةُ خطأ**. لا شيء بينهما.
import type { Env } from '../types';

/**
 * أبعاد المتجه.
 *
 * ليست رقماً اختير هنا: الفهرسان يُنشآن في `.github/workflows/deploy.yml`
 * بـ`--dimensions=1024`، و`bge-m3` يُخرج ألفاً وأربعة وعشرين. والقيمتان
 * يجب أن تتطابقا — فمتجهٌ بطولٍ آخر يرفضه الفهرس، ورفضُه يقع بعد أن يكون
 * الصفّ قد وُسم مضمَّناً.
 *
 * ولذلك يُفحص الطول هنا لا هناك: تغييرُ `EMBEDDING_MODEL` في `[vars]` إلى
 * نموذجٍ بأبعادٍ أخرى يجب أن يفشل عند أوّل نداء برسالةٍ تقول ما وقع، لا أن
 * يمضي صامتاً حتى يُكتشف بعد آلاف المقاطع.
 */
export const EMBED_DIM = 1024;

/**
 * خطأُ تضمينٍ يُميَّز عن غيره.
 *
 * `retryable` هو الفرق الذي يبني عليه المستدعي قراره: عطلٌ عابر — حدُّ معدّل،
 * أو خمسمئة من الخدمة — يُعاد بعده، وعطلٌ في العقد نفسه لا يُصلحه التكرار.
 */
export class EmbedError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'EmbedError';
  }
}

/** محاولاتٌ للنداء الواحد قبل التسليم بفشله. */
const MAX_ATTEMPTS = 3;

/** تأخيرٌ متضاعف بين المحاولات. الأولى فورية. */
const BACKOFF_MS = [0, 400, 1200];

/**
 * أيُّ خطأٍ يستحقّ إعادة المحاولة.
 *
 * Workers AI يردّ ٤٢٩ عند بلوغ حدّ المعدّل و٥xx عند ازدحامه، وكلاهما يزول
 * بالانتظار. وما عداهما — نموذجٌ لا وجود له، مدخلٌ مرفوض — يتكرّر بتكرار
 * النداء، فإعادتُه إنفاقُ حصّةٍ على الفشل نفسه ثلاث مرّات.
 */
function isTransient(e: unknown): boolean {
  const s = String((e as any)?.message ?? e);
  return /429|too many requests|rate limit|5\d\d|timeout|capacity|overload|unavailable/i.test(s);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * ينادي النموذج ويتحقّق من ردّه.
 *
 * `truncate_inputs` مضبوطٌ عمداً: العقد يقول إن النموذج — بلا هذه الخانة —
 * **يرمي خطأً** على أوّل نصٍّ يتجاوز سياقه. ودفعةٌ من عشرين نصّاً فيها واحدٌ
 * طويل تسقط كلُّها، فيبقى تسعة عشر نصّاً سليماً بلا تضمين لأجل واحد. والقصّ
 * يمسّ **مدخل المتجه وحده** — النصّ المخزَّن والمعروض يبقى كاملاً.
 */
async function runOnce(env: Env, texts: string[]): Promise<number[][]> {
  const res: any = await env.AI.run(env.EMBEDDING_MODEL as any, {
    text: texts,
    truncate_inputs: true,
  });

  // الشكل غير المتزامن: النموذج قبِل الطلب وأحاله على طابور، والمتجهات
  // تُطلب لاحقاً بـ`request_id`. لا نتعامل مع هذا المسار، لكنّه يُقال صراحةً:
  // `res.data` فيه `undefined`، وصمتُنا عنه يجعل المتجه الغائب يبدو متجهاً.
  if (res?.request_id && !res?.data) {
    throw new EmbedError('ردّ نموذج التضمين غير متزامن — لا متجهات في الردّ', true);
  }

  const data = res?.data;
  if (!Array.isArray(data)) {
    throw new EmbedError('ردّ نموذج التضمين بلا حقل `data`', false);
  }
  // عددُ المتجهات يطابق عدد النصوص أو لا شيء: المستدعي يقابل `vectors[j]`
  // بـ`slice[j]`، فنقصانُ واحدٍ يُزيح المطابقة كلَّها ويُسند إلى كل مقطعٍ
  // متجهَ غيره — وهو أسوأ من الغياب لأنه يُسترجَع ويبدو صحيحاً.
  if (data.length !== texts.length) {
    throw new EmbedError(
      `عدد المتجهات (${data.length}) لا يطابق عدد النصوص (${texts.length})`,
      false
    );
  }
  for (const vec of data) {
    if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
      throw new EmbedError(
        `طول المتجه ${Array.isArray(vec) ? vec.length : 'غير معروف'} والفهرس يقبل ${EMBED_DIM}`,
        false
      );
    }
    // `NaN` يمرّ من الفهرس ويُفسد حساب التقارب بلا خطأ ظاهر.
    if (!vec.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new EmbedError('المتجه يحوي قيمة غير عددية', false);
    }
  }
  return data as number[][];
}

/**
 * ينادي النموذج مع إعادة المحاولة على العابر.
 *
 * الحلقة هنا لا عند المستدعي: التضمين يقع في ثلاثة مواضع — الاستيراد،
 * ورفع الوثيقة، والاستعلام — وتركُ الإعادة لكلٍّ منها يجعل ثلاث سياساتٍ
 * تفترق أوّل تعديل.
 */
async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  let last: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (BACKOFF_MS[attempt]) await sleep(BACKOFF_MS[attempt]);
    try {
      return await runOnce(env, texts);
    } catch (e) {
      last = e;
      const retryable = e instanceof EmbedError ? e.retryable : isTransient(e);
      if (!retryable) throw e;
    }
  }
  throw last instanceof Error
    ? last
    : new EmbedError(String(last ?? 'تعذّر توليد التضمين'), true);
}

/** تضمين نصّ واحد — للاستعلام ولفهرسة رسالة. */
export async function embed(env: Env, text: string): Promise<number[]> {
  const [vec] = await embedTexts(env, [text]);
  return vec;
}

/**
 * تضمين دفعة.
 *
 * يردّ متجهاً لكل نصّ أو يرمي. ولا يردّ دفعةً ناقصة: المستدعي يوسم الصفوف
 * مضمَّنةً بعد نجاح الدفعة، ونقصانٌ صامت فيها يوسم ما لم يُضمَّن.
 */
export async function embedBatch(env: Env, texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  return await embedTexts(env, texts);
}
