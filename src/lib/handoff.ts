// الدخول الموحّد — عقد المركز كما تنفّذه مساراتُه فعلاً
//
// ═══ لماذا هذا الملف موجود ولا تكفي `naf-auth` ═══
//
// حزمة `naf-auth@v1.0.0` بُنيت على وثيقة ربط لا على مسارات `naf-id`، فصيغتها
// على السلك تخالف ما يقبله المركز فعلاً في ثلاثة مواضع — وكلّها قاطعة، أي
// أن الدخول يفشل بها مئة في المئة لا أحياناً:
//
//   ١) مبادلة الرمز. الحزمة ترسل { code, client_id, client_secret }
//      والمركز يشترط الأربعة { platformId, secret, code, state } ويردّ
//      `invalid_body` 400 على ما عداها — `functions/api/token.js:28‑36`.
//
//   ٢) الحالة العابرة. الحزمة تولّدها في المنصة وتخزّنها في `st:` وتطابقها
//      عند العودة؛ والمركز يولّدها هو، ويتجاهل ما ترسله المنصة أصلاً
//      (`functions/go/[id].js:37‑39` تقرأ `next` وحدها)، ثم يطابق حالته هو
//      عند المبادلة — `functions/api/token.js:75`. فحالةُ المنصة لا تعود
//      إليها أبداً، وكلُّ استقبال كان سيُرفض بـ `bad_state` حتى لو صحّت ١.
//
//   ٣) التبليغ العكسي. الحزمة ترسل { client_id, client_secret, user_id,
//      status } والمركز يشترط { platformId, secret, email, state } ويفتّش
//      بالبريد لا بالمعرّف المركزي — `functions/api/internal/access.js:30‑46`.
//
// فما يخصّ السلك مكتوب هنا على العقد الموثَّق، وما لا يخصّه يبقى من الحزمة
// بلا نسخ: `verifyToken` (مقروءة سطراً سطراً ومطابِقة للعقد: RS256 وحدها،
// و`kid` ملزم، وإعادة جلب فورية عند `kid` مجهول، و`iss` و`aud` مقارنةً
// حرفية، و`exp` بسماح ستين ثانية)، و`getMember` و`upsertMember` (قاعدةٌ
// محلية لا علاقة لها بالمركز)، و`safeNext` (أضيق مما يشترطه العقد).
//
// والفرق الوحيد الباقي بين الحزمة والعقد بعد هذا الملف: كاش `JWKS` عندها
// ساعة والعقد يقول خمس دقائق. وهو غير مؤثّر عملياً لأن `kid` المجهول يُعيد
// الجلب فوراً، لكنه مذكور في تقرير الربط لتُرفع في الحزمة لا هنا.

import { AuthError, safeNext, verifyToken } from 'naf-auth';
import type { AuthConfig, Claims } from 'naf-auth';
import type { Env } from '../types';

/** لا تُخزَّن استجابةُ تحويلٍ تحمل قراراً مرتبطاً بجلسة. */
function redirect(location: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 302,
    headers: { location, 'cache-control': 'no-store', ...extraHeaders },
  });
}

/** التحويل إلى صفحة الرفض برمز سبب — والنصّ تترجمه الصفحة من `naf-terms.md`. */
export function deniedRedirect(config: AuthConfig, reason: string): Response {
  return redirect(`${config.deniedPath}?r=${encodeURIComponent(reason)}`);
}

/**
 * تنقية وجهة العودة.
 *
 * `safeNext` من الحزمة تحقّق شروط العقد وتزيد: مائلة واحدة في الأول، ولا
 * مائلتان، ولا نقطتان رأسيتان، ولا شرطة عكسية، ولا محارف تحكّم.
 *
 * والزيادة هنا هي تحذير العقد نفسه: «أنت قد تفكّ ترميزه مرة أخرى فيصير
 * شيئاً آخر». فلا نفكّ ترميزه — ونرفضه إن كان فكُّه مرةً أخرى يحوّله إلى ما
 * لا يجتاز الفحص نفسه. مثاله `‎/%2f%2fevil.example` : يمرّ حرفياً لأنه مائلة
 * واحدة ثم محرف نسبة، ولو فكّه طرفٌ لاحق لصار `‎///evil.example` أي عنواناً
 * خارجياً. فيُردّ إلى الجذر قبل أن يصل إلى ترويسة `Location`.
 */
export function safeNextStrict(value: unknown): string {
  const once = safeNext(value);
  if (once === '/') return '/';

  let decoded: string;
  try {
    decoded = decodeURIComponent(once);
  } catch {
    // ترميز تالف — لا يُحوَّل إليه.
    return '/';
  }
  if (decoded !== once && safeNext(decoded) === '/') return '/';
  return once;
}

/**
 * بدء الدخول: تحويلٌ إلى باب المركز.
 *
 * ولا حالة عابرة تُولَّد هنا ولا تُخزَّن: المركز هو مُصدِر الحالة ومطابِقها،
 * وإرسال حالةٍ من المنصة يذهب سُدىً — `‎/go/:id` لا تقرؤها.
 *
 * والمعرّف يُكتب كما هو بحالة أحرفه: `NAF-legal` لا `naf-legal`. وهو مفتاح
 * `platforms` في المركز وقيمة `aud` في الرمز، ولا يُطبَّع في أي طرف.
 */
