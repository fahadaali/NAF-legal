/**
 * خادمُ التفويض لـ`/mcp` — OAuth 2.1 بقدر ما تحتاجه أدوات الذكاء الاصطناعي.
 *
 * `lib/oauth.ts` عميلٌ تفوِّض به المنصةُ نفسها عند خوادم غيرها. وهذا عكسه:
 * المنصة هنا خادمُ تفويضٍ لأداةٍ تطلب منها. فلا يُخلط الملفّان.
 *
 * ── المسار كاملاً ──
 *
 *   ١) الأداة تقرأ `/.well-known/oauth-protected-resource/mcp` ثم
 *      `/.well-known/oauth-authorization-server`، وتسجّل نفسها في
 *      `/oauth/register` (RFC 7591).
 *   ٢) تفتح للعضو `/oauth/authorize` بـPKCE. يُحفظ الطلب ويُحوَّل صاحبه إلى
 *      `/connect/{الطلب}` — بابا العضو والضيف (`naf-terms.md` §١٥).
 *   ٣) العضو يدخل من المركز ويسمح (`approveMember`)، أو الضيف يكتب بريده
 *      ورمز التحقق (`sendGuestCode` ثم `verifyGuestCode`). وفي الحالين يُصدر
 *      رمزُ تفويضٍ ويُعاد إلى الأداة.
 *   ٤) الأداة تبادله في `/oauth/token` برمزي وصولٍ وتجديد.
 *
 * ── ما يحرس كلَّ خطوة ──
 *
 * - **PKCE بـS256 إلزامي**، ولا سرَّ للأداة: هي عامّةٌ بطبيعتها (تطبيق سطح
 *   مكتب أو خادمُ مزوِّد)، وسرٌّ يُعطى لها لا يحرس شيئاً لا يحرسه PKCE.
 * - **عنوان الرجوع يُطابَق حرفياً** بما سُجّل، ولا يُحوَّل إلى عنوانٍ غير مسجّل
 *   ولو بخطأ: الخطأ قبل التحقّق منه يُعرض ولا يُحوَّل.
 * - **كلُّ رمزٍ مجزّأ في القاعدة** — رمز التفويض والوصول والتجديد ورمز التحقق.
 * - **رمز التفويض يُستعمل مرّة**: يُمحى بـ`DELETE … RETURNING` في الاستعلام
 *   الذي يقرؤه، فلا يُبادَل مرّتين ولو وصل الطلبان معاً.
 * - **رمز التجديد يُدوَّر**، وعودةُ المستعمَل منه علامةُ سرقةٍ تُلغي الربط كلَّه.
 * - **العضو يُفحص في كل طلب**: `members.is_active = 1`. فسحبُ وصوله من شاشة
 *   المستخدمين يقطع أداته في النداء التالي، لا عند انتهاء رمزها.
 * - **وللربط سقفٌ مطلق** (تسعون يوماً، مدّة «تذكّرني» في المركز): بعده يعود
 *   صاحبه فيدخل من المركز من جديد مهما جدّدت الأداة رمزها.
 */
import type { Env } from '../types';
import { uuid } from '../lib/crypto';
import { base64UrlFromBytes } from '../lib/sealed';
import type { McpPrincipal } from './protocol';

export const SCOPE = 'mcp';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const REQUEST_TTL = 15 * MIN;
export const CODE_TTL = 5 * MIN;
export const ACCESS_TTL = 60 * MIN;
export const REFRESH_TTL = 30 * DAY;
export const CONNECTION_TTL = 90 * DAY;
/**
 * مهلةُ إعادة رمز التجديد بعد تدويره.
 *
 * الأداة تُرسل رمز التجديد فيُدوَّر، ثم ينقطع الردّ في الطريق فتعيد إرساله —
 * وهي لم تستلم الزوج الجديد قط. وكشفُ الإعادة بلا مهلة كان يعدّ ذلك سرقةً
 * فيُلغي ربط العضو كلَّه ويعيده إلى الدخول من المركز بسبب شبكة. ففي الدقيقة
 * الأولى بعد التدوير تأخذ الإعادةُ زوجاً جديداً، وبعدها تُلغي الربط كما كانت.
 * وهي مهلةُ «إعادة الاستعمال» نفسها في خوادم التفويض الشائعة.
 */
