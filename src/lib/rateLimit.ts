/**
 * حدُّ معدّلٍ بنافذةٍ ثابتة عبر KV — موضعٌ واحد للمنصة كلّها.
 *
 * كان مكتوباً داخل وسيط `/api/*` في `src/index.ts`، ثم احتاجه بابُ خادم تفويض
 * MCP (`routes/mcpAuthServer.ts`): مساراتٌ عامّة بلا حساب، والتسجيلُ والتفويضُ
 * وطلبُ الرمز فيها مفتوحةٌ لأيّ أحد. ونسخةٌ ثانيةٌ من المنطق نفسه تختلف عن
 * الأولى عند أول تعديل، فخرج إلى هنا ويناديه الموضعان.
 *
 * نافذةٌ ثابتة بوقت انتهاءٍ مخزَّنٍ داخل القيمة: تجديدُ TTL على كل طلب كان
 * يمنع العدّاد من الصفر فيُحجب المستخدم النشِط بلا مبرّر.
 *
 * و`true` إن كان الطلب ضمن الحدّ. وKV غائب (التطوير) أو معطَّل ⇦ `true`:
 * الحدّ حمايةٌ لا شرطٌ لعمل المنصة.
 */
import type { Env } from '../types';

/**
 * وكتابةُ العدّاد لا ينتظرها الطلب حين يُعطى `defer` (وهو `waitUntil`).
 *
 * كتابةُ KV تذهب إلى المخزن المركزي، وكانت تُنتظر قبل كل نداءٍ إلى `/api/*`
 * — فيدفع كلُّ ضغطةٍ في المنصة ثمنَ رحلةٍ لا يحتاج نتيجتها: الحكمُ قد صدر
 * من القراءة قبلها. والعدّ بعدها تقريبيٌّ أصلاً (KV متّسقٌ في النهاية)، فلا
 * يفقد الحدُّ بالتأجيل شيئاً لم يكن يفقده.
 */
export async function withinRateLimit(
  env: Env,
  key: string,
  limit: number,
  windowSec: number,
  defer?: (pending: Promise<unknown>) => void
): Promise<boolean> {
  try {
    const now = Date.now();
    const raw = await env.KV.get(key);
    let count = 0;
    let resetAt = now + windowSec * 1000;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { c: number; r: number };
        if (parsed.r > now) {
          count = parsed.c;
          resetAt = parsed.r;
        }
      } catch {
        // قيمة قديمة بصيغة رقم — تُعامَل كنافذة جديدة
      }
    }
    if (count >= limit) return false;
    const ttl = Math.max(60, Math.ceil((resetAt - now) / 1000));
    const write = env.KV.put(key, JSON.stringify({ c: count + 1, r: resetAt }), { expirationTtl: ttl });
    if (defer) defer(write.catch(() => {}));
    else await write;
    return true;
  } catch {
    return true;
  }
}

/** رسالةُ تجاوز الحدّ — نصُّ المنصة نفسه في كل موضع. */
export const RATE_LIMIT_MESSAGE = 'تجاوزت حد الطلبات، حاول بعد قليل';
