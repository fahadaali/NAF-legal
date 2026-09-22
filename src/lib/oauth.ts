/**
 * عميلُ OAuth 2.1 لخوادم MCP — منحةُ الآلة أوّلاً.
 *
 * أثبت السبرُ أن خادم الشاملة يُعلن `client_credentials` بين منحه، ومعها
 * `registration_endpoint`. وهما معاً يفتحان باباً لا إنسانَ فيه: تُسجَّل
 * المنصةُ عميلاً، فتأخذ رمزاً باسمها هي. ولا رحلةَ متصفّح، ولا `state`،
 * ولا كوكي ربط، ولا PKCE — وأهمُّ من ذلك: **لا رمزَ مسحوبٌ من حساب إنسانٍ
 * بعينه يخدم كلَّ مستخدمي المنصة**، وهو تحفّظٌ لا يُحلّ بكود.
 *
 * والذي لا تقوله بياناتُ الخادم: هل يقبل **موردُ** MCP رمزاً بلا صاحب.
 * الخادم يُعلن المنحة، وقبولُ المورد لها شيءٌ آخر — فلذلك لا يُقال «مربوط»
 * هنا إلا بعد نداءٍ حقيقيّ على الأداة، لا بعد رمزٍ وصل.
 *
 * وإن رفض المورد فالتسجيلُ الديناميّ في مكانه: منحةُ الإذن في المتصفّح
 * تحتاجه هي الأخرى، فلا شيءَ مما هنا يُهدر على التقديرين.
 *
 * **والرمي:** ما يُنادى من مسار MCP (`accessTokenFor`) لا يرمي أبداً ويردّ
 * `null` — كبقيّة ذلك المسار. وما يُنادى من طريقٍ يملك مُعالِجَ أخطاء
 * (`authorizeMachine`) يردّ نتيجةً موصوفة، ولا يرمي كذلك: شاشةُ المسؤول
 * تقرأ سببَ التعذّر، ولا تُقرأ أخطاءُ العامل في سجلّ.
 */
import type { Env } from '../types';
import type { ExternalSource } from './sources';
import type { DiscoveredAuth } from './discover';
import { seal, unseal, base64UrlFromBytes } from './sealed';
import { callTool } from './mcp';

export type AuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

export interface RegisteredClient {
  clientId: string;
  clientSecret: string | null;
  authMethod: AuthMethod;
  /** المُصدِر الذي سُجّل عنده — فتبديلُه يُبطل التسجيل ولا يُستعمل بعده. */
  issuer: string;
  registeredAt: number;
}

export interface TokenSet {
  accessToken: string;
  /** ملّي ثانية — أو `null` إن لم يُرسل الخادم `expires_in`. */
  expiresAt: number | null;
  scope: string | null;
  refreshToken?: string | null;
}

/** ما يُحفظ بين شقَّي الرحلة، مفتاحُه بصمةُ `state` لا `state` نفسه. */
export interface PendingAuth {
  sourceId: string;
  verifier: string;
  redirectUri: string;
  issuer: string;
  tokenEndpoint: string;
  resource: string | null;
  scope: string | null;
  /** بصمةُ سرِّ الكوكي — فلا يكفي أن يكون الزائرُ مسؤولاً، بل أن يكون البادئ. */
  bindHash: string;
  /** هل يُتحقَّق من `iss` في الردّ (RFC 9207) — بحسب ما أعلنه الخادم. */
  checkIss: boolean;
  createdAt: number;
}

/** هامشٌ قبل الانتهاء: انحرافُ الساعات وزمنُ الطلب نفسه. */
const SKEW_MS = 60_000;
/** سقفُ ما يُقرأ من ردٍّ — ردُّ رمزٍ أكبر من هذا ليس ردَّ رمز. */
const BODY_MAX = 64 * 1024;

const clientKey = (id: string) => `mcpoauth:cli:${id}`;
/* مفتاحُ الحالة **بصمتُها** لا هي: مسحُ المساحة يجب ألّا يُسلّم قدرةً حيّة —
   وهي حجّةُ `sessionKeyFor` نفسها في حزمة الدخول الموحّد. */
