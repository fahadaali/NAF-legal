/**
 * مسارُ استقبال التفويض من خادمٍ أجنبيّ.
 *
 * وموضعُه تحت `/auth` عمداً، ومُركَّبٌ **قبل** وسيط الدخول الموحّد: إليه يعود
 * القادم من خادم التفويض، وقد تكون جلستُه انقضت في أثناء صفحة الإذن. وهي
 * حجّةُ `/auth/callback` نفسها، مكتوبةً في `src/index.ts` — ونمطٌ ثانٍ لنفس
 * الشكل انحراف.
 *
 * **والحارسُ ليس الجلسة بل الحالة:** `state` بصمتُها مفتاحٌ في KV، تُقرأ
 * وتُمحى قبل المبادلة فلا تُستعمل مرّتين؛ ومعها كوكي ربطٍ يُثبت أن الردّ عاد
 * إلى المتصفّح الذي بدأ — فكونُ الزائر مسؤولاً لا يُثبت أنه البادئ.
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { completeAuthorization, BIND_COOKIE } from '../lib/oauth';
import { recordCheck } from '../lib/sources';

const app = new Hono<{ Bindings: Env }>();

/** قراءةُ كوكي بالتقسيم لا بنمط — اسمُ الكوكي لا يُقحَم في تعبير نمطيّ. */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

const CLEAR_BIND = `${BIND_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/auth/mcp; Max-Age=0`;

app.get('/callback', async (c) => {
  const url = new URL(c.req.url);
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const failure = url.searchParams.get('error');
  const bind = readCookie(c.req.header('cookie'), BIND_COOKIE);

  /* والمسؤول يُعاد إلى شاشته في كلّ حال — لا JSON: من تبع رابطاً يجب أن يجد
     نفسه في صفحةٍ لا في جسم ردّ. والسببُ يُقيَّد في الصفّ ليُقرأ هناك. */
  const back = (ok: boolean) =>
    new Response(null, {
      status: 302,
      headers: { location: `/?v=admin&mcp=${ok ? 'ok' : 'failed'}`, 'cache-control': 'no-store', 'set-cookie': CLEAR_BIND },
    });

  if (failure) {
    /* رفضٌ من الخادم أو من المستخدم — حالٌ سويّة لا عطل. ولا مصدرَ يُعرف
       بلا حالةٍ صحيحة، فلا يُقيَّد شيء. */
    console.error(`mcp oauth: الخادم ردّ ${failure}`);
    return back(false);
  }

  const done = await completeAuthorization(c.env, state, code, bind, url.searchParams.get('iss'));
  if (done.sourceId) {
    await recordCheck(
      c.env,
      done.sourceId,
      done.ok ? 'ok' : 'unconfigured',
      done.ok ? null : (done.error ?? 'تعذّر إتمام التفويض')
    );
  }
  if (!done.ok) console.error(`mcp oauth: ${done.error}`);
  return back(done.ok);
});

export default app;
