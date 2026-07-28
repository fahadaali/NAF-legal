// الدخول الموحّد — مسار الاستقبال
//
// يقابل `functions/auth/callback.js` في وثيقة الربط، بصيغة Worker على Hono
// كما يوثّقها README الحزمة. ولا منطق هنا: المبادلة والتحقق والإدراج وفتح
// الجلسة كلها داخل `handleCallback` ولا يُنسخ منها شيء.

import { Hono } from 'hono';
import { handleCallback, handleLogout } from 'naf-auth';
import { ssoConfig } from '../lib/sso';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/callback', (c) => handleCallback(c.req.raw, c.env, ssoConfig(c.env)));

/**
 * الخروج — في الحزمة، ووجهته المركز.
 *
 * كان هنا تحويلٌ إلى `‎/` بعد حذف الجلسة ومسح الكوكي. والحذف والمسح يقعان
 * فعلاً، ولا أثر يراه المستخدم: الجذر محميّ، فيحوّله الوسيط إلى
 * `‎/go/NAF-legal`، وجلسة المركز لم تُمسّ فتُصدر رمزاً جديداً — فيعود
 * الخارجُ إلى شاشته قبل أن يقرأ شيئاً.
 *
 * و`handleLogout` وجهته `‎{issuer}/`، خارج السياج.
 *
 * ويقبل التنقّل ونداء `fetch` معاً، وشكل الردّ يتبع طبيعة الطلب: ٣٠٢ للأوّل
 * لأن المتصفّح يتبعها، و`{ ok, next }` للثاني لأن `fetch` لا يتبع تحويلةً
 * إلى أصل آخر بلا `CORS`.
 *
 * و`GET` باقٍ بجانب `POST` لأن الواجهة تنتقل إليه بالمتصفّح. وهو مسجَّل
 * قبل الوسيط، فيعمل لمن انتهت جلسته أصلاً — وحمايتُه كانت تحوّل الخارجَ
 * إلى المركز ليدخل قبل أن يُسمح له بالخروج.
 */
app.on(['GET', 'POST'], '/logout', (c) => handleLogout(c.req.raw, c.env, ssoConfig(c.env)));

export default app;
