/**
 * مسبارُ التفويض — ما يقوله خادمٌ عن بابه، يُقرأ ويُعرض.
 *
 * ردَّت الشاملة على المصافحة بـ٤٠١ وترويسةٍ تدلّ على وثيقة مواردها المحمية
 * (RFC 9728)، فتبيّن أنها على OAuth 2.1 لا على اعتمادٍ ثابت. وبينهما فرقُ
 * دقيقةٍ ومشروع — لكنّ **تفاصيل** المشروع لا تُعرف من الترويسة وحدها: أيُّ
 * خادمٍ يُفوّض؟ وأيَّ نطاقاتٍ يطلب؟ وهل يقبل تسجيلاً ديناميّاً أم يقتضي
 * معرّفَ عميلٍ يُسجَّل عند مشغّله بيد إنسان؟
 *
 * فهذا الملف يتبع الوثيقة ويقرأ ما فيها، **ولا يفوّض شيئاً**: لا رحلةَ
 * متصفّح، ولا رمزَ يُطلب، ولا حالةَ تُخزَّن. قراءةٌ محضة تُعرض في شاشة
 * المسؤول، ليُبنى ما بعدها على واقعٍ لا على ذاكرة.
 *
 * وهو لا يرمي أبداً — كبقيّة مسار المصادر: ما تعذّر يُقيَّد في `notes`
 * ويُقرأ، ومسبارٌ ساقط يترك التشخيص كما كان ولا يُبدّله.
 */

/** ما استُخرج من وثيقة الموارد وبيانات خادم التفويض. */
export interface DiscoveredAuth {
  /** العنوان الذي اتُّبع — من ترويسة التحدّي. */
  resourceMetadata: string;
  /** المعرّف القانونيّ للمورد، وهو ما يُرسَل لاحقاً في `resource` (RFC 8707). */
  resource?: string;
  authorizationServers: string[];
  scopesSupported?: string[];
  /** العنوان الذي قُرئت منه بيانات خادم التفويض فعلاً — لا المُفترض. */
  metadataUrl?: string;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  /** `null` تعني: قُرئت البيانات ولا تسجيلَ ديناميّاً فيها. */
  registrationEndpoint?: string | null;
  grantTypesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
  tokenEndpointAuthMethodsSupported?: string[];
  responseTypesSupported?: string[];
  /** RFC 9207 — هل يُعيد الخادم `iss` في ردّ التفويض فيُتحقَّق منه؟ */
  authorizationResponseIssParameterSupported?: boolean;
  /** ما تعذّر أو لفت النظر — يُعرض كما هو. */
  notes: string[];
}

/** سقفُ ما يُقرأ من وثيقة. وثيقةُ بياناتٍ أكبر من هذا ليست وثيقةَ بيانات. */
const BODY_MAX = 256 * 1024;

/**
 * جلبُ JSON من عنوانٍ أملاه طرفٌ آخر.
 *
 * `https` وحدها، ومهلةٌ، وسقفٌ للجسم. والعنوان يأتي من الخادم لا منّا،
 * فيُعامَل معاملةَ ما لا يُوثق به: لا ترويسةَ اعتمادٍ تُرسَل معه أبداً —
 * وثيقةُ البيانات عامّةٌ بنصّ المواصفة، ومن أرسل رمزه إلى عنوانٍ أملاه
 * غيرُه فقد سلّمه.
 */
