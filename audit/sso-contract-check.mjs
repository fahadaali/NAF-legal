// فحص عقد الدخول الموحّد — NAF-legal
//
// يشغّل **إعداد هذه المنصة الحقيقي** (`src/lib/sso.ts` بقائمة مساراته العامة
// وخطّاف `onClaims` كما هما) مقابل محاكاة للمركز مكتوبة من مصدره:
// `functions/api/token.js` و `functions/go/[id].js` و
// `functions/api/internal/access.js` — بمنطق تحقّقها نفسه، لا بما نتوقّعه منها.
//
// ولماذا يُحزَم الإعداد قبل استيراده: ملفّه TypeScript ويستورد `./crypto` بلا
// امتداد، وNode لا يحلّ ذلك. فيُحزَم بـ esbuild (القائم مع wrangler) إلى
// `node_modules/.cache` — داخل المستودع ليبقى `naf-auth` نسخةً واحدة يشترك
// فيها الإعداد وهذا الفحص. ولا يُعاد بناء الإعداد هنا: نسخةٌ منه تفحص نفسها.
//
// التشغيل:  npm run check:sso

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  authenticate,
  handleBackchannelLogout,
  handleCallback,
  reportAccessChange,
} from 'naf-auth';
/* أسماء مفاتيح KV واسم كوكي الربط تُستوردان من الحزمة لا تُكتبان هنا:
   المحاكاة تزرع جلساتٍ في KV مباشرةً، فلو كتبت الاسم بيدها ثم غيّرته
   الحزمة لمضت الفحوص تزرع في مكانٍ لا يقرؤه أحد — وتمرّ كلُّها. */
import { sessionKeyFor, userIndexKeyFor } from 'naf-auth/safe';
import { bindCookieName } from 'naf-auth/middleware';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ISSUER = 'https://app.naflaw.sa';
const PLATFORM = 'NAF-legal';            // بحالة أحرفه — والمقارنة حرفية
const ORIGIN = 'https://advisor.naflaw.sa';
const SECRET = 'the-platform-secret';
const ALGO = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

// ── حزم إعداد المنصة الحقيقي ──
const { ssoConfig } = await (async () => {
  const esbuild = await import('esbuild');
  const out = path.join(ROOT, 'node_modules', '.cache', 'naf-sso-config.mjs');
  await mkdir(path.dirname(out), { recursive: true });
  const built = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'lib', 'sso.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    external: ['naf-auth', 'hono'],
    write: false,
  });
  await writeFile(out, built.outputFiles[0].text);
  return import(pathToFileURL(out).href);
})();

const b64 = (b) => Buffer.from(b).toString('base64url');
const enc = (v) => b64(new TextEncoder().encode(JSON.stringify(v)));

