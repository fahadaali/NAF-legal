/**
 * ملفٌّ يُعرض داخل المنصة في إطار — سياستُه غيرُ سياسة الصفحة.
 *
 * سياسةُ الصفحة في `src/index.ts` تقول `frame-ancestors 'none'`: لا يضع المنصةَ
 * أحدٌ في إطار. وهي صحيحةٌ للصفحة، وخاطئةٌ لملفٍّ تعرضه المنصة نفسها في نافذتها
 * العائمة (`AttachmentViewer` و`KbViewer`): المتصفّح يرفض عرضه، فتظهر النافذة
 * فارغة. وكانت مسارات الملفات تكتب سياستها (`sandbox`)، فيكتب `secureHeaders`
 * فوقها بعد المسار سياسةَ الصفحة — فتذهب الحماية التي أرادها المسار، ويأتي
 * المنعُ الذي لم يُرده.
 *
 * فالمسار لا يكتب السياسة بنفسه، بل يَسِم ردَّه بهذه الترويسة، والوسيطُ الأبعد
 * في `src/index.ts` — يعمل بعد `secureHeaders` — يضع السياسة ويمحو الوسم:
 *
 *   `pdf`      إطارٌ من المنصة وحدها، ولا شيء غيره. عارضُ PDF في المتصفّح لا
 *              يعمل في وثيقةٍ معزولة، وPDF لا يحمل HTML يُنفَّذ.
 *   `sandbox`  إطارٌ من المنصة وحدها، والملفُّ معزول: لا نصَّ فيه يعمل
 *              بصلاحيات المنصة ولو كان صفحةً أو SVG.
 */
import type { Context, Next } from 'hono';

export const FRAMED_FILE_HEADER = 'x-naf-framed-file';

export type FramedFileKind = 'pdf' | 'sandbox';

/** السياسة التي تُكتب لكل وسم. */
export function framedFilePolicy(kind: string): string {
  return kind === 'pdf' ? "frame-ancestors 'self'" : "sandbox; frame-ancestors 'self'";
}

/** يُسجَّل قبل `secureHeaders` في `src/index.ts` — فيعمل بعده على الردّ. */
export async function framedFileMiddleware(c: Context, next: Next): Promise<void> {
  await next();
  const kind = c.res.headers.get(FRAMED_FILE_HEADER);
  if (kind === null) return;
  /* تُكتب على الردّ نفسه لا على ردٍّ جديد: إسنادُ `c.res` في Hono ينسخ ترويساتِ
     الردّ القديم فوق الجديد — فتعود سياسة الصفحة التي جئنا لنبدّلها. والردُّ
     هنا بناه المسار بـ`new Response`، فترويساته قابلةٌ للكتابة. */
  const headers = c.res.headers;
  headers.delete(FRAMED_FILE_HEADER);
  headers.set('content-security-policy', framedFilePolicy(kind));
  headers.set('x-frame-options', 'SAMEORIGIN');
  headers.set('x-content-type-options', 'nosniff');
}
