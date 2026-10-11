/* رفع المرفق — الاستخراج المحلّي ثم الرفع، في موضعٍ واحد لصندوق الكتابة
 * ونافذة البدء معاً. كانا يكرّران الخطوتين، وما يُصلَح في أحدهما يُنسى في
 * الآخر. */
import { api } from './api';
import { extractPdf, readableLocally } from './extractText';

/**
 * يستخرج ما يُقرأ في المتصفّح ثم يرفع الملف.
 *
 * الاستخراج قبل الرفع لا بعده: النصّ يسافر مع الملف في طلبٍ واحد، فلا يبقى
 * الصفّ ينتظر قراءةً ثانية. وما لا يُقرأ محلّياً يُرفع بلا نصّ ويتولّاه
 * الخادم — صورةً أو ممسوحاً ضوئياً.
 */
export async function uploadAttachment(conversationId: string, file: File) {
  const local = readableLocally(file) ? await extractPdf(file) : null;
  return api.uploadFile(conversationId, file, local);
}

/**
 * كم ملفاً يُعالَج معاً.
 *
 * كانت الملفات تُعالَج واحداً بعد واحد، فخمسةُ ملفاتٍ خمسةُ أضعاف الانتظار.
 * وثلاثةٌ لا أكثر: الاستخراج يجري في خيط الصفحة نفسه، ورسمُ الصفحات
 * الممسوحة يأخذ ذاكرة، وثلاثةُ رفوعٍ متوازية تملأ اتصالاً عادياً.
 */
export const UPLOAD_CONCURRENCY = 3;

/**
 * يمرّ على العناصر بحدٍّ أقصى من المهامّ المتزامنة، ويردّ النتائج بترتيب
 * العناصر لا بترتيب انتهائها. ومهمّةٌ ترمي لا توقف أخواتها: نتيجتها
 * `{ ok: false }` وتمضي البقية.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<({ ok: true; value: R } | { ok: false; error: unknown })[]> {
  const results: ({ ok: true; value: R } | { ok: false; error: unknown })[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