export const REFRESH_RETRY_GRACE = 60_000;
export const GUEST_CODE_TTL = 10 * MIN;
/** محاولاتُ الرمز الواحد — ثم يُطلب رمزٌ جديد. */
export const GUEST_CODE_ATTEMPTS = 5;
/**
 * سقفا الضيف في نافذته، أيّاً كان الطلب الذي جاء منه (هجرة 0044).
 *
 * طلبُ التفويض يُنشئه أيُّ أحدٍ بلا حساب، فسقفٌ على الطلب وحده يُصفَّر بطلبٍ
 * جديد. وعلى الضيف: خمسةُ رموزٍ في الساعة تكفي من أخطأ بريده أو تأخّر عنه
 * البريد، وعشرُ محاولاتٍ خاطئة تُغلق التخمين — مليونُ احتمالٍ بعشرٍ في الساعة
 * لا يُصاب. وليس سقفاً على الاستخدام: من دخل لا يمرّ بهذا ثانيةً.
 */
export const GUEST_WINDOW = 60 * MIN;
export const GUEST_SENDS_PER_WINDOW = 5;
export const GUEST_FAILS_PER_WINDOW = 10;
/** «آخر نشاط» لا يُكتب في كل نداء — مرّةً كل خمس دقائق تكفي لعموده. */
const TOUCH_EVERY = 5 * MIN;

// ── أدوات صغيرة ──

export async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return base64UrlFromBytes(new Uint8Array(digest));
}

export function randomToken(bytes = 32): string {
  return base64UrlFromBytes(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** ستّة أرقامٍ لاتينية متساوية الاحتمال — بلا انحياز باقي القسمة. */
function sixDigits(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return String(buf[0] % 1_000_000).padStart(6, '0');
}

export function normalizeEmail(v: string): string {
  return v.trim().toLowerCase();
}

export function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
}

/** عنوان المورد الوحيد الذي تصدر له الرموز (RFC 8707). */
export function resourceUrl(origin: string): string {
  return `${origin}/mcp`;
}

// ── وثائق الاكتشاف ──

export function protectedResourceMetadata(origin: string, appName: string) {
  return {
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: [SCOPE],
    resource_name: appName,
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  };
}

// ── التسجيل الديناميكي (RFC 7591) ──

/**
 * عنوانُ رجوعٍ مقبول؟
 *
 * `https` لأيّ مضيف، و`http` للجهاز نفسه وحده (أدوات سطح المكتب تستقبل على
 * منفذٍ محلّي)، ومخطّطٌ خاصٌّ بتطبيقٍ أصليّ (`cursor://…`) كما تجيزه OAuth 2.1
 * — إلا المخطّطات التي تنفّذ شيئاً في المتصفّح. ولا جزءَ بعد `#`.
 */
export function acceptableRedirectUri(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash) return false;
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (scheme === 'https') return !!u.hostname;
  if (scheme === 'http') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (['javascript', 'data', 'file', 'vbscript', 'about', 'blob', 'ftp', 'ws', 'wss'].includes(scheme)) return false;
  return /^[a-z][a-z0-9+.-]*$/.test(scheme);
}

export type OAuthError = { error: string; error_description?: string };

export async function registerClient(
  env: Env,
  body: unknown
): Promise<{ ok: true; client: Record<string, unknown> } | { ok: false; err: OAuthError }> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
  if (!uris.length || uris.length > 10) {
    return { ok: false, err: { error: 'invalid_redirect_uri', error_description: 'redirect_uris is required (1–10)' } };
  }
  const bad = uris.find((u) => !acceptableRedirectUri(u));
  if (bad) return { ok: false, err: { error: 'invalid_redirect_uri', error_description: `Unsupported redirect URI: ${bad}` } };
  const grants = Array.isArray(b.grant_types) ? b.grant_types : ['authorization_code'];
  if (grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
    return { ok: false, err: { error: 'invalid_client_metadata', error_description: 'Unsupported grant_types' } };
  }
  // الاسم بيانات تُعرض في شاشة الإذن والإعدادات — يُقصّ ولا يُفسَّر.
  const name = typeof b.client_name === 'string' ? b.client_name.trim().slice(0, 100) || null : null;
  const id = uuid();
  const now = Date.now();
  await env.DB.prepare('INSERT INTO mcp_clients (id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, name, JSON.stringify(uris), now)
    .run();
  return {
    ok: true,
    client: {
      client_id: id,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: name ?? undefined,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // عامّةٌ دائماً — ولو طلبت الأداة سرّاً: PKCE هو الحارس (رأس الملف).
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    },
  };
}