const pair = await crypto.subtle.generateKey(
  { ...ALGO, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['sign', 'verify'],
);
const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
const JWK = { kty: pub.kty, n: pub.n, e: pub.e, alg: 'RS256', kid: 'cur' };

async function signToken(claims) {
  const input = `${enc({ alg: 'RS256', typ: 'JWT', kid: 'cur' })}.${enc(claims)}`;
  const sig = await crypto.subtle.sign(ALGO, pair.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64(new Uint8Array(sig))}`;
}

// ═══ محاكاة المركز ═══
const centerKV = new Map();     // code -> record
const accessRows = [];          // ما يكتبه /api/internal/access
const failures = [];

// functions/go/[id].js — يتجاهل أي state يصله ويولّد واحدة من عنده،
// ويحفظ `bind` كما وصله ليعيده `/api/token` عند المبادلة.
function centerGo(url) {
  const u = new URL(url);
  const next = u.searchParams.get('next') || '/';
  const bind = u.searchParams.get('bind');
  if (bind !== null) assert.match(bind, /^[a-f0-9]{64}$/, `bind ليس تجزئة: ${bind}`);
  const code = `CODE-${Math.random().toString(16).slice(2)}`;
  const state = `STATE-${Math.random().toString(16).slice(2)}`;
  centerKV.set(`code:${code}`, { userId: 'user-1', platformId: PLATFORM, state, next, bind });
  return { code, state, next, bind };
}

/** مقلبٌ يجعل المحاكاة مركزاً أقدم من الحزمة: لا يعرف `bind` ولا يعيده. */
let centerOmitsBind = false;

// functions/api/token.js — منطق التحقق كما هو مكتوب هناك
async function centerToken(body) {
  const { platformId, secret, code, state } = body ?? {};
  if (typeof platformId !== 'string' || typeof secret !== 'string'
      || typeof code !== 'string' || typeof state !== 'string') {
    failures.push('invalid_body');
    return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 });
  }
  if (platformId !== PLATFORM || secret !== SECRET) {
    failures.push('invalid_client');
    return new Response('{}', { status: 401 });
  }
  const raw = centerKV.get(`code:${code}`);
  centerKV.delete(`code:${code}`);                       // يُستهلك مرة واحدة
  if (!raw) { failures.push('invalid_code'); return new Response('{}', { status: 400 }); }
  if (raw.platformId !== platformId) { failures.push('invalid_code'); return new Response('{}', { status: 400 }); }
  if (raw.state !== state) { failures.push('invalid_state'); return new Response('{}', { status: 400 }); }

  const now = Math.floor(Date.now() / 1000);
  const token = await signToken({
    sub: 'user-1', name: 'فهد', email: 'f@naflaw.sa',
    iss: ISSUER, aud: PLATFORM, iat: now, exp: now + 900,
  });
  /* `bind` يعود كما وصل — والمركز الأقدم لا يعرف الحقل أصلاً، وتلك حالة
     `legacy_center` التي تُفحص أدناه بمحاكاةٍ تُسقطه. */
  return Response.json({
    token, tokenType: 'Bearer', expiresIn: 900, next: raw.next ?? '/',
    ...(centerOmitsBind ? {} : { bind: raw.bind ?? null }),
  });
}

// functions/api/internal/access.js
function centerAccess(body) {
  const { platformId, secret } = body ?? {};
  if (typeof platformId !== 'string' || typeof secret !== 'string') {
    failures.push('access:invalid_body'); return new Response('{}', { status: 400 });
  }
  if (platformId !== PLATFORM || secret !== SECRET) {
    failures.push('access:invalid_client'); return new Response('{}', { status: 401 });
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email) { failures.push('access:invalid_body'); return new Response('{}', { status: 400 }); }

  // الحالة اختيارية مذ صار الدخول يبلّغ الصلاحية وحدها بلا حالة، لكنّ
  // أحدهما لازم: بلاغٌ بلا حالة ولا دور لا يحمل شيئاً يُكتب.
  const hasState = body.state !== undefined && body.state !== null;
  if (hasState && !['granted', 'revoked'].includes(body.state)) {
    failures.push('access:invalid_state'); return new Response('{}', { status: 400 });
  }
  const role = typeof body.role === 'string' && body.role.trim() ? body.role.trim() : null;
  if (!hasState && !role) { failures.push('access:invalid_body'); return new Response('{}', { status: 400 }); }

  accessRows.push({ email, state: hasState ? body.state : null, role, reason: body.reason ?? null });
  return Response.json({ ok: true });
}

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  const body = init.body ? JSON.parse(init.body) : null;
  if (href.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [JWK] });
  if (href.endsWith('/api/token')) return centerToken(body);
  if (href.endsWith('/api/internal/access')) return centerAccess(body);
  return new Response('nf', { status: 404 });
};

// ═══ بيئة المنصة ═══
const kvStore = new Map();
const kv = {
  async get(k, t) { const v = kvStore.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
  async put(k, v, o) { kvStore.set(k, v); kvStore.set(`__ttl:${k}`, o?.expirationTtl); },
  async delete(k) { kvStore.delete(k); },
  /* `list` بصفحاتٍ صغيرة عمداً: KV الحقيقي يردّ صفحة محدودة ومعها مؤشّر،
     ومن قرأ الصفحة الأولى وحدها ظنّ أنه استوفى. */
  async list({ prefix = '', cursor, limit = 2 } = {}) {
    const all = [...kvStore.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const slice = all.slice(start, start + limit);
    const end = start + slice.length;
    const complete = end >= all.length;
    return {
      keys: slice.map((name) => ({ name })),
      list_complete: complete,
      cursor: complete ? undefined : String(end),
    };
  },
};

/* قاعدة في الذاكرة — جدولان لأن هذه المنصة تربط بالبريد ولا تستبدل الهوية:
   `members` مفتاحه `sub` من المركز، و`users` مفتاح كل جداول المنصة القائمة. */
const members = new Map();
const users = new Map();

const DB = {
  prepare(sql) {
    const q = sql.replace(/\s+/g, ' ').trim();
    let args = [];
    return {
      bind(...a) { args = a; return this; },
      async first() {
        // store.getMember — قراءة الحزمة للعضو
        if (q.includes('AS id') && q.includes('FROM members')) {
          const m = members.get(args[0]);
          return m ? { id: m.user_id, role: m.role, is_active: m.is_active, perms: m.perms } : null;
        }
        // linkExistingMember — هل للعضو سجلّ أصلاً
        if (q.startsWith('SELECT user_id FROM members WHERE user_id')) {
          const m = members.get(args[0]);
          return m ? { user_id: m.user_id } : null;
        }
        // linkExistingMember — سجلّ محلي مرتبط بهذه الهوية؟
        if (q.includes('FROM members WHERE local_user_id')) {
          for (const m of members.values()) if (m.local_user_id === args[0]) return { user_id: m.user_id };
          return null;
        }
        // linkExistingMember — مطابقة البريد بلا حساسية لحالة الأحرف
        if (q.includes('FROM users WHERE lower(email)')) {
          const needle = String(args[0]).toLowerCase();
          for (const u of users.values()) {
            if ((u.email ?? '').toLowerCase() === needle) return { id: u.id, role: u.role, name: u.name };
          }
          return null;
        }
        if (q.startsWith('SELECT email FROM members')) {
          const m = members.get(args[0]);
          return m ? { email: m.email } : null;
        }
        // وسيط المنصة — الجسر من `sub` إلى الهوية المحلية
        if (q.startsWith('SELECT local_user_id, email, display_name FROM members')) {
          const m = members.get(args[0]);
          return m
            ? { local_user_id: m.local_user_id, email: m.email, display_name: m.display_name }
            : null;
        }
        throw new Error(`استعلام غير متوقَّع في الفحص: ${q}`);
      },
      async run() {
        if (q.startsWith('INSERT INTO users')) {
          const [id, email, , name] = [args[0], args[1], args[2], args[3]];
          users.set(id, { id, email, role: 'user', name });
          return { meta: { changes: 1 } };
        }
        if (q.startsWith('INSERT INTO members')) {
          // صيغتان: صيغة المنصة (بـ local_user_id) وصيغة الحزمة (upsert)
          if (q.includes('local_user_id')) {
            const [user_id, display_name, email, role, created_at, local_user_id] = args;
            members.set(user_id, {
              user_id, display_name, email, role, perms: null,
              is_active: 1, created_at, local_user_id,
            });
          } else {
            const [user_id, display_name, email, role, is_active, created_at] = args;
            const prev = members.get(user_id);
            if (prev) { prev.display_name = display_name; prev.email = email; }
            else {
              members.set(user_id, {
                user_id, display_name, email, role, perms: null,
                is_active, created_at, local_user_id: null,
              });
            }
          }
          return { meta: { changes: 1 } };
        }
        if (q.startsWith('UPDATE members')) return { meta: { changes: 1 } };
        throw new Error(`أمر غير متوقَّع في الفحص: ${q}`);
      },
    };
  },
};

const env = {
  AUTH_ISSUER: ISSUER,
  PLATFORM_ID: PLATFORM,
  AUTH_CLIENT_SECRET: SECRET,
  AUTH_KV: kv,
  DB,
};
const config = ssoConfig(env);

const R = (p, cookie) => new Request(`${ORIGIN}${p}`, cookie ? { headers: { cookie } } : undefined);
const H = (p, headers) => new Request(`${ORIGIN}${p}`, { headers });

let pass = 0;
const ok = (label) => { console.log(`  [ok] ${label}`); pass += 1; };

/* المتصفّح يحمل ما كُتب له. و`startLogin` يكتب كوكي ربطٍ في ردّ التحويل،
   ويجب أن يعود مع الاستقبال — فبدونه يقرأ الحارسُ الطلبَ دخولاً لم يبدأ من
   هنا. وحارسٌ لا يُختبر إلا بلا كوكي يُختبر في فرعه الاحتياطي وحده. */
const setCookies = (response) =>
  (typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean));

const cookieJar = (response) =>
  setCookies(response).map((c) => c.split(';')[0])
    .filter((c) => !c.endsWith('='))        // ما مُحي لا يُحمل
    .join('; ');

/* عنوانُ الاستقبال كما يبنيه المركز: `functions/go/[id].js` يضيف `code`
   و`state`، ويضيف `next` إن لم يكن الجذر (السطر ١٢٧ هناك). وحذفُه من
   المحاكاة يُخفي أن لفّة الربط تقرأ الوجهة من عنوان الطلب لا من ردّ
   المبادلة — فتُقرأ اللفّة سليمةً وهي تُسقط وجهةَ صاحبها. */
const callbackUrl = ({ code, state, next }) => {
  const q = new URLSearchParams({ code, state });
  if (next && next !== '/') q.set('next', next);
  return `/auth/callback?${q}`;
};

/** رحلةُ دخولٍ كاملة كما يمشيها متصفّح: الحارس ← المركز ← الاستقبال. */
async function browserLogin(pathname, { tamper } = {}) {
  const { response: gate } = await authenticate(R(pathname), env, config);
  const goUrl = gate.headers.get('location');
  const jar = cookieJar(gate);
  const { code, state, next } = centerGo(goUrl);
  if (tamper) tamper(centerKV.get(`code:${code}`));
  const cb = await handleCallback(R(callbackUrl({ code, state, next }), jar), env, config);
  return { gate, goUrl, code, state, next, cb, jar };
}

// ── ١: الجذر محمي ──
{
  const { response, user } = await authenticate(R('/'), env, config);
  assert.equal(user, undefined);
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), new RegExp(`^${ISSUER}/go/${PLATFORM}`));
  ok('الجذر محمي — زائر بلا جلسة يُردّ إلى المركز');
}

// ── ٢: المعرّف يمرّ بحالة أحرفه ──
{
  const { response } = await authenticate(R('/api/conversations'), env, config);
  const loc = (await response.json()).login;
  assert.ok(loc.includes(`/go/${PLATFORM}`), loc);
  assert.ok(!loc.includes('/go/naf-legal'), 'لا يُطبَّع إلى حروف صغيرة');
  ok('معرّف المنصة يمرّ بحالة أحرفه — لا يُطبَّع');
}

// ── ٣: مساحة KV مستقلّة ──
{
  assert.equal(config.kvBinding, 'AUTH_KV', 'الحزمة يجب أن تقرأ AUTH_KV لا KV');
  assert.throws(() => config.kv({ KV: kv }), /AUTH_KV/);
  ok('المصادقة على مساحة AUTH_KV لا على مساحة حدّ المعدّل');
}

// ── ٤: التدفّق الكامل ──
let sessionCookie;
{
  const { gate, goUrl, cb } = await browserLogin('/?view=members');

  // الحارس يرسل تجزئةً إلى المركز، وسرَّها في كوكي لا يخرج من المتصفّح.
  assert.match(new URL(goUrl).searchParams.get('bind') ?? '', /^[a-f0-9]{64}$/,
    'الحارس لم يُرسل تجزئة الربط');
  assert.ok(cookieJar(gate).includes(`${bindCookieName(config)}=`), 'لم يُكتب كوكي الربط');

  assert.equal(failures.length, 0, `المركز رفض: ${failures.join()}`);
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/?view=members');

  sessionCookie = setCookies(cb).map((c) => c.split(';')[0]).find((c) => c.startsWith('naf_sid='));
  assert.ok(sessionCookie, 'لم يُكتب كوكي الجلسة');

  // وكوكي الربط يُمحى بعد استعماله — لا يُترك حتى ينتهي عمره.
  assert.ok(
    setCookies(cb).some((c) => c.startsWith(`${bindCookieName(config)}=;`) && /Max-Age=0/.test(c)),
    'كوكي الربط لم يُمحَ بعد الاستعمال',
  );
  ok('التدفّق الكامل يمرّ مربوطاً بالمتصفّح ويعود إلى الوجهة المطلوبة');
}

// ── ٥: `onClaims` يربط بالبريد ويهيّئ سجلّاً محلياً ──
{
  const m = members.get('user-1');
  assert.ok(m, 'أُنشئ صفّ عضو');
  assert.ok(m.local_user_id, 'وله سجلّ محلي في users');
  assert.ok(users.get(m.local_user_id), 'والسجلّ المحلي موجود فعلاً');
  assert.equal(m.role, 'viewer', 'الدور الافتراضي لأول دخول');
  ok('onClaims يهيّئ سجلّ users ويربطه — فلا مفتاح أجنبي معلّق');
}

// ── ٦: عمر الجلسة لا يتجاوز عمر الرمز ──
{
  const sid = [...kvStore.keys()].find((k) => k.startsWith('sess:'));
  const ttl = kvStore.get(`__ttl:${sid}`);
  assert.ok(ttl <= 900 && ttl > 800, `ttl=${ttl}`);
  ok(`عمر الجلسة ${ttl}s — لا يتجاوز عمر الرمز`);
}

// ── ٧: الجلسة تفتح المحمي ──
{
  const { user, response } = await authenticate(R('/api/conversations', sessionCookie), env, config);
  assert.equal(response, undefined);
  assert.equal(user.id, 'user-1');
  ok('الجلسة تفتح المسارات المحمية');
}

// ── ٨: رمز العبور لا يُستهلك مرتين ──
{
  const { code, state, next, jar } = await browserLogin('/');
  failures.length = 0;
  const replay = await handleCallback(R(callbackUrl({ code, state, next }), jar), env, config);
  assert.equal(replay.headers.get('location'), '/denied?r=auth_failed');
  assert.deepEqual(failures, ['invalid_code']);
  ok('إعادة استعمال رمز العبور تفشل عند المركز');
}

// ── ٩: حالة لا تطابق ما خزّنه المركز ──
{
  failures.length = 0;
  const { response } = await authenticate(R('/'), env, config);
  const jar = cookieJar(response);
  const { code } = centerGo(response.headers.get('location'));
  const cb = await handleCallback(R(`/auth/callback?code=${code}&state=WRONG`, jar), env, config);
  assert.equal(cb.headers.get('location'), '/denied?r=auth_failed');
  assert.deepEqual(failures, ['invalid_state']);
  ok('حالة لا تطابق ما خزّنه المركز تُرفض');
}

// ── ١٠: رمز منتهٍ يُبطل الجلسة في كل طلب ──
{
  const now = Math.floor(Date.now() / 1000);
  const stale = await signToken({ sub: 'user-1', iss: ISSUER, aud: PLATFORM, iat: now - 1200, exp: now - 600 });
  const staleKey = await sessionKeyFor('stale');
  kvStore.set(staleKey, JSON.stringify({ sub: 'user-1', token: stale, exp: now - 600 }));
  const { user, response } = await authenticate(R('/api/conversations', 'naf_sid=stale'), env, config);
  assert.equal(user, undefined, 'رمز منتهٍ لا يمرّ');
  assert.equal(response.status, 401);
  assert.equal(kvStore.has(staleKey), false, 'الجلسة تُمسح');
  ok('رمز منتهٍ يُبطل الجلسة في كل طلب محمي');
}

// ── ١١: رمز صادر لمنصة أخرى ──
{
  const now = Math.floor(Date.now() / 1000);
  const other = await signToken({ sub: 'user-1', iss: ISSUER, aud: 'NAF-Forms', iat: now, exp: now + 900 });
  kvStore.set(await sessionKeyFor('other'), JSON.stringify({ sub: 'user-1', token: other, exp: now + 900 }));
  const { user } = await authenticate(R('/api/conversations', 'naf_sid=other'), env, config);
  assert.equal(user, undefined);
  ok('رمز صادر لمنصة أخرى يُرفض بـ aud');
}

// ── ١٢: قائمة المسارات العامة ──
{
  for (const p of ['/auth/callback', '/denied', '/api/health', '/assets/index.js', '/brand/mark.svg']) {
    const r = await authenticate(R(p), env, config);
    assert.equal(r.public, true, `${p} يجب أن يكون عاماً`);
  }
  // دخول كلمة المرور المحلي خلف الحارس، ومسارا المشاركة العامة كذلك —
  // وإخضاعهما قرارُ جلسة سابقة موصوف في `audit/sso-report.md`.
  for (const p of ['/', '/index.html', '/api/auth/login', '/api/auth/register',
                   '/api/conversations', '/api/members', '/review/tok', '/api/shares/public/tok']) {
    const r = await authenticate(R(p), env, config);
    assert.ok(r.response, `${p} يجب أن يكون محمياً`);
  }
  ok('المسارات العامة مضبوطة — ودخول كلمة المرور والمشاركة خلف الحارس');
}

// ── ١٣: شكل الردّ يتبع طبيعة الطلب لا بادئة المسار ──
{
  // روابط تنزيل تحت `/api/` يفتحها المستخدم بنفسه: تنقّلٌ يُحوَّل، لا JSON.
  for (const p of ['/api/files/export/msg1?format=docx', '/api/cases/f1/export',
                   '/api/kb/documents/d1/file']) {
    const nav = await authenticate(H(p, { 'sec-fetch-mode': 'navigate' }), env, config);
    assert.equal(nav.response.status, 302, `${p} تنقّلٌ يجب أن يُحوَّل`);
  }

  // ونداءُ fetch إلى المسار نفسه: رمز حالة وجسم يُقرأ.
  const call = await authenticate(H('/api/files/export/msg1', { 'sec-fetch-mode': 'cors' }), env, config);
  assert.equal(call.response.status, 401);
  assert.match((await call.response.json()).login, new RegExp(`^${ISSUER}/go/${PLATFORM}`));

  ok('شكل الردّ يتبع طبيعة الطلب — رابط التنزيل يُحوَّل ولا يأخذ JSON');
}

// ── ١٤: العضو الموقوف على نداء برمجي — ٤٠٣ بجسم يُقرأ ──
{
  const now = Math.floor(Date.now() / 1000);
  members.get('user-1').is_active = 0;
  kvStore.set(await sessionKeyFor('off'), JSON.stringify({
    sub: 'user-1',
    token: await signToken({ sub: 'user-1', iss: ISSUER, aud: PLATFORM, iat: now, exp: now + 900 }),
    exp: now + 900,
  }));

  const denied = await authenticate(
    H('/api/conversations', { cookie: 'naf_sid=off', 'sec-fetch-mode': 'cors' }), env, config,
  );
  assert.equal(denied.response.status, 403);
  assert.equal(denied.response.headers.get('location'), null, 'لا تحويلة داخلية يتبعها fetch');
  const body = await denied.response.json();
  assert.equal(body.reason, 'inactive');
  assert.equal(body.denied, '/denied?r=inactive');
  members.get('user-1').is_active = 1;
  ok('العضو الموقوف على نداء برمجي — ٤٠٣ بجسم يُقرأ لا صفحة نصّاً');
}

// ── ١٥: التبليغ العكسي بالتوقيع القائم، في الاتجاهين ──
{
  failures.length = 0;
  await reportAccessChange(env, config, { email: 'F@NafLaw.sa', state: 'revoked', reason: 'انتهى التعاقد' });
  assert.deepEqual(failures, [], 'المركز رفض التبليغ');
  assert.deepEqual(accessRows.at(-1), {
    email: 'f@naflaw.sa', state: 'revoked', role: null, reason: 'انتهى التعاقد',
  });

  // وإعادة التفعيل تُبلَّغ كذلك، وإلا بقي صفّ الوصول `revoked` في المركز
  // فيُردّ عضوٌ تراه هذه المنصة نشطاً.
  await reportAccessChange(env, config, { email: 'f@naflaw.sa', state: 'granted' });
  assert.deepEqual(failures, []);
  assert.deepEqual(accessRows.at(-1), {
    email: 'f@naflaw.sa', state: 'granted', role: null, reason: null,
  });
  ok('التبليغ العكسي يُقبل في الاتجاهين ويكتب صفّ الوصول');
}

// ── التبليغ بالصلاحية وحدها: ما يرسله الدخول، بلا حالة ──
{
  failures.length = 0;
  await reportAccessChange(env, config, { email: 'f@naflaw.sa', role: 'editor' });
  assert.deepEqual(failures, [], 'المركز رفض بلاغ الصلاحية');
  assert.deepEqual(accessRows.at(-1), {
    email: 'f@naflaw.sa', state: null, role: 'editor', reason: null,
  });
  ok('الدخول يبلّغ المركز بالصلاحية بلا حالة');
}

// ── ١٦: وجهة عدائية تُنقّى ──
{
  for (const hostile of ['//evil.sa', '/%2f%2fevil.sa', '/\\evil.sa', 'https://evil.sa']) {
    // مركزٌ مخترَق يعيد وجهة عدائية
    const { cb } = await browserLogin('/', { tamper: (rec) => { rec.next = hostile; } });
    assert.equal(cb.headers.get('location'), '/', `${hostile} خرج بالمستخدم`);
  }
  ok('وجهة عدائية من ردّ المبادلة تُنقّى إلى الجذر');
}

// ── ١٧: وسيط هذه المنصة لا يُعيد بناء التفريق ──
//
// البنود أعلاه تفحص الحزمة. وهذا يفحص غلاف هذه المنصة نفسه: كان يحوّل ردّ
// الحزمة إلى ٤٠١ متى بدأ المسار بـ`/api/`، فيأخذ رابطُ التنزيل JSON. فلو
// عاد ذلك السطر سقط هذا البند وحده.
{
  const { ssoMiddleware } = await import(
    pathToFileURL(path.join(ROOT, 'node_modules', '.cache', 'naf-sso-config.mjs')).href
  );

  const fakeCtx = (request) => {
    const vars = new Map();
    return {
      env,
      req: { raw: request, path: new URL(request.url).pathname },
      set: (k, v) => vars.set(k, v),
      get: (k) => vars.get(k),
      json: (body, status) => Response.json(body, { status }),
      vars,
    };
  };

  // تنقّلٌ إلى رابط تنزيل تحت `/api/` — تحويلة لا JSON
  const navRes = await ssoMiddleware(
    fakeCtx(H('/api/files/export/msg1', { 'sec-fetch-mode': 'navigate' })),
    async () => {},
  );
  assert.equal(navRes.status, 302, 'الوسيط حوّل تنقّل التنزيل إلى ردّ برمجي');
  assert.match(navRes.headers.get('location'), new RegExp(`^${ISSUER}/go/${PLATFORM}`));

  // ونداءُ fetch إلى المسار نفسه — ٤٠١ ومعه الباب
  const callRes = await ssoMiddleware(
    fakeCtx(H('/api/files/export/msg1', { 'sec-fetch-mode': 'cors' })),
    async () => {},
  );
  assert.equal(callRes.status, 401);
  assert.ok((await callRes.json()).login, 'الجسم يحمل عنوان الباب');

  // وجلسةٌ سارية: يحقن الهوية المحلية لا `sub`، وإلا انقطع المستخدم عن بياناته
  const ctx = fakeCtx(R('/api/conversations', sessionCookie));
  let reached = false;
  await ssoMiddleware(ctx, async () => { reached = true; });
  assert.equal(reached, true, 'الطلب المصادَق يمرّ');
  const injected = ctx.get('user');
  assert.equal(injected.id, members.get('user-1').local_user_id, 'الهوية المحقونة محلية');
  assert.equal(injected.memberId, 'user-1', 'والمعرّف المركزي محفوظ بجانبها');

  ok('وسيط المنصة لا يُعيد بناء التفريق — ويحقن الهوية المحلية');
}

// ── إشعار الخروج الخلفي: الخروج من المركز يُنهي الجلسة هنا ──
{
  const now = Math.floor(Date.now() / 1000);

  // جلسة قائمة، بدليلها كما يكتبه مسار الاستقبال.
  const sid = 'sid-backchannel';
  const sessKey = await sessionKeyFor(sid);
  await kv.put(
    sessKey,
    JSON.stringify({
      sub: 'user-1',
      token: await signToken({ sub: 'user-1', iss: ISSUER, aud: PLATFORM, iat: now, exp: now + 900 }),
      exp: now + 900,
    }),
  );
  await kv.put(await userIndexKeyFor('user-1', sid), '1');

  /* الرمز يُوقَّع هنا كما يوقّعه المركز حرفياً — و`purpose` مكتوبة نصّاً لا
     مستوردة: تغييرها في أحد الطرفين دون الآخر يُبطل كل إشعار بلا رسالة
     تدلّ عليه، وهذا السطر هو ما يمسك ذلك. */
  const logoutToken = await signToken({
    sub: 'user-1',
    iss: ISSUER,
    aud: PLATFORM,
    purpose: 'backchannel-logout',
    iat: now,
    exp: now + 60,
  });

  const res = await handleBackchannelLogout(
    new Request(`${ORIGIN}/auth/backchannel-logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logoutToken }),
    }),
    env,
    config,
  );
  assert.equal(res.status, 200, 'المركز رُدّ إشعارُه');

  /* والعدد لا يُقارَن برقم ثابت: الفحوص قبله فتحت لهذا العضو جلساتٍ عدّة
     بدورات دخول كاملة، وإنهاؤها كلها هو المطلوب لا عيباً في العدّ — من خرج
     من المركز أراد إغلاق كل بابٍ فتحه، لا آخرَه وحده. فيُفحص أثرُه: لم
     يبقَ له مفتاح جلسة ولا دليل. */
  const { ended } = await res.json();
  assert.ok(ended >= 1, `لم يُنهَ شيء (${ended})`);
  const leftovers = [...kvStore.keys()].filter((k) => k.startsWith('usr:user-1:'));
  assert.deepEqual(leftovers, [], 'بقي دليلُ جلسةٍ بعد الإشعار');
  assert.equal(kvStore.has(sessKey), false, 'بقيت الجلسة بعد الإشعار');

  // وبعده لا تفتح الجلسة شيئاً: يُردّ صاحبها إلى المركز.
  const after = await authenticate(R('/', `naf_sid=${sid}`), env, config);
  assert.equal(after.user, undefined, 'الجلسة بقيت تفتح بعد الخروج من المركز');
  assert.equal(after.response.status, 302);

  // ورمز الدخول لا يصلح إشعاراً — وهو يصل إلى مسار عامّ لا حراسة عليه.
  const asSession = await handleBackchannelLogout(
    new Request(`${ORIGIN}/auth/backchannel-logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        logoutToken: await signToken({
          sub: 'user-1', iss: ISSUER, aud: PLATFORM, iat: now, exp: now + 900,
        }),
      }),
    }),
    env,
    config,
  );
  assert.equal(asSession.status, 401, 'رمز جلسة قُبل إشعارَ خروج');

  ok('إشعار الخروج الخلفي يُنهي الجلسة، ورمز الدخول لا يصلح إشعاراً');
}

// ── والمسار يبلغه المركز: مسجَّل قبل الوسيط كالخروج ──
{
  /* في هذه المنصة لا يُفتح المسار بقائمة `PUBLIC_PATHS` بل بترتيب التسجيل:
     `app.route('/auth', ssoRoutes)` يسبق `app.use('*', ssoMiddleware)`،
     فما في `ssoRoutes` لا يبلغه الحارس أصلاً — وهكذا الخروجُ نفسه.

     فيُفحص التسجيل لا القائمة: فحصٌ يسأل `isPublicPath` هنا يخضرّ لو نُقل
     المسار إلى ما بعد الوسيط، والمركز عندئذ يأخذ تحويلةً إلى باب الدخول
     مكان أن يُنهي الجلسة — ولا أحد يعلم. */
  const routes = await readFile(path.join(ROOT, 'src', 'routes', 'ssoCallback.ts'), 'utf8');
  assert.match(routes, /app\.post\(\s*'\/backchannel-logout'/, 'المسار غير مسجَّل في ssoRoutes');

  const index = await readFile(path.join(ROOT, 'src', 'index.ts'), 'utf8');
  const mounted = index.indexOf("app.route('/auth', ssoRoutes)");
  const guarded = index.indexOf("app.use('*', ssoMiddleware)");
  assert.ok(mounted !== -1 && guarded !== -1, 'تعذّر قراءة ترتيب التركيب');
  assert.ok(mounted < guarded, 'مسارات /auth صارت بعد الوسيط — فيُحرَس ما لا جلسة له');

  ok('مسار الإشعار يبلغه المركز — مسجَّل قبل الوسيط كالخروج');
}

/* العدد يُتحقَّق منه لا يُطبع وحده: فحصٌ يسقط من الملف بحذفٍ أو بخطأ في
   دمج يبقى العدّاد معه أقلّ، وسطرٌ يقول «١٦/١٧» يُقرأ نجاحاً بلمحة عين. */
// ── ٢١: ربط الدخول بالمتصفّح — الحالات الأربع كلُّها ──
//
// هجمةُ التثبيت: المهاجم يبدأ دخولاً بنفسه فيحصل على رمز عبورٍ صالح، ثم
// يدفع الضحيّة إلى `‎/auth/callback` به. فتُفتح في متصفّح الضحيّة جلسةٌ
// باسم المهاجم، وكلُّ ما تكتبه الضحيّة بعدها يقع في حساب المهاجم.
// والرمز صحيح والحالة صحيحة — فلا شيء قبل الربط يميّز الحالتين.
{
  // (أ) كوكي لا يطابق التجزئة العائدة: ردٌّ. هذا متصفّح الضحيّة.
  {
    failures.length = 0;
    const { response } = await authenticate(R('/'), env, config);
    const { code, state, next } = centerGo(response.headers.get('location'));  // تجزئةُ المهاجم
    const victim = `${bindCookieName(config)}=` + 'f'.repeat(64);              // سرُّ متصفّحٍ آخر
    const cb = await handleCallback(R(callbackUrl({ code, state, next }), victim), env, config);
    /* `bad_state` لا `auth_failed`: أكثرُ ما يقع هذا في لسان صاحبه لا في
       هجمة — بابان مفتوحان، فالثاني يكتب كوكياً فوق الأول ثم يعود الأول
       فلا يطابق. ونصُّها «انتهت جلسة دخولك. سجّل الدخول من جديد» ومعها
       زرُّ محاولةٍ تُجدي، وهو الصواب في الحالين. */
    assert.equal(cb.headers.get('location'), '/denied?r=bad_state', 'كوكي مخالف مرّ');
    assert.equal(
      setCookies(cb).some((c) => c.startsWith('naf_sid=') && !/Max-Age=0/.test(c)), false,
      'فُتحت جلسة رغم اختلاف الربط',
    );
  }

  // (ب) رمزٌ مربوط بلا كوكي أصلاً: ردٌّ كذلك — لا يكفي ألّا يملك المهاجم سرّاً.
  {
    const { response } = await authenticate(R('/'), env, config);
    const { code, state, next } = centerGo(response.headers.get('location'));
    const cb = await handleCallback(R(callbackUrl({ code, state, next })), env, config);
    assert.equal(cb.headers.get('location'), '/denied?r=bad_state', 'رمز مربوط بلا كوكي مرّ');
  }

  // (ج) مركزٌ أقدم لا يعرف `bind`: يُقبل الدخول كما كان — منصةٌ سبقت المركزَ
  //     في الترقية لا تنكسر. وهذا هو الفرع الذي يجعل هذا النشر آمناً بأي ترتيب.
  {
    centerOmitsBind = true;
    failures.length = 0;
    const { cb } = await browserLogin('/?view=members');
    centerOmitsBind = false;
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get('location'), '/?view=members', 'مركزٌ أقدم كسر الدخول');
    assert.deepEqual(failures, []);
  }

  // (د) دخولٌ بدأ من شبكة المركز — بطاقةٌ تقصد `‎/go/:id` مباشرةً، فلا كوكي
  //     ولا تجزئة. يُعاد البدء لفّةً واحدة إلى الوجهة المقصودة، لا إلى مسار
  //     الاستقبال ومعه رمزٌ استُهلك — وتلك تدور بلا نهاية.
  {
    const { code, state, next } = centerGo(`${ISSUER}/go/${PLATFORM}?next=/?view=members`);
    const cb = await handleCallback(R(callbackUrl({ code, state, next })), env, config);
    assert.equal(cb.status, 302);
    const loc = new URL(cb.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, `${ISSUER}/go/${PLATFORM}`, 'لم يُعَد البدء من المركز');
    assert.match(loc.searchParams.get('bind') ?? '', /^[a-f0-9]{64}$/, 'العودة بلا تجزئة');
    assert.equal(loc.searchParams.get('next'), '/?view=members', 'ضاعت الوجهة في لفّة الربط');
    assert.ok(cookieJar(cb).includes(`${bindCookieName(config)}=`), 'اللفّة لم تكتب الكوكي');
  }

  ok('الربط بالمتصفّح: مخالفٌ يُردّ، وغائبٌ يُردّ، ومركزٌ أقدم يمرّ، وبدءٌ من المركز يلتفّ لفّةً');
}

const EXPECTED = 21;
assert.equal(pass, EXPECTED, `عدد الفحوص ${pass} لا ${EXPECTED} — فحصٌ سقط أو أُضيف بلا تحديث العدد`);
console.log(`\n${pass}/${EXPECTED} فحصاً مرّت.`);
