/**
 * خادم التفويض لـ`/mcp` — وثائق الاكتشاف والتسجيل والتفويض والرموز، وبابُ الضيف.
 *
 * مُركَّبٌ في `src/index.ts` قبل وسيط الدخول، لأن كلَّ ما هنا يُطلب بلا جلسة:
 * الأداةُ خادماً لخادم في الاكتشاف والتسجيل والرموز، والضيفُ ولا حساب له.
 * وما يحتاج هويّة العضو — السماح — ليس هنا: هو في `routes/mcpConnections.ts`
 * خلف الوسيط، فالعضو لا يُعرف إلا من المركز.
 *
 * والمنطق كلُّه في `mcp/oauth.ts`؛ هذا الملف يقرأ الطلب ويكتب الردّ فقط.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import {
  protectedResourceMetadata,
  authorizationServerMetadata,
  registerClient,
  startAuthorization,
  describeRequest,
  exchangeToken,
  revokeByToken,
  sendGuestCode,
  verifyGuestCode,
  denyRequest,
} from '../mcp/oauth';

const app = new Hono<{ Bindings: Env }>();

/**
 * CORS مفتوح لما تقرؤه الأدوات خادماً لخادم أو من متصفّح (مُفتّش MCP مثلاً).
 * لا كوكي في أيٍّ منها ولا `credentials`، فـ`*` لا يكشف شيئاً لا يكشفه طلبٌ مباشر.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-max-age': '86400',
};

function cors(c: Context, body: unknown, status = 200) {
  return c.json(body as Record<string, unknown>, status as 200, { ...CORS, 'cache-control': 'no-store' });
}

const origin = (c: Context) => new URL(c.req.url).origin;

for (const path of [
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/oauth/register',
  '/oauth/token',
  '/oauth/revoke',
]) {
  app.options(path, () => new Response(null, { status: 204, headers: CORS }));
}

app.get('/.well-known/oauth-protected-resource', (c) =>
  cors(c, protectedResourceMetadata(origin(c), c.env.APP_NAME || 'مستشار ناف'))
);
app.get('/.well-known/oauth-protected-resource/mcp', (c) =>
  cors(c, protectedResourceMetadata(origin(c), c.env.APP_NAME || 'مستشار ناف'))
);
app.get('/.well-known/oauth-authorization-server', (c) => cors(c, authorizationServerMetadata(origin(c))));

app.post('/oauth/register', async (c) => {
  const body = await c.req.json().catch(() => null);
  const r = await registerClient(c.env, body);
  return r.ok ? cors(c, r.client, 201) : cors(c, r.err, 400);
});

/**
 * بدءُ التفويض — تنقّلُ متصفّح، فالردّ تحويلةٌ لا JSON.
 *
 * والخطأ قبل التحقّق من الأداة وعنوان رجوعها يُعرض نصّاً ولا يُحوَّل: لا
 * يُرسَل أحدٌ إلى عنوانٍ لم يُسجَّل (RFC 6749 §4.1.2.1). وهو خطأُ مبرمجِ
 * الأداة لا خطأُ القارئ، فبالإنجليزية ولا يدخل قاموس المصطلحات.
 */
app.get('/oauth/authorize', async (c) => {
  const out = await startAuthorization(c.env, new URL(c.req.url).searchParams, origin(c));
  if (out.kind === 'invalid') {
    return c.text(`Invalid authorization request: ${out.message}`, 400, { 'cache-control': 'no-store' });
  }
  const location = out.kind === 'door' ? `/connect/${encodeURIComponent(out.requestId)}` : out.location;
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
});

/** RFC 6749 §3.2: نموذجٌ مُرمَّز. ويُقبل JSON أيضاً لأدواتٍ ترسله. */
async function readForm(c: Context): Promise<URLSearchParams> {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('application/json')) {
    const j = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(j)) if (typeof v === 'string') p.set(k, v);
    return p;
  }
  return new URLSearchParams(await c.req.text().catch(() => ''));
}

app.post('/oauth/token', async (c) => {
  const r = await exchangeToken(c.env, await readForm(c));
  return r.ok ? cors(c, r.body) : cors(c, r.err, r.status);
});

app.post('/oauth/revoke', async (c) => {
  await revokeByToken(c.env, (await readForm(c)).get('token') ?? '');
  return cors(c, {});
});

// ── باب الضيف (و`GET` الطلب لشاشة البابين) ──
// النصوص من `naf-terms.md` §١٥ — رسائل الربط.

const EXPIRED = 'انتهت مهلة طلب الربط. ابدأ الربط من أداتك من جديد.';

app.get('/oauth/connect/:id', async (c) => {
  const r = await describeRequest(c.env, c.req.param('id'));
  if (!r) return c.json({ error: EXPIRED, expired: true }, 410);
  return c.json({ client_name: r.clientName });
});

/** «إلغاء» من الضيف أو العضو — عامٌّ كباب الربط: الرفض لا يحتاج هويّة. */
app.post('/oauth/connect/:id/deny', async (c) => {
  const redirect = await denyRequest(c.env, c.req.param('id'), origin(c));
  if (!redirect) return c.json({ error: EXPIRED, expired: true }, 410);
  return c.json({ ok: true, redirect });
});

app.post('/oauth/connect/:id/guest/code', async (c) => {
  const { email } = (await c.req.json().catch(() => ({}))) as { email?: unknown };
  const r = await sendGuestCode(c.env, c.req.param('id'), typeof email === 'string' ? email : '');
  switch (r.kind) {
    case 'expired':
      return c.json({ error: EXPIRED, expired: true }, 410);
    case 'invalid_email':
      return c.json({ error: 'البريد الإلكتروني غير صحيح. اكتبه كاملاً كما يصلك عليه البريد.' }, 400);
    case 'member':
      return c.json({ error: 'هذا البريد لعضوٍ في ناف. ادخل من باب الأعضاء ليُحفظ ما تنتجه الأداة في محادثاتك.', member: true }, 409);
    default:
      return c.json({
        ok: true,
        message:
          'إن كان البريد مسجّلاً ضيفاً فسيصله رمز التحقق خلال دقيقة، وهو صالح عشر دقائق. لم يصل؟ تأكّد من البريد أو اطلب الإضافة من مسؤول المنصة.',
      });
  }
});

app.post('/oauth/connect/:id/guest/verify', async (c) => {
  const { email, code } = (await c.req.json().catch(() => ({}))) as { email?: unknown; code?: unknown };
  const r = await verifyGuestCode(
    c.env,
    c.req.param('id'),
    typeof email === 'string' ? email : '',
    typeof code === 'string' ? code : '',
    origin(c)
  );
  if (r.ok) return c.json({ ok: true, redirect: r.redirect });
  if (r.reason === 'expired') return c.json({ error: EXPIRED, expired: true }, 410);
  return c.json({ error: 'رمز التحقق غير صحيح أو انتهت صلاحيته. اطلب رمزاً جديداً.' }, 400);
});

export default app;
