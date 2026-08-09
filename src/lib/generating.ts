/**
 * علامةُ «دورٌ يجري الآن» — لمحادثةٍ يعمل النموذج فيها.
 *
 * التوليد صار يجري في الخلفية: من غادر المحادثة أو أغلق التبويب لا يُطفئه،
 * والردّ يُحفظ على أي حال (`routes/chat.ts`). لكن من عاد بعد إعادة تحميل
 * الصفحة يفقد البثّ — الاتصال الذي كان يحمله انقطع مع الصفحة — فيرى محادثةً
 * ساكنةً بلا ردّ ولا أثرِ عمل، فيعيد السؤال. وهذه العلامة هي ما يقول له إن
 * ثمّة دوراً يجري، فينتظره بدل أن يستأنفه.
 *
 * وهي في KV لا في D1: حالٌ تعيش دقائق ثم تذهب، وكتابتها في جدولٍ يُقرأ مع كل
 * فتحة محادثة ثمنٌ دائم لحالٍ عابرة. والبقاءُ محدود بمهلةٍ فلا تعلق العلامة
 * أبداً: وقتُ التشغيل قد يُقتل قبل أن تُمسح — انقطاعُ خدمةٍ أو تجاوزُ حدّ —
 * وعلامةٌ لا تنتهي تترك دوّارةَ انتظارٍ لا تتوقّف على محادثةٍ لا يجري فيها شيء.
 */
import type { Env } from '../types';

/**
 * عمر العلامة بالثواني.
 *
 * أطول من أطول دور محتمل (توليدٌ بجهدٍ عالٍ إلى ٦٤ ألف رمز، ثم محاولةٌ
 * ثانية، ثم تحقّقُ إسنادٍ وعنوان)، وأقصر من صبر أحد على دوّارة.
 */
const TTL = 600;

const key = (conversationId: string) => `gen:${conversationId}`;

/** يرفع العلامة عند بدء الدور. لا يرمي: علامةٌ لم تُكتب لا تُسقط توليداً. */
export async function markGenerating(env: Env, conversationId: string): Promise<void> {
  try {
    await env.KV.put(key(conversationId), String(Date.now()), { expirationTtl: TTL });
  } catch (e: any) {
    console.error('mark generating failed:', e?.message ?? e);
  }
}

/** يُنزل العلامة عند انتهاء الدور — بنجاحه أو بفشله. */
export async function clearGenerating(env: Env, conversationId: string): Promise<void> {
  try {
    await env.KV.delete(key(conversationId));
  } catch (e: any) {
    console.error('clear generating failed:', e?.message ?? e);
  }
}

/** هل يجري في هذه المحادثة دورٌ الآن؟ الشكُّ يُقرأ «لا»: دوّارةٌ بلا سبب أسوأ. */
export async function isGenerating(env: Env, conversationId: string): Promise<boolean> {
  try {
    return !!(await env.KV.get(key(conversationId)));
  } catch {
    return false;
  }
}