async function fetchJson(
  url: string,
  timeoutMs: number,
  sameOriginAs?: string
): Promise<{ ok: true; data: any } | { ok: false; why: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, why: 'عنوان غير صالح' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, why: 'العنوان ليس https' };
  if (sameOriginAs && parsed.origin !== sameOriginAs) {
    return { ok: false, why: `على أصلٍ آخر (${parsed.origin}) لا ${sameOriginAs}` };
  }

  let res: Response;
  try {
    res = await fetch(parsed.toString(), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
  /* والتحويلُ يُتبَع ثم يُعاد الفحص: خادمٌ يردّ ٣٠٢ إلى أصلٍ آخر يبلغ ما
     منعناه في السطر أعلاه، ومنعٌ يُلتفّ عليه بتحويلةٍ ليس منعاً. */
  if (sameOriginAs && res.url) {
    try {
      if (new URL(res.url).origin !== sameOriginAs) {
        return { ok: false, why: `حُوِّل إلى أصلٍ آخر (${new URL(res.url).origin})` };
      }
    } catch {
      /* عنوانٌ لا يُحلَّل بعد التحويل — يُمضى، فالجسم يُتحقَّق منه بعدُ. */
    }
  }
  if (!res.ok) return { ok: false, why: `${res.status}` };

  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
  if (text.length > BODY_MAX) return { ok: false, why: 'الوثيقة أكبر من الحدّ' };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, why: 'الوثيقة ليست JSON' };
  }
}

/**
 * مواضعُ بيانات خادم التفويض المحتملة، بالترتيب.
 *
 * و**موضعُها ليس واحداً**: RFC 8414 يُدخل `.well-known` بين المضيف والمسار
 * (`https://h/.well-known/oauth-authorization-server/p`)، واكتشافُ OpenID
 * الأقدمُ يُلحقه بالمسار (`https://h/p/.well-known/openid-configuration`).
 * وخادمٌ بلا مسارٍ يجعل الشكلين واحداً فيُخفي الفرق — حتى يأتي خادمٌ بمسار.
 *
 * فتُجرَّب الأربعة ويُقيَّد أيُّها أجاب: المسبار يكشف الموضع ولا يفترضه.
 */
function wellKnownCandidates(issuer: string): string[] {
  let u: URL;
  try {
    u = new URL(issuer);
  } catch {
    return [];
  }
  const origin = u.origin;
  const path = u.pathname.replace(/\/+$/, '');
  const out = [
    `${origin}/.well-known/oauth-authorization-server${path}`,
    `${origin}/.well-known/openid-configuration${path}`,
  ];
  if (path) out.push(`${origin}${path}/.well-known/openid-configuration`);
  return [...new Set(out)];
}

/**
 * مواضعُ وثيقة الموارد حين لا يدلّ التحدّي عليها.
 *
 * والمواصفة تُلزم بهما معاً: «MCP clients MUST support both discovery
 * mechanisms and use the resource metadata URL from the parsed
 * `WWW-Authenticate` headers when present; otherwise, they MUST fall back to
 * constructing and requesting the well-known URIs in the order listed above.»
 * فالترويسةُ أوّلاً — وخادمٌ لا يُرسلها ليس خادماً بلا تفويض.
 */
export function protectedResourceCandidates(endpoint: string): string[] {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return [];
  }
  const path = u.pathname.replace(/\/+$/, '');
  const out = [`${u.origin}/.well-known/oauth-protected-resource`];
  if (path) out.unshift(`${u.origin}/.well-known/oauth-protected-resource${path}`);
  return out;
}

/** نصٌّ إن كان نصّاً، وإلا `undefined` — فحقلٌ مشوَّه لا يُسقط الوثيقة. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** مصفوفةُ نصوصٍ إن كانت كذلك — والمفرد يُقبل مصفوفةً من واحد. */
function strs(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const list = v.filter((x): x is string => typeof x === 'string' && !!x);
    return list.length ? list : undefined;
  }
  return typeof v === 'string' && v ? [v] : undefined;
}

/**
 * يتبع وثيقة الموارد ثم بيانات خادم التفويض، ويردّ ما قُرئ.
 *
 * وردُّه `null` حين تتعذّر الوثيقة الأولى نفسها: لا شيء يُقال عندئذ فوق ما
 * قالته رسالةُ ٤٠١. وما دونها من تعذُّرٍ يُقيَّد في `notes` ويُعرض ما صحّ.
 */
