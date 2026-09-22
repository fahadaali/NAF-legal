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
import { seal, unseal } from './sealed';
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
}

/** هامشٌ قبل الانتهاء: انحرافُ الساعات وزمنُ الطلب نفسه. */
const SKEW_MS = 60_000;
/** سقفُ ما يُقرأ من ردٍّ — ردُّ رمزٍ أكبر من هذا ليس ردَّ رمز. */
const BODY_MAX = 64 * 1024;

const clientKey = (id: string) => `mcpoauth:cli:${id}`;
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
export async function registerClient(
  found: DiscoveredAuth,
  timeoutMs: number
): Promise<RegisteredClient | OAuthFail> {
  if (!found.registrationEndpoint) {
    return { ok: false, message: 'الخادم لا يقبل تسجيلاً ديناميّاً' };
  }
  const method = pickAuthMethod(found.tokenEndpointAuthMethodsSupported);
  let res: Response;
  try {
    res = await fetch(found.registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'NAF Legal',
        grant_types: ['client_credentials'],
        /* لا `response_types` ولا `redirect_uris`: منحةُ الآلة لا تُحوّل
           متصفّحاً، والمواصفة تُلزم بالعناوين للمنح المحوِّلة وحدها. */
        response_types: [],
        token_endpoint_auth_method: method,
        ...(found.scopesSupported?.length ? { scope: found.scopesSupported.join(' ') } : {}),
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
