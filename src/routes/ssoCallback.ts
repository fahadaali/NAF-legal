// الدخول الموحّد — مسار الاستقبال
//
// يقابل `functions/auth/callback.js` في وثيقة الربط، بصيغة Worker على Hono
// كما يوثّقها README الحزمة. ولا منطق هنا: المبادلة والتحقق والإدراج وفتح
// الجلسة كلها داخل `handleCallback` ولا يُنسخ منها شيء.

import { Hono } from 'hono';
import { clearCookie, handleCallback, readCookie } from 'naf-auth';
import { ssoConfig } from '../lib/sso';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/callback', (c) => handleCallback(c.req.raw, c.env, ssoConfig(c.env)));

/**
 * الخروج. تنقّلُ متصفحٍ لا نداءُ `fetch`، لأن إسقاط الكوكي يصاحبه تحويل.
 *
 * والجلسة تُحذف من `KV` لا يُكتفى بإسقاط الكوكي: الكوكي المُسقَط يبقى صالحاً
 * عند من نسخه، والحذف يُبطله عند الجميع. ثم يعود الطلب التالي إلى المركز
 * كأي طلب بلا جلسة.
 */
app.get('/logout', async (c) => {
  const config = ssoConfig(c.env);
  const sid = readCookie(c.req.raw, config.cookieName);
  if (sid) await config.kv(c.env).delete(`sess:${sid}`);

  return new Response(null, {
    status: 302,
    headers: { location: '/', 'set-cookie': clearCookie(config.cookieName) },
  });
});

export default app;