export async function discoverAuth(
  resourceMetadata: string,
  timeoutMs: number,
  endpoint?: string | null
): Promise<DiscoveredAuth | null> {
  /* **الوثيقة على أصل المصدر نفسه، وإلا فلا تُتبَع.** العنوان جاء في ترويسة
     من الخادم لا منّا، فخادمٌ مُخترَق يوجّهنا به حيث شاء. و`RFC 9728` يبني
     العنوان من معرّف المورد أصلاً، فالأصلُ واحدٌ في السويّ من الحالات —
     والمنعُ يُقال في `notes` لا يُسكت عنه، فإن جاء خادمٌ سويٌّ يخالفه عُرف
     من الشاشة لا من تخمين. */
  let origin: string | undefined;
  if (endpoint) {
    try {
      origin = new URL(endpoint).origin;
    } catch {
      origin = undefined;
    }
  }
  const prm = await fetchJson(resourceMetadata, timeoutMs, origin);
  if (!prm.ok) {
    console.error(`discover: وثيقة الموارد تعذّرت (${resourceMetadata}): ${prm.why}`);
    return null;
  }

  const out: DiscoveredAuth = {
    resourceMetadata,
    resource: str(prm.data?.resource),
    authorizationServers: strs(prm.data?.authorization_servers) ?? [],
    scopesSupported: strs(prm.data?.scopes_supported),
    notes: [],
  };

  if (!out.authorizationServers.length) {
    out.notes.push('الوثيقة لا تسمّي خادم تفويض');
    return out;
  }
  if (out.authorizationServers.length > 1) {
    out.notes.push(`خوادمُ تفويضٍ متعدّدة (${out.authorizationServers.length}) — قُرئ الأول`);
  }

  const issuer = out.authorizationServers[0];
  const tried: string[] = [];
  for (const candidate of wellKnownCandidates(issuer)) {
    const meta = await fetchJson(candidate, timeoutMs);
    if (!meta.ok) {
      tried.push(`${candidate} → ${meta.why}`);
      continue;
    }
    out.metadataUrl = candidate;
    out.issuer = str(meta.data?.issuer);
    out.authorizationEndpoint = str(meta.data?.authorization_endpoint);
    out.tokenEndpoint = str(meta.data?.token_endpoint);
    out.registrationEndpoint = str(meta.data?.registration_endpoint) ?? null;
    out.grantTypesSupported = strs(meta.data?.grant_types_supported);
    out.codeChallengeMethodsSupported = strs(meta.data?.code_challenge_methods_supported);
    out.tokenEndpointAuthMethodsSupported = strs(meta.data?.token_endpoint_auth_methods_supported);
    out.responseTypesSupported = strs(meta.data?.response_types_supported);
    if (typeof meta.data?.authorization_response_iss_parameter_supported === 'boolean') {
      out.authorizationResponseIssParameterSupported =
        meta.data.authorization_response_iss_parameter_supported;
    }

    /* تنبيهاتٌ تُقال الآن لا حين يفشل التفويض بعد أسبوع. */
    if (out.issuer && out.issuer.replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')) {
      out.notes.push(`المُصدِر في البيانات (${out.issuer}) يخالف ما سمّته وثيقة الموارد (${issuer})`);
    }
    if (out.registrationEndpoint === null) {
      out.notes.push('لا تسجيل ديناميّ — يلزم معرّفُ عميلٍ يُسجَّل عند مشغّل الخادم');
    }
    if (out.codeChallengeMethodsSupported && !out.codeChallengeMethodsSupported.includes('S256')) {
      out.notes.push('الخادم لا يُعلن دعم S256');
    }
    return out;
  }

  out.notes.push(`تعذّرت بيانات خادم التفويض: ${tried.join(' · ')}`);
  return out;
}

/**
 * يكتشف بابَ التفويض لمصدر: من عنوان التحدّي إن جاء، وإلا من المواضع
 * المعلومة. وهو ما تُلزم به المواصفة لا تحسينٌ زائد.
 */
export async function discoverForEndpoint(
  endpoint: string,
  timeoutMs: number,
  fromChallenge?: string | null
): Promise<DiscoveredAuth | null> {
  if (fromChallenge) {
    const found = await discoverAuth(fromChallenge, timeoutMs, endpoint);
    if (found) return found;
  }
  for (const candidate of protectedResourceCandidates(endpoint)) {
    const found = await discoverAuth(candidate, timeoutMs, endpoint);
    if (found) return found;
  }
  return null;
}