async function getClient(env: Env, id: string) {
  const row = await env.DB.prepare('SELECT id, client_name, redirect_uris FROM mcp_clients WHERE id = ?')
    .bind(id)
    .first<{ id: string; client_name: string | null; redirect_uris: string }>();
  if (!row) return null;
  let uris: string[] = [];
  try {
    uris = JSON.parse(row.redirect_uris);
  } catch {}
  return { id: row.id, name: row.client_name, redirectUris: uris };
}

// ── طلب التفويض ──

export type AuthorizeOutcome =
  /** يُحوَّل صاحبه إلى بابي الدخول. */
  | { kind: 'door'; requestId: string }
  /** خطأٌ يُعاد إلى الأداة عبر عنوان رجوعها المتحقَّق منه. */
  | { kind: 'redirect'; location: string }
  /** خطأٌ قبل التحقّق من عنوان الرجوع — يُعرض ولا يُحوَّل. */
  | { kind: 'invalid'; message: string };

function withParams(base: string, params: Record<string, string | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

export async function startAuthorization(env: Env, q: URLSearchParams, origin: string): Promise<AuthorizeOutcome> {
  const clientId = q.get('client_id') ?? '';
  const redirectUri = q.get('redirect_uri') ?? '';
  const client = clientId ? await getClient(env, clientId) : null;
  if (!client) return { kind: 'invalid', message: 'unknown client_id' };
  // بلا `redirect_uri` يُقبل الوحيدُ المسجّل وحده — وإلا فالطلب ناقص.
  const target = redirectUri || (client.redirectUris.length === 1 ? client.redirectUris[0] : '');
  if (!target || !client.redirectUris.includes(target)) return { kind: 'invalid', message: 'redirect_uri mismatch' };

  const state = q.get('state') ?? undefined;
  const fail = (error: string, error_description: string): AuthorizeOutcome => ({
    kind: 'redirect',
    location: withParams(target, { error, error_description, state, iss: origin }),
  });
  if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be code');
  const challenge = q.get('code_challenge') ?? '';
  if (!challenge || q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    return fail('invalid_request', 'PKCE with S256 is required');
  }
  const resource = q.get('resource');
  if (resource && resource.replace(/\/+$/, '') !== resourceUrl(origin)) return fail('invalid_target', 'Unknown resource');
  const scope = q.get('scope');
  if (scope && !scope.split(/\s+/).every((s) => s === SCOPE || s === '')) return fail('invalid_scope', `Supported scope: ${SCOPE}`);

  const id = randomToken(18);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO mcp_auth_requests (id, client_id, redirect_uri, code_challenge, state, scope, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, client.id, target, challenge, state ?? null, SCOPE, now, now + REQUEST_TTL)
    .run();
  return { kind: 'door', requestId: id };
}

interface RequestRow {
  id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  scope: string | null;
  expires_at: number;
}

async function liveRequest(env: Env, id: string): Promise<RequestRow | null> {
  const row = await env.DB.prepare('SELECT * FROM mcp_auth_requests WHERE id = ?').bind(id).first<RequestRow>();
  if (!row || row.expires_at < Date.now()) return null;
  return row;
}

/**
 * النطاقُ الذي يعود إليه الإذن، كما يُعرض للعضو قبل «سماح».
 *
 * اسمُ الأداة تكتبه الأداة عن نفسها فيُنتحل؛ والنطاقُ لا يُنتحل — إليه يذهب
 * الرمز (`naf-terms.md` §١٥ — «وجهة الرجوع»). ولمخطّطٍ خاصٍّ بتطبيقٍ أصليّ
 * (`cursor://…`) لا نطاق، فيُعرض المخطّط نفسه.
 */
export function redirectHost(redirectUri: string): string {
  try {
    const u = new URL(redirectUri);
    return u.host || u.protocol.replace(/:$/, '');
  } catch {
    return redirectUri;
  }
}

/** ما تعرضه شاشتا الباب والإذن: اسمُ الأداة كما أعلنته، ونطاقُ رجوعها. */
export async function describeRequest(
  env: Env,
  id: string
): Promise<{ clientName: string | null; redirectHost: string } | null> {
  const row = await liveRequest(env, id);
  if (!row) return null;
  const client = await getClient(env, row.client_id);
  return { clientName: client?.name ?? null, redirectHost: redirectHost(row.redirect_uri) };
}

/** يُصدر رمز التفويض ويمحو الطلب، ويردّ عنوان الرجوع إلى الأداة. */
async function issueCode(
  env: Env,
  req: RequestRow,
  subject: { kind: 'member'; memberId: string } | { kind: 'guest'; guestId: string },
  origin: string
): Promise<string> {
  const code = randomToken(32);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO mcp_auth_codes (code_hash, client_id, redirect_uri, code_challenge, subject_kind, member_id, guest_id, scope, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      await sha256(code),
      req.client_id,
      req.redirect_uri,
      req.code_challenge,
      subject.kind,
      subject.kind === 'member' ? subject.memberId : null,
      subject.kind === 'guest' ? subject.guestId : null,
      req.scope,
      Date.now() + CODE_TTL
    ),
    env.DB.prepare('DELETE FROM mcp_auth_requests WHERE id = ?').bind(req.id),
    env.DB.prepare('DELETE FROM mcp_guest_codes WHERE request_id = ?').bind(req.id),
  ]);
  return withParams(req.redirect_uri, { code, state: req.state ?? undefined, iss: origin });
}