const stateKey = (hash: string) => `mcpoauth:st:${hash}`;
/** عمرُ الحالة: صفحةُ إذنٍ قد تسبقها صفحةُ دخولٍ عند الخادم، فعشرُ دقائق. */
const STATE_TTL_S = 600;
export const BIND_COOKIE = 'naf_mcp_bind';
const tokenKey = (id: string) => `mcpoauth:tok:${id}`;

export interface OAuthFail {
  ok: false;
  message: string;
}

/** ما تردّه محاولةُ التفويض إلى الشاشة. */
export interface MachineGrantResult {
  ok: boolean;
  /** خطواتٌ تُقرأ بالترتيب — فيُعرف أين وقف، لا أنه وقف. */
  steps: string[];
  clientId?: string;
  authMethod?: AuthMethod;
  expiresAt?: number | null;
  scope?: string | null;
  /** عددُ النتائج من نداءٍ حقيقيّ — هو وحده ما يُصيّر الحال «مربوط». */
  hits?: number;
  error?: string;
}

function reason(e: unknown): string {
  if (e instanceof Error) return e.name === 'TimeoutError' ? 'انقضت المهلة' : e.message;
  return String(e);
}

/** قراءةُ جسمٍ بسقف — ولا JSON.parse على ما لم يُقَس. */
async function readJson(res: Response): Promise<any | null> {
  try {
    const text = await res.text();
    if (text.length > BODY_MAX) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** يختار طريقةَ مصادقةٍ مما يُعلنه الخادم — وترتيبُ التفضيل مكتوب. */
function pickAuthMethod(supported: string[] | undefined): AuthMethod {
  /* `client_secret_post` أوّلاً لا `client_secret_basic`: الثانية تقتضي
     ترميزَ المعرّف والسرّ بترميز النسبة **قبل** base64 (RFC 6749 §2.3.1)،
     وهي خطوةٌ تُنسى فيصير الخطأ «اعتمادٌ مرفوض» بلا دلالة. والأولى مُعلَنةٌ
     هنا، وأبسطُ ما يصحّ خيرٌ مما يصحّ بشرط. */
  if (!supported || supported.includes('client_secret_post')) return 'client_secret_post';
  if (supported.includes('client_secret_basic')) return 'client_secret_basic';
  return 'none';
}

/** ترويسةُ الاعتماد وحقولُه — بحسب الطريقة المتّفق عليها. */
function applyClientAuth(
  client: RegisteredClient,
  body: URLSearchParams,
  headers: Record<string, string>
): void {
  body.set('client_id', client.clientId);
  if (client.authMethod === 'client_secret_post' && client.clientSecret) {
    body.set('client_secret', client.clientSecret);
  } else if (client.authMethod === 'client_secret_basic' && client.clientSecret) {
    /* ترميزُ النسبة قبل base64 — نصُّ RFC 6749 §2.3.1. وبدونه يسقط كلُّ سرٍّ
       فيه محرفٌ خارج المجموعة غير المحجوزة. */
    const raw = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`;
    const bytes = new TextEncoder().encode(raw);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    headers.authorization = `Basic ${btoa(binary)}`;
  }
}

/**
 * تسجيلٌ ديناميّ (RFC 7591).
 *
 * و`client_name` بالحروف اللاتينية عمداً: الحقل يقبل العربية بنصّ المواصفة،
 * وشاشاتُ الموافقة تُعطبها كثيراً — واسمٌ مشوَّه في شاشةِ خادمٍ أجنبيّ لا
 * نملك إصلاحه.
 */
export interface RegisterOptions {
  grantTypes?: string[];
  redirectUris?: string[];
  scope?: string | null;
}

export async function registerClient(
  found: DiscoveredAuth,
  timeoutMs: number,
  opts: RegisterOptions = {}
): Promise<RegisteredClient | OAuthFail> {
  if (!found.registrationEndpoint) {
    return { ok: false, message: 'الخادم لا يقبل تسجيلاً ديناميّاً' };
  }
  const grantTypes = opts.grantTypes ?? ['client_credentials'];
  const redirects = opts.redirectUris ?? [];
  /* وعميلُ المتصفّح عامٌّ بلا سرّ حيث أمكن: `none` هي ما توصي به OAuth 2.1
     لعميلٍ يحمل PKCE، والسرُّ الذي لا يُحتاج إليه اعتمادٌ يُحرَس بلا فائدة.
     وعميلُ الآلة لا يصحّ عامّاً — من ملك معرّفه انتحله. */
  const wantsSecret = grantTypes.includes('client_credentials');
  const method: AuthMethod = wantsSecret
    ? pickAuthMethod(found.tokenEndpointAuthMethodsSupported)
    : found.tokenEndpointAuthMethodsSupported?.includes('none') === false
      ? pickAuthMethod(found.tokenEndpointAuthMethodsSupported)
      : 'none';
  let res: Response;
  try {
    res = await fetch(found.registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'NAF Legal',
        grant_types: grantTypes,
        /* و`redirect_uris` للمنح المحوِّلة وحدها: منحةُ الآلة لا تُحوّل
           متصفّحاً، والمواصفة تُلزم بالعناوين حيث يقع التحويل. */
        response_types: grantTypes.includes('authorization_code') ? ['code'] : [],
        ...(redirects.length ? { redirect_uris: redirects } : {}),
        token_endpoint_auth_method: method,
        ...(opts.scope
          ? { scope: opts.scope }
          : found.scopesSupported?.length
            ? { scope: found.scopesSupported.join(' ') }
            : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, message: `تسجيل العميل: ${reason(e)}` };
  }

  const body = await readJson(res);
  if (!res.ok) {
    const detail = body?.error_description ?? body?.error ?? '';
    return { ok: false, message: `تسجيل العميل ${res.status}${detail ? ` · ${detail}` : ''}` };
  }
  if (typeof body?.client_id !== 'string' || !body.client_id) {
    return { ok: false, message: 'تسجيل العميل: ردٌّ بلا معرّف عميل' };
  }
  /* والطريقةُ تُؤخذ من ردّ الخادم لا من طلبنا: هو يُصدر البيانات المسجَّلة
     وقد يُبدّلها، فالعملُ بما طلبناه يجعل كلَّ طلب رمزٍ يُرفض بلا دلالة. */
  const echoed = body.token_endpoint_auth_method;
  const authMethod: AuthMethod =
    echoed === 'client_secret_basic' || echoed === 'client_secret_post' || echoed === 'none'
      ? echoed
      : method;
  return {
    clientId: body.client_id,
    clientSecret: typeof body.client_secret === 'string' ? body.client_secret : null,
    authMethod,
    issuer: found.issuer ?? found.authorizationServers[0] ?? '',
    registeredAt: Date.now(),
  };
}

/** رمزٌ بمنحة الآلة — ومعه `resource` (RFC 8707) دائماً. */
export async function machineToken(
  found: DiscoveredAuth,
  client: RegisteredClient,
  timeoutMs: number
): Promise<TokenSet | OAuthFail> {
  if (!found.tokenEndpoint) return { ok: false, message: 'لا نقطة رمزٍ في بيانات الخادم' };

  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  /* `resource` يُرسَل على كلّ طلب رمز، وقيمتُه ما سمّته **وثيقةُ الموارد**
     لا عنوانُ المصدر عندنا: قد يفترقان بشرطةٍ أخيرة، والخادم يقارن حرفياً. */
  const resource = found.resource;
  if (resource) body.set('resource', resource);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  applyClientAuth(client, body, headers);

  let res: Response;
  try {
    res = await fetch(found.tokenEndpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, message: `طلب الرمز: ${reason(e)}` };
  }

  const data = await readJson(res);
  if (!res.ok) {
    const detail = data?.error_description ?? data?.error ?? '';
    return { ok: false, message: `طلب الرمز ${res.status}${detail ? ` · ${detail}` : ''}` };
  }
  if (typeof data?.access_token !== 'string' || !data.access_token) {
    return { ok: false, message: 'طلب الرمز: ردٌّ بلا رمز وصول' };
  }
  /* ونوعٌ غير `Bearer` يُرفض: لا نعرف إرسال غيره، وإرسالُه حاملاً يُنتج
     ٤٠١ غامضة بدل سببٍ مقروء. */
  if (typeof data.token_type === 'string' && data.token_type.toLowerCase() !== 'bearer') {
    return { ok: false, message: `نوعُ رمزٍ لا يُدعم: ${data.token_type}` };
  }
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : null;
  return {
    accessToken: data.access_token,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
    scope: typeof data.scope === 'string' ? data.scope : null,
  };
}

async function storeToken(env: Env, sourceId: string, token: TokenSet): Promise<void> {
  const slot = tokenKey(sourceId);
  const sealed = await seal(env, slot, token);
  if (!sealed) return;
  /* عمرُ المفتاح عمرُ الرمز ناقصَ الهامش — ومنتهٍ في KV خيرٌ من منتهٍ عند
     الخادم: الأول يُعاد سكُّه صامتاً، والثاني ٤٠١ في وجه مستخدم. */
  const ttl = token.expiresAt
    ? Math.max(60, Math.floor((token.expiresAt - Date.now() - SKEW_MS) / 1000))
    : undefined;
  await env.KV.put(slot, sealed, ttl ? { expirationTtl: ttl } : {}).catch(() => {});
}

async function storedClient(env: Env, sourceId: string): Promise<RegisteredClient | null> {
  const slot = clientKey(sourceId);
  const raw = await env.KV.get(slot).catch(() => null);
  return unseal<RegisteredClient>(env, slot, raw);
}

/**
 * الرمزُ الصالح الآن — من المخزن، أو يُسَكّ من العميل المسجَّل.
 *
 * ولا يرمي: يُنادى من مسار MCP، وسياستُه أن مصدراً ساقطاً يُنقص التغطية
 * ولا يُسقط استشارة.
 */
export async function accessTokenFor(env: Env, source: ExternalSource): Promise<string | null> {
  try {
    const slot = tokenKey(source.id);
    const cached = await unseal<TokenSet>(env, slot, await env.KV.get(slot).catch(() => null));
    if (cached && (!cached.expiresAt || cached.expiresAt - Date.now() > SKEW_MS)) {
      return cached.accessToken;
    }
    /* ورمزُ تجديدٍ محفوظ يُقدَّم على سكٍّ جديد: منحةُ الإذن لا تُعاد بلا
       إنسان، فإسقاطُها إلى منحة الآلة يُخرج المصدر من الخدمة بلا داعٍ. */
    if (cached?.refreshToken) {
      const renewed = await refreshWith(env, source, cached);
      if (renewed) return renewed.accessToken;
      return null;
    }
    const client = await storedClient(env, source.id);
    if (!client) return null;
    const found = await cachedDiscovery(env, source.id);
    if (!found) return null;
    const minted = await machineToken(found, client, source.timeoutMs);
    if ('ok' in minted) {
      console.error(`oauth ${source.id}: ${minted.message}`);
      return null;
    }
    await storeToken(env, source.id, minted);
    return minted.accessToken;
  } catch (e) {
    console.error(`oauth ${source.id}: ${reason(e)}`);
    return null;
  }
}

const discoveryKey = (id: string) => `mcpoauth:as:${id}`;
/** بياناتُ الخادم عامّةٌ فلا تُختم — وتُخزَّن ليُسَكّ الرمز بلا سبرٍ جديد. */
async function cachedDiscovery(env: Env, sourceId: string): Promise<DiscoveredAuth | null> {
  try {
    const raw = await env.KV.get(discoveryKey(sourceId));
    return raw ? (JSON.parse(raw) as DiscoveredAuth) : null;
  } catch {
    return null;
  }
}

export async function rememberDiscovery(env: Env, sourceId: string, found: DiscoveredAuth): Promise<void> {
  await env.KV.put(discoveryKey(sourceId), JSON.stringify(found), { expirationTtl: 86400 }).catch(() => {});
}

/** يمحو ما خُتم لمصدر — «سحب التفويض». */
export async function forget(env: Env, sourceId: string): Promise<void> {
  await Promise.all([
    env.KV.delete(clientKey(sourceId)).catch(() => {}),
    env.KV.delete(tokenKey(sourceId)).catch(() => {}),
  ]);
}

/**
 * «بدء التفويض» بمنحة الآلة: تسجيلٌ ثم رمزٌ ثم **نداءٌ حقيقيّ**.
 *
 * والنداءُ شرطٌ لا زينة: الخادم يُعلن المنحة، وقبولُ موردِ MCP لرمزٍ بلا
 * صاحبٍ مسألةٌ أخرى. فلا يُقال «مربوط» حتى تعود نتيجةٌ من الأداة.
 */
export async function authorizeMachine(
  env: Env,
  source: ExternalSource,
  found: DiscoveredAuth
): Promise<MachineGrantResult> {
  const steps: string[] = [];
  const grants = found.grantTypesSupported;
  if (grants && !grants.includes('client_credentials')) {
    return { ok: false, steps, error: 'الخادم لا يُعلن منحة الآلة (client_credentials)' };
  }

  let client = await storedClient(env, source.id);
  if (client && found.issuer && client.issuer && client.issuer !== found.issuer) {
    steps.push('المُصدِر تبدّل — يُعاد التسجيل');
    client = null;
  }
  if (!client) {
    const made = await registerClient(found, source.timeoutMs);
    if ('ok' in made) return { ok: false, steps, error: made.message };
    client = made;
    const sealed = await seal(env, clientKey(source.id), client);
    if (!sealed) return { ok: false, steps, error: 'تعذّر ختم اعتماد العميل — AUTH_CLIENT_SECRET غير مضبوط؟' };
    await env.KV.put(clientKey(source.id), sealed).catch(() => {});
    steps.push(`سُجّل العميل (${client.authMethod})`);
  } else {
    steps.push('عميلٌ مسجَّلٌ من قبل — يُعاد استعماله');
  }

  const token = await machineToken(found, client, source.timeoutMs);
  if ('ok' in token) {
    return { ok: false, steps, clientId: client.clientId, authMethod: client.authMethod, error: token.message };
  }
  await storeToken(env, source.id, token);
  steps.push('وصل رمزُ وصول');

  /* النداءُ الحقيقيّ — بمصدرٍ صوريّ نوعُه «رمز حامل»: الصفُّ في القاعدة قد
     يكون على نوعٍ آخر بعد، وهذا يجرّب الرمز لا الإعداد. */
  const probe: ExternalSource = { ...source, authScheme: 'bearer', tokenKey: 'oauth' };
  const args: Record<string, unknown> = {
    ...source.args,
    [source.queryField]: 'الإجارة',
    ...(source.limitField ? { [source.limitField]: 1 } : {}),
  };
  const outcome = await callTool(env, probe, token.accessToken, source.searchTool, args);
  if (!outcome.ok) {
    return {
      ok: false,
      steps,
      clientId: client.clientId,
      authMethod: client.authMethod,
      expiresAt: token.expiresAt,
      scope: token.scope,
      error: `المورد ردّ على الرمز: ${outcome.message}`,
    };
  }
  steps.push('المورد قبل الرمز');
  const data: any = outcome.data;
  const hits = Array.isArray(data?.results) ? data.results.length : Array.isArray(data) ? data.length : 0;
  await rememberDiscovery(env, source.id, found);
  return {
    ok: true,
    steps,
    clientId: client.clientId,
    authMethod: client.authMethod,
    expiresAt: token.expiresAt,
    scope: token.scope,
    hits,
  };
}

// ══════════ منحةُ الإذن في المتصفّح ══════════

const encoder = new TextEncoder();

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function sha256Hex(value: string): Promise<string> {
  return [...(await sha256(value))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * زوجُ PKCE بـS256 (RFC 7636).
 *
 * والمُثبِت ٦٤ محرفاً ستّ عشريّاً — داخل مجال المواصفة (٤٣–١٢٨) ومن المجموعة
 * غير المحجوزة كلُّه. **ولا تراجعَ إلى `plain` أبداً**: خادمٌ لا يُعلن S256
 * يُرَدّ، لا يُنزَل إليه.
 */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomHex(32);
  return { verifier, challenge: base64UrlFromBytes(await sha256(verifier)) };
}

/**
 * النطاقُ المطلوب، بترتيب المواصفة:
 * نطاقُ التحدّي، فإن غاب فـ`scopes_supported` من وثيقة الموارد، فإن غابت
 * فلا يُرسَل نطاقٌ أصلاً — ويُترك للخادم افتراضُه.
 */
export function scopeFor(found: DiscoveredAuth, challengeScope?: string | null): string | null {
  if (challengeScope) return challengeScope;
  if (found.scopesSupported?.length) return found.scopesSupported.join(' ');
  return null;
}

export interface StartedAuth {
  url: string;
  bindSecret: string;
}

/**
 * يبدأ الرحلة: يُسجّل عميلاً إن لزم، ويولّد PKCE وحالةً، ويبني العنوان.
 *
 * و`resource` يُرسَل على طلب التفويض **وعلى طلب الرمز** — تُلزم به المواصفة
 * «regardless of whether authorization servers support it»، وقيمتُه المعرّفُ
 * القانونيّ من وثيقة الموارد.
 */
export async function startAuthorization(
  env: Env,
  source: ExternalSource,
  found: DiscoveredAuth,
  redirectUri: string,
  challengeScope?: string | null
): Promise<StartedAuth | OAuthFail> {
  if (!found.authorizationEndpoint || !found.tokenEndpoint) {
    return { ok: false, message: 'بيانات الخادم بلا نقطة تفويضٍ أو نقطة رمز' };
  }
  /* S256 شرطٌ لا يُتنازل عنه: النزولُ إلى `plain` يُبطل حمايةَ الاعتراض كلَّها. */
  if (found.codeChallengeMethodsSupported && !found.codeChallengeMethodsSupported.includes('S256')) {
    return { ok: false, message: 'الخادم لا يدعم S256 — ولا نزولَ إلى plain' };
  }

  const scope = scopeFor(found, challengeScope);
  let client = await storedClient(env, source.id);
  if (client && found.issuer && client.issuer && client.issuer !== found.issuer) client = null;
  if (!client) {
    const made = await registerClient(found, source.timeoutMs, {
      grantTypes: ['authorization_code', 'refresh_token'],
      redirectUris: [redirectUri],
      scope,
    });
    if ('ok' in made) return made;
    client = made;
    const sealed = await seal(env, clientKey(source.id), client);
    if (!sealed) return { ok: false, message: 'تعذّر ختم اعتماد العميل' };
    await env.KV.put(clientKey(source.id), sealed).catch(() => {});
  }

  const { verifier, challenge } = await pkcePair();
  const state = randomHex(32);
  const bindSecret = randomHex(32);
  const pending: PendingAuth = {
    sourceId: source.id,
    verifier,
    redirectUri,
    issuer: found.issuer ?? found.authorizationServers[0] ?? '',
    tokenEndpoint: found.tokenEndpoint,
    resource: found.resource ?? null,
    scope,
    bindHash: await sha256Hex(bindSecret),
    checkIss: found.authorizationResponseIssParameterSupported === true,
    createdAt: Date.now(),
  };
  const slot = stateKey(await sha256Hex(state));
  const sealedState = await seal(env, slot, pending);
  if (!sealedState) return { ok: false, message: 'تعذّر ختم حالة التفويض' };
  await env.KV.put(slot, sealedState, { expirationTtl: STATE_TTL_S }).catch(() => {});

  const url = new URL(found.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (pending.resource) url.searchParams.set('resource', pending.resource);
  if (scope) url.searchParams.set('scope', scope);
  await rememberDiscovery(env, source.id, found);
  return { url: url.toString(), bindSecret };
}

export interface CompletedAuth {
  ok: boolean;
  sourceId?: string;
  error?: string;
}

/**
 * يُتمّ الرحلة: يتحقّق من الحالة ويستهلكها، ثم يُبادل الرمز.
 *
 * والحالة تُقرأ وتُمحى **قبل** المبادلة: إعادةٌ تصل في أثنائها لا تجد شيئاً.
 */
export async function completeAuthorization(
  env: Env,
  state: string,
  code: string,
  bindSecret: string | null,
  issFromServer: string | null
): Promise<CompletedAuth> {
  if (!state || !code) return { ok: false, error: 'ردٌّ بلا حالةٍ أو بلا رمز' };
  const slot = stateKey(await sha256Hex(state));
  const raw = await env.KV.get(slot).catch(() => null);
  await env.KV.delete(slot).catch(() => {});
  const pending = await unseal<PendingAuth>(env, slot, raw);
  if (!pending) return { ok: false, error: 'حالةٌ غير معروفة أو انقضت' };

  if (!bindSecret || (await sha256Hex(bindSecret)) !== pending.bindHash) {
    return { ok: false, sourceId: pending.sourceId, error: 'الردّ وصل من متصفّحٍ غير الذي بدأ' };
  }
  /* RFC 9207: خادمٌ يُعلن إرسال `iss` يُتحقَّق منه — وهو ما يمنع خلطَ الردود
     بين خادمَي تفويض. والشاملة تُعلنه، فالتحقّق واجبٌ لا احتياط. */
  if (pending.checkIss) {
    const norm = (v: string) => v.replace(/\/+$/, '');
    if (!issFromServer || norm(issFromServer) !== norm(pending.issuer)) {
      return { ok: false, sourceId: pending.sourceId, error: `المُصدِر في الردّ لا يطابق: ${issFromServer ?? 'غائب'}` };
    }
  }

  const client = await storedClient(env, pending.sourceId);
  if (!client) return { ok: false, sourceId: pending.sourceId, error: 'اعتماد العميل غير موجود' };

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.verifier,
  });
  if (pending.resource) body.set('resource', pending.resource);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  applyClientAuth(client, body, headers);

  let res: Response;
  try {
    res = await fetch(pending.tokenEndpoint, { method: 'POST', headers, body: body.toString(), signal: AbortSignal.timeout(15000) });
  } catch (e) {
    return { ok: false, sourceId: pending.sourceId, error: `مبادلة الرمز: ${reason(e)}` };
  }
  const data = await readJson(res);
  if (!res.ok || typeof data?.access_token !== 'string') {
    const detail = data?.error_description ?? data?.error ?? '';
    return { ok: false, sourceId: pending.sourceId, error: `مبادلة الرمز ${res.status}${detail ? ` · ${detail}` : ''}` };
  }
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : null;
  await storeToken(env, pending.sourceId, {
    accessToken: data.access_token,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
    scope: typeof data.scope === 'string' ? data.scope : pending.scope,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
  });
  return { ok: true, sourceId: pending.sourceId };
}

/**
 * تجديدٌ برمز التجديد.
 *
 * **ورمزُ تجديدٍ لم يُرسَل في الردّ يُبقي القديم.** إسقاطُه لأن الردّ سكت
 * عنه خروجٌ صامتٌ بعد أسبوع — وهو أسوأ أعطاب هذا الباب.
 */
export async function refreshWith(
  env: Env,
  source: ExternalSource,
  current: TokenSet
): Promise<TokenSet | null> {
  if (!current.refreshToken) return null;
  const client = await storedClient(env, source.id);
  const found = await cachedDiscovery(env, source.id);
  if (!client || !found?.tokenEndpoint) return null;

  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refreshToken });
  if (found.resource) body.set('resource', found.resource);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  applyClientAuth(client, body, headers);
  try {
    const res = await fetch(found.tokenEndpoint, { method: 'POST', headers, body: body.toString(), signal: AbortSignal.timeout(source.timeoutMs) });
    const data = await readJson(res);
    if (!res.ok || typeof data?.access_token !== 'string') {
      console.error(`oauth ${source.id}: تجديدٌ مرفوض ${res.status}`);
      return null;
    }
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : null;
    const next: TokenSet = {
      accessToken: data.access_token,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
      scope: typeof data.scope === 'string' ? data.scope : current.scope,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : current.refreshToken,
    };
    await storeToken(env, source.id, next);
    return next;
  } catch (e) {
    console.error(`oauth ${source.id}: ${reason(e)}`);
    return null;
  }
}
