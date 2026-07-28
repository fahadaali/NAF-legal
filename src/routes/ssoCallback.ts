// الدخول الموحّد — مسار الاستقبال
//
// وهو المسار المسجَّل في المركز لهذه المنصة:
//   https://naf-legal.naflaw-sa.workers.dev/auth/callback
//
// ولا منطق هنا: المبادلة والتحقق في `lib/handoff.ts`، والإدراج وفتح الجلسة
// في `lib/sso.ts`. وهذا الملف تركيبٌ لا غير.

import { Hono } from 'hono';
import { clearCookie, readCookie } from 'naf-auth';
import { ssoCallback, ssoConfig } from '../lib/sso';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/callback', (c) => ssoCallback(c));

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
