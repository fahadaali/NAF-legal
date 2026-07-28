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
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { authenticate, handleCallback, reportAccessChange } from 'naf-auth';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ISSUER = 'https://naf-id.pages.dev';
const PLATFORM = 'NAF-legal';            // بحالة أحرفه — والمقارنة حرفية
const ORIGIN = 'https://naf-legal.naflaw-sa.workers.dev';
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

// functions/go/[id].js — يتجاهل أي state يصله ويولّد واحدة من عنده
function centerGo(url) {
  const u = new URL(url);
  const next = u.searchParams.get('next') || '/';
  const code = `CODE-${Math.random().toString(16).slice(2)}`;
  const state = `STATE-${Math.random().toString(16).slice(2)}`;
  centerKV.set(`code:${code}`, { userId: 'user-1', platformId: PLATFORM, state, next });
  return { code, state, next };
}

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
  return Response.json({ token, tokenType: 'Bearer', expiresIn: 900, next: raw.next ?? '/' });
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
  const { response } = await authenticate(R('/?view=members'), env, config);
  const { code, state } = centerGo(response.headers.get('location'));

  const cb = await handleCallback(R(`/auth/callback?code=${code}&state=${state}`), env, config);
  assert.equal(failures.length, 0, `المركز رفض: ${failures.join()}`);
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/?view=members');

  sessionCookie = cb.headers.get('set-cookie').split(';')[0];
  assert.match(sessionCookie, /^naf_sid=/);
  ok('التدفّق الكامل يمرّ ويعود إلى الوجهة المطلوبة');
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
  const { response } = await authenticate(R('/'), env, config);
  const { code, state } = centerGo(response.headers.get('location'));
  await handleCallback(R(`/auth/callback?code=${code}&state=${state}`), env, config);
  failures.length = 0;
  const replay = await handleCallback(R(`/auth/callback?code=${code}&state=${state}`), env, config);
  assert.equal(replay.headers.get('location'), '/denied?r=auth_failed');
  assert.deepEqual(failures, ['invalid_code']);
  ok('إعادة استعمال رمز العبور تفشل عند المركز');
}

// ── ٩: حالة لا تطابق ما خزّنه المركز ──
{
  failures.length = 0;
  const { response } = await authenticate(R('/'), env, config);
  const { code } = centerGo(response.headers.get('location'));
  const cb = await handleCallback(R(`/auth/callback?code=${code}&state=WRONG`), env, config);
  assert.equal(cb.headers.get('location'), '/denied?r=auth_failed');
  assert.deepEqual(failures, ['invalid_state']);
  ok('حالة لا تطابق ما خزّنه المركز تُرفض');
}

// ── ١٠: رمز منتهٍ يُبطل الجلسة في كل طلب ──
{
  const now = Math.floor(Date.now() / 1000);
  const stale = await signToken({ sub: 'user-1', iss: ISSUER, aud: PLATFORM, iat: now - 1200, exp: now - 600 });
  kvStore.set('sess:stale', JSON.stringify({ sub: 'user-1', token: stale, exp: now - 600 }));
  const { user, response } = await authenticate(R('/api/conversations', 'naf_sid=stale'), env, config);
  assert.equal(user, undefined, 'رمز منتهٍ لا يمرّ');
  assert.equal(response.status, 401);
  assert.equal(kvStore.has('sess:stale'), false, 'الجلسة تُمسح');
  ok('رمز منتهٍ يُبطل الجلسة في كل طلب محمي');
}

// ── ١١: رمز صادر لمنصة أخرى ──
{
  const now = Math.floor(Date.now() / 1000);
  const other = await signToken({ sub: 'user-1', iss: ISSUER, aud: 'NAF-Forms', iat: now, exp: now + 900 });
  kvStore.set('sess:other', JSON.stringify({ sub: 'user-1', token: other, exp: now + 900 }));
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
  kvStore.set('sess:off', JSON.stringify({
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
    const { response } = await authenticate(R('/'), env, config);
    const { code, state } = centerGo(response.headers.get('location'));
    centerKV.get(`code:${code}`).next = hostile;      // مركزٌ مخترَق يعيد وجهة عدائية
    const cb = await handleCallback(R(`/auth/callback?code=${code}&state=${state}`), env, config);
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

/* العدد يُتحقَّق منه لا يُطبع وحده: فحصٌ يسقط من الملف بحذفٍ أو بخطأ في
   دمج يبقى العدّاد معه أقلّ، وسطرٌ يقول «١٦/١٧» يُقرأ نجاحاً بلمحة عين. */
const EXPECTED = 18;
assert.equal(pass, EXPECTED, `عدد الفحوص ${pass} لا ${EXPECTED} — فحصٌ سقط أو أُضيف بلا تحديث العدد`);
console.log(`\n${pass}/${EXPECTED} فحصاً مرّت.`);