export type ApproveResult = { ok: true; redirect: string } | { ok: false; reason: 'expired' | 'inactive' };

/** العضو سمح — وقد مرّ بوسيط الدخول، فهويّته من المركز لا من الطلب. */
export async function approveMember(env: Env, requestId: string, memberId: string, origin: string): Promise<ApproveResult> {
  const req = await liveRequest(env, requestId);
  if (!req) return { ok: false, reason: 'expired' };
  const member = await env.DB.prepare('SELECT is_active FROM members WHERE user_id = ?')
    .bind(memberId)
    .first<{ is_active: number }>();
  if (!member || member.is_active !== 1) return { ok: false, reason: 'inactive' };
  return { ok: true, redirect: await issueCode(env, req, { kind: 'member', memberId }, origin) };
}

/**
 * صاحبُ الطلب رفض («إلغاء» في شاشة الإذن) — يُعاد إلى الأداة بـ`access_denied`
 * (RFC 6749 §4.1.2.1) فتعرف أنه رفض ولا تبقى تنتظر. والطلب يُمحى.
 */
export async function denyRequest(env: Env, requestId: string, origin: string): Promise<string | null> {
  const req = await liveRequest(env, requestId);
  if (!req) return null;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mcp_auth_requests WHERE id = ?').bind(req.id),
    env.DB.prepare('DELETE FROM mcp_guest_codes WHERE request_id = ?').bind(req.id),
  ]);
  return withParams(req.redirect_uri, { error: 'access_denied', state: req.state ?? undefined, iss: origin });
}

// ── الضيف ورمز التحقق ──

export type SendCodeResult =
  /** الردّ نفسه أُرسل الرمز أم لم يُرسل — لا يُكشف من هو ضيف (§١٥). */
  | { kind: 'sent' }
  /** البريد لعضو: يُعاد إلى باب الأعضاء ولا يُربط ضيفاً. */
  | { kind: 'member' }
  | { kind: 'expired' }
  | { kind: 'invalid_email' };

/**
 * يعدّ على الضيف في نافذته ويردّ العدّادين بعد العدّ — في استعلامٍ واحد ذرّي.
 *
 * وعباراتُ `SET` في SQLite تُحسب كلُّها من القيم قبل التحديث، فالنافذةُ
 * المنقضية تُقرأ قديمةً في الشروط الثلاثة ولا يسبق أحدُها غيره.
 */
async function bumpGuest(env: Env, guestId: string, field: 'sends' | 'fails'): Promise<{ sends: number; fails: number }> {
  const now = Date.now();
  const stale = now - GUEST_WINDOW;
  const row = await env.DB.prepare(
    `INSERT INTO mcp_guest_throttle (guest_id, window_start, sends, fails) VALUES (?, ?, ?, ?)
     ON CONFLICT(guest_id) DO UPDATE SET
       sends = CASE WHEN mcp_guest_throttle.window_start < ? THEN excluded.sends ELSE mcp_guest_throttle.sends + excluded.sends END,
       fails = CASE WHEN mcp_guest_throttle.window_start < ? THEN excluded.fails ELSE mcp_guest_throttle.fails + excluded.fails END,
       window_start = CASE WHEN mcp_guest_throttle.window_start < ? THEN excluded.window_start ELSE mcp_guest_throttle.window_start END
     RETURNING sends, fails`
  )
    .bind(guestId, now, field === 'sends' ? 1 : 0, field === 'fails' ? 1 : 0, stale, stale, stale)
    .first<{ sends: number; fails: number }>();
  return row ?? { sends: 0, fails: 0 };
}