export function startLogin(request: Request, config: AuthConfig): Response {
  const url = new URL(request.url);
  const next = safeNextStrict(url.pathname + url.search);

  const target = new URL(`${config.issuer}/go/${encodeURIComponent(config.platformId)}`);
  if (next !== '/') target.searchParams.set('next', next);

  return redirect(target.toString());
}

interface ExchangeResult {
  token: string;
  next: string | null;
}

/**
 * المبادلة — خادماً لخادم، مرةً واحدة لا غير.
 *
 * السرّ يُقرأ من `env` ولا يغادر هذه الدالة: لا إلى رسالة خطأ ولا إلى سجلّ.
 * ولا إعادة محاولة بالرمز نفسه مهما كان سبب الفشل — عمرُه ستون ثانية
 * ويُستهلك عند أول قراءة في المركز (`token.js:60‑61` يقرأ ثم يحذف قبل أي
 * تحقّق آخر)، فالمحاولة الثانية تفشل يقيناً وتُسجَّل محاولةً فاشلة.
 *
 * ولا ترويسات `CORS` على هذا المسار عمداً في المركز؛ وهذا النداء من الخادم
 * فلا شأن له بها.
 */
async function exchangeCode(
  env: Env,
  config: AuthConfig,
  code: string,
  state: string
): Promise<ExchangeResult> {
  const secret = (env as unknown as Record<string, string>)[config.secretBinding];
  if (!secret) throw new AuthError('secret_missing');

  const res = await fetch(`${config.issuer}/api/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    // الحالة تعود كما وصلت حرفياً — المركز يطابقها ويرفض عند الاختلاف.
    body: JSON.stringify({ platformId: config.platformId, secret, code, state }),
  });

  if (!res.ok) {
    // نصّ استجابة المركز لا يُرفَق: قد يعيد ما أُرسل إليه، وفيه السرّ.
    throw new AuthError('exchange_failed', `المركز رفض المبادلة (${res.status})`);
  }

  const body = (await res.json().catch(() => null)) as { token?: unknown; next?: unknown } | null;
  if (!body || typeof body.token !== 'string' || !body.token) {
    throw new AuthError('exchange_malformed');
  }

  return {
    token: body.token,
    next: typeof body.next === 'string' ? body.next : null,
  };
}

/**
 * التبليغ العكسي عند تغيّر الوصول محلياً.
 *
 * المركز يفتّش بالبريد لا بالمعرّف المركزي، ويقبل حالتين لا ثالثة لهما:
 * `granted` و `revoked`. وبريدٌ لا حساب له في المركز يردّ `ok` كغيره عمداً،
 * فلا تصير المنصةُ أداةَ تعداد حسابات.
 */
export async function reportAccessChange(
  env: Env,
  config: AuthConfig,
  change: { email: string; state: 'granted' | 'revoked'; reason?: string }
): Promise<void> {
  const secret = (env as unknown as Record<string, string>)[config.secretBinding];
  if (!secret) throw new AuthError('secret_missing');

  const body: Record<string, unknown> = {
    platformId: config.platformId,
    secret,
    email: change.email,
    state: change.state,
  };
  const reason = change.reason?.trim();
  if (reason) body.reason = reason;

  const res = await fetch(`${config.issuer}/api/internal/access`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new AuthError('access_report_failed', `تعذّر تبليغ المركز (${res.status})`);
}

export interface CallbackOutcome {
  /** استجابة جاهزة تُعاد كما هي — تحويلٌ أو رفض. */
  response?: Response;
  /** ما تحقّق منه: الادّعاءات والرمز ووجهة العودة المنقّاة. */
  verified?: { claims: Claims; token: string; next: string };
}

/**
 * الاستقبال: يتحقّق ويعيد النتيجة، ولا يكتب جلسةً ولا يمسّ قاعدة.
 *
 * الترتيب مقصود: المبادلة أولاً (وفيها يطابق المركزُ الحالةَ ويعيد فحص حال
 * الحساب والوصول)، ثم التحقق الكامل من الرمز محلياً — فلا يُوثَق بردّ
 * المركز لمجرّد أنه جاء منه.
 */
export async function handleCallback(
  request: Request,
  env: Env,
  config: AuthConfig
): Promise<CallbackOutcome> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  // زيارةٌ للمسار بلا رمز — لا خطأ فيها، تُعاد إلى الباب.
  if (!code) return { response: startLogin(request, config) };

  // رمزٌ بلا حالة لا يصدر عن المركز: `‎/go/:id` تعلّق الاثنين معاً دائماً.
  if (!state) return { response: deniedRedirect(config, config.reasons.badState) };

  const { token, next } = await exchangeCode(env, config, code, state);

  // التوقيع و `kid` و `iss` و `aud` و `exp` — كلها هنا.
  const claims = await verifyToken(token, env, config);

  // وجهة العودة: ما يعيده المركز أولاً، فما جاء في الرابط، وإلا الجذر.
  // وكلاهما يمرّ بالتنقية نفسها — «ولا تكتفِ بأن المركز فحصه».
  const candidate = next ?? url.searchParams.get('next');

  return { verified: { claims, token, next: safeNextStrict(candidate) } };
}