/** المحاولاتُ الخاطئة في النافذة الجارية — بلا عدّ. */
async function guestFails(env: Env, guestId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT window_start, fails FROM mcp_guest_throttle WHERE guest_id = ?')
    .bind(guestId)
    .first<{ window_start: number; fails: number }>();
  return row && row.window_start >= Date.now() - GUEST_WINDOW ? row.fails : 0;
}

export async function sendGuestCode(env: Env, requestId: string, emailRaw: string): Promise<SendCodeResult> {
  const req = await liveRequest(env, requestId);
  if (!req) return { kind: 'expired' };
  const email = normalizeEmail(emailRaw);
  if (!looksLikeEmail(email)) return { kind: 'invalid_email' };

  const member = await env.DB.prepare('SELECT 1 AS x FROM members WHERE lower(email) = ? LIMIT 1').bind(email).first();
  if (member) return { kind: 'member' };

  const guest = await env.DB.prepare('SELECT id, email FROM mcp_guests WHERE email_norm = ?')
    .bind(email)
    .first<{ id: string; email: string }>();
  if (!guest) return { kind: 'sent' };

  // سقفٌ على الإرسال لا على الاستخدام: لا يصير البابُ أداةَ إغراقٍ لبريد أحد.
  // وتجاوزُه لا يُقال — الردّ واحدٌ في كل حال (§١٥).
  if ((await bumpGuest(env, guest.id, 'sends')).sends > GUEST_SENDS_PER_WINDOW) return { kind: 'sent' };

  const code = sixDigits();
  await env.DB.prepare(
    `INSERT INTO mcp_guest_codes (request_id, guest_id, code_hash, attempts, expires_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(request_id) DO UPDATE SET guest_id = excluded.guest_id, code_hash = excluded.code_hash,
       attempts = 0, expires_at = excluded.expires_at`
  )
    .bind(requestId, guest.id, await sha256(`${requestId}:${code}`), Date.now() + GUEST_CODE_TTL)
    .run();
  await sendCodeEmail(env, guest.email, code);
  return { kind: 'sent' };
}

/**
 * بريدُ رمز التحقق — نصّه من `naf-terms.md` §١٥.
 *
 * نصٌّ خالص لا HTML: لا ألوان ولا أنماط تُكتب (استثناء القوالب البريدية في
 * `CLAUDE.md` §١ لا يلزم أصلاً)، والرمز في سطرٍ وحده فيُنسخ كما هو. وبلا
 * مفتاح البريد يُكتب في السجلّ ولا يُكشف للضيف: ردُّ الإرسال واحدٌ في كل حال.
 */
async function sendCodeEmail(env: Env, to: string, code: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.error('mcp guest code: RESEND_API_KEY غير مضبوط — لم يُرسل الرمز');
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.NOTIFY_FROM || 'no-reply@naf-legal.app',
      to: [to],
      subject: 'رمز التحقق لربط مستشار ناف',
      text: `رمز التحقق: ${code} — صالح عشر دقائق، ولمرة واحدة.\n\n${code}\n\nلم تطلب هذا الرمز؟ تجاهل هذه الرسالة، ولن يُربط شيء.\n\n— مستشار ناف`,
    }),
  }).catch((e) => {
    console.error('mcp guest code: send failed', e);
    return null;
  });
  if (res && !res.ok) console.error(`mcp guest code: resend ${res.status} ${await res.text().catch(() => '')}`);
}

export type VerifyResult = { ok: true; redirect: string } | { ok: false; reason: 'wrong' | 'expired' };

export async function verifyGuestCode(
  env: Env,
  requestId: string,
  emailRaw: string,
  codeRaw: string,
  origin: string
): Promise<VerifyResult> {
  const req = await liveRequest(env, requestId);
  if (!req) return { ok: false, reason: 'expired' };
  const email = normalizeEmail(emailRaw);
  const code = codeRaw.replace(/\s+/g, '');
  const row = await env.DB.prepare(
    `SELECT g.guest_id, g.code_hash, g.expires_at, x.email_norm
     FROM mcp_guest_codes g JOIN mcp_guests x ON x.id = g.guest_id WHERE g.request_id = ?`
  )
    .bind(requestId)
    .first<{ guest_id: string; code_hash: string; expires_at: number; email_norm: string }>();
  // جملةٌ واحدة للخاطئ والمنتهي والمستنفد — «غير صحيح أو انتهت صلاحيته» (§١٥).
  if (!row || row.email_norm !== email || row.expires_at < Date.now()) return { ok: false, reason: 'wrong' };
  // الضيفُ استنفد محاولاته في النافذة: لا يُقارَن الرمز أصلاً، ولو كان صحيحاً.
  if ((await guestFails(env, row.guest_id)) >= GUEST_FAILS_PER_WINDOW) return { ok: false, reason: 'wrong' };
  // المحاولةُ تُعدّ قبل المقارنة وفي الاستعلام نفسه الذي يشترط السقف: نداءان
  // متزامنان لا يقرآن العدّاد نفسه فيتجاوزانه معاً.
  const claimed = await env.DB.prepare(
    'UPDATE mcp_guest_codes SET attempts = attempts + 1 WHERE request_id = ? AND attempts < ? RETURNING attempts'
  )
    .bind(requestId, GUEST_CODE_ATTEMPTS)
    .first();
  if (!claimed) return { ok: false, reason: 'wrong' };
  if (!/^\d{6}$/.test(code) || (await sha256(`${requestId}:${code}`)) !== row.code_hash) {
    await bumpGuest(env, row.guest_id, 'fails');
    return { ok: false, reason: 'wrong' };
  }
  return { ok: true, redirect: await issueCode(env, req, { kind: 'guest', guestId: row.guest_id }, origin) };
}

// ── نقطة الرموز ──

export type TokenResult = { ok: true; body: Record<string, unknown> } | { ok: false; status: number; err: OAuthError };

const grantErr = (error: string, error_description: string, status = 400): TokenResult => ({
  ok: false,
  status,
  err: { error, error_description },
});

async function issueTokens(env: Env, connectionId: string, connectionExpires: number): Promise<Record<string, unknown>> {
  const access = randomToken(32);
  const refresh = randomToken(32);
  const now = Date.now();
  const refreshExpires = Math.min(now + REFRESH_TTL, connectionExpires);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO mcp_tokens (token_hash, connection_id, kind, expires_at) VALUES (?, ?, ?, ?)').bind(
      await sha256(access),
      connectionId,
      'access',
      Math.min(now + ACCESS_TTL, connectionExpires)
    ),
    env.DB.prepare('INSERT INTO mcp_tokens (token_hash, connection_id, kind, expires_at) VALUES (?, ?, ?, ?)').bind(
      await sha256(refresh),
      connectionId,
      'refresh',
      refreshExpires
    ),
  ]);
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: Math.floor(Math.min(ACCESS_TTL, connectionExpires - now) / 1000),
    refresh_token: refresh,
    scope: SCOPE,
  };
}

/** صاحبُ الربط ما زال قائماً؟ عضوٌ نشِط، أو ضيفٌ لم يُحذف بريده. */
async function subjectAlive(env: Env, kind: string, memberId: string | null, guestId: string | null): Promise<boolean> {
  if (kind === 'member') {
    const m = await env.DB.prepare('SELECT is_active FROM members WHERE user_id = ?').bind(memberId).first<{ is_active: number }>();
    return m?.is_active === 1;
  }
  return !!(await env.DB.prepare('SELECT 1 AS x FROM mcp_guests WHERE id = ?').bind(guestId).first());
}

export async function exchangeToken(env: Env, form: URLSearchParams): Promise<TokenResult> {
  const grant = form.get('grant_type');

  if (grant === 'authorization_code') {
    const code = form.get('code') ?? '';
    const verifier = form.get('code_verifier') ?? '';
    if (!code || !verifier) return grantErr('invalid_request', 'code and code_verifier are required');
    // يُمحى في الاستعلام الذي يقرؤه: لا يُبادَل مرّتين ولو وصل الطلبان معاً.
    const row = await env.DB.prepare('DELETE FROM mcp_auth_codes WHERE code_hash = ? RETURNING *')
      .bind(await sha256(code))
      .first<{
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        subject_kind: string;
        member_id: string | null;
        guest_id: string | null;
        scope: string | null;
        expires_at: number;
      }>();
    if (!row || row.expires_at < Date.now()) return grantErr('invalid_grant', 'Invalid or expired code');
    const clientId = form.get('client_id');
    if (clientId && clientId !== row.client_id) return grantErr('invalid_grant', 'client_id mismatch');
    const redirectUri = form.get('redirect_uri');
    if (redirectUri && redirectUri !== row.redirect_uri) return grantErr('invalid_grant', 'redirect_uri mismatch');
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || (await sha256Base64Url(verifier)) !== row.code_challenge) {
      return grantErr('invalid_grant', 'PKCE verification failed');
    }
    if (!(await subjectAlive(env, row.subject_kind, row.member_id, row.guest_id))) {
      return grantErr('invalid_grant', 'Access revoked');
    }
    const client = await getClient(env, row.client_id);
    const id = uuid();
    const now = Date.now();
    const expires = now + CONNECTION_TTL;
    await env.DB.prepare(
      `INSERT INTO mcp_connections (id, client_id, client_name, subject_kind, member_id, guest_id, scope, created_at, last_used_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, row.client_id, client?.name ?? null, row.subject_kind, row.member_id, row.guest_id, row.scope, now, now, expires)
      .run();
    return { ok: true, body: await issueTokens(env, id, expires) };
  }

  if (grant === 'refresh_token') {
    const token = form.get('refresh_token') ?? '';
    if (!token) return grantErr('invalid_request', 'refresh_token is required');
    const hash = await sha256(token);
    const row = await env.DB.prepare(
      `SELECT t.connection_id, t.expires_at, t.used_at, c.client_id, c.subject_kind, c.member_id, c.guest_id,
              c.revoked_at, c.expires_at AS connection_expires
       FROM mcp_tokens t JOIN mcp_connections c ON c.id = t.connection_id
       WHERE t.token_hash = ? AND t.kind = 'refresh'`
    )
      .bind(hash)
      .first<{
        connection_id: string;
        expires_at: number;
        used_at: number | null;
        client_id: string;
        subject_kind: string;
        member_id: string | null;
        guest_id: string | null;
        revoked_at: number | null;
        connection_expires: number;
      }>();
    if (!row) return grantErr('invalid_grant', 'Invalid refresh token');
    const now = Date.now();
    if (row.used_at && now - row.used_at > REFRESH_RETRY_GRACE) {
      // رمزٌ دُوِّر ثم عاد بعد مهلة الإعادة: أحدُ حامليه ليس صاحبه. يُلغى الربط كلُّه.
      await revokeConnection(env, row.connection_id, 'refresh_reuse');
      return grantErr('invalid_grant', 'Refresh token reuse detected');
    }
    if (row.revoked_at || row.expires_at < now || row.connection_expires < now) {
      return grantErr('invalid_grant', 'Connection expired or revoked');
    }
    const clientId = form.get('client_id');
    if (clientId && clientId !== row.client_id) return grantErr('invalid_grant', 'client_id mismatch');
    if (!(await subjectAlive(env, row.subject_kind, row.member_id, row.guest_id))) {
      return grantErr('invalid_grant', 'Access revoked');
    }
    if (!row.used_at) {
      const mark = await env.DB.prepare('UPDATE mcp_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL')
        .bind(now, hash)
        .run();
      // طلبان متزامنان بالرمز نفسه: الأوّل يدوِّره، والثاني إعادةٌ في المهلة.
      if (!mark.meta.changes) {
        const again = await env.DB.prepare('SELECT used_at FROM mcp_tokens WHERE token_hash = ?').bind(hash).first<{ used_at: number | null }>();
        if (!again?.used_at || now - again.used_at > REFRESH_RETRY_GRACE) return grantErr('invalid_grant', 'Refresh token already used');
      }
    }
    // وإعادةٌ في المهلة تأخذ زوجاً جديداً ولا تُلغي الربط (انظر `REFRESH_RETRY_GRACE`).
    return { ok: true, body: await issueTokens(env, row.connection_id, row.connection_expires) };
  }

  return grantErr('unsupported_grant_type', 'Supported: authorization_code, refresh_token');
}

/** RFC 7009: إلغاءُ رمزٍ يُلغي ربطه كلَّه. والردّ ٢٠٠ في كل حال. */
export async function revokeByToken(env: Env, token: string): Promise<void> {
  if (!token) return;
  const row = await env.DB.prepare('SELECT connection_id FROM mcp_tokens WHERE token_hash = ?')
    .bind(await sha256(token))
    .first<{ connection_id: string }>();
  if (row) await revokeConnection(env, row.connection_id, 'owner');
}

export async function revokeConnection(env: Env, connectionId: string, reason: string): Promise<boolean> {
  const res = await env.DB.batch([
    env.DB.prepare('UPDATE mcp_connections SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL').bind(
      Date.now(),
      reason,
      connectionId
    ),
    env.DB.prepare('DELETE FROM mcp_tokens WHERE connection_id = ?').bind(connectionId),
  ]);
  return (res[0]?.meta.changes ?? 0) > 0;
}

// ── التحقق من رمز الوصول في كل طلب إلى `/mcp` ──

export async function principalFromToken(env: Env, token: string): Promise<McpPrincipal | null> {
  if (!token) return null;
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT c.id, c.client_name, c.subject_kind, c.member_id, c.guest_id, c.last_used_at
     FROM mcp_tokens t JOIN mcp_connections c ON c.id = t.connection_id
     WHERE t.token_hash = ? AND t.kind = 'access' AND t.expires_at > ?
       AND c.revoked_at IS NULL AND c.expires_at > ?`
  )
    .bind(await sha256(token), now, now)
    .first<{
      id: string;
      client_name: string | null;
      subject_kind: string;
      member_id: string | null;
      guest_id: string | null;
      last_used_at: number | null;
    }>();
  if (!row) return null;

  let principal: McpPrincipal | null = null;
  if (row.subject_kind === 'member' && row.member_id) {
    // وصولُ العضو يُقرأ في كل طلب: الموقوف لا يمرّ ولو بقي رمزه ساعة.
    const m = await env.DB.prepare(
      'SELECT local_user_id, role, display_name FROM members WHERE user_id = ? AND is_active = 1'
    )
      .bind(row.member_id)
      .first<{ local_user_id: string | null; role: string; display_name: string | null }>();
    if (m?.local_user_id) {
      principal = {
        kind: 'member',
        userId: m.local_user_id,
        memberId: row.member_id,
        role: m.role,
        name: m.display_name,
        clientName: row.client_name,
        tokenId: row.id,
      };
    }
  } else if (row.subject_kind === 'guest' && row.guest_id) {
    const g = await env.DB.prepare('SELECT email FROM mcp_guests WHERE id = ?').bind(row.guest_id).first<{ email: string }>();
    if (g) principal = { kind: 'guest', guestId: row.guest_id, email: g.email, clientName: row.client_name, tokenId: row.id };
  }
  if (!principal) return null;

  if (!row.last_used_at || now - row.last_used_at > TOUCH_EVERY) {
    await env.DB.prepare('UPDATE mcp_connections SET last_used_at = ? WHERE id = ?')
      .bind(now, row.id)
      .run()
      .catch(() => {});
  }
  return principal;
}

/** كنسُ المنتهي — من نبضة المؤقّت. لا شيء منه يُقرأ بعد انتهائه أصلاً. */
export async function purgeExpired(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mcp_auth_requests WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM mcp_auth_codes WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM mcp_guest_codes WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM mcp_tokens WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM mcp_guest_throttle WHERE window_start < ?').bind(now - GUEST_WINDOW),
    /* أداةٌ سجّلت نفسها ولم يتمّ لها ربطٌ في شهر: التسجيلُ مفتوحٌ لأيّ أحد،
       فبلا كنسٍ يكبر الجدول بكل محاولةٍ لم تكتمل. ومن عاد سجّل نفسه من جديد —
       الأداة تفعل ذلك آلياً حين لا يُعرف معرّفها. */
    env.DB.prepare(
      `DELETE FROM mcp_clients WHERE created_at < ?
         AND id NOT IN (SELECT client_id FROM mcp_connections)
         AND id NOT IN (SELECT client_id FROM mcp_auth_requests)
         AND id NOT IN (SELECT client_id FROM mcp_auth_codes)`
    ).bind(now - 30 * DAY),
  ]);
}
