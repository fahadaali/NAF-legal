// الدخول الموحّد — التركيب المحلي
//
// هذا الملف يقابل `functions/_middleware.js` في وثيقة الربط. الوثيقة تفترض
// Cloudflare Pages Functions حيث يُكتشف الوسيط بالاسم، وهذه المنصة Worker
// على Hono، فالتركيب صريح لا ضمني.
//
// والمصادقة نفسها لا تُقرأ من `authenticate` في الحزمة، لسببين مكتوبين في
// `lib/handoff.ts` بتفصيلهما: صيغةُ الحزمة على السلك تخالف عقد المركز،
// و`authenticate` لا تتحقّق من الرمز إلا عند الاستقبال. والعقد يشترط فحص
// التوقيع و`exp` **في كل طلب محمي**. فما يمسّ المركز من `handoff.ts`، وما
// يمسّ قاعدة الأعضاء وحدها (`createConfig` و `getMember` و `upsertMember`)
// يبقى من الحزمة بلا نسخ.

import {
  clearCookie,
  createConfig,
  getMember,
  newSessionId,
  readCookie,
  sessionCookie,
  upsertMember,
  verifyToken,
} from 'naf-auth';
import type { AuthConfig, Claims } from 'naf-auth';
import type { Context, Next } from 'hono';
import { uuid } from './crypto';
import { deniedRedirect, handleCallback, startLogin } from './handoff';
import type { Env, Variables, PlatformRole } from '../types';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

/**
 * المسارات العامة — تُكتب صراحةً لهذه المنصة، وأي مسار غيرها محمي افتراضياً.
 *
 * `/api/health` لا `/health`: فحص الصحة في هذه المنصة تحت بادئة الـ API،
 * والقيمة الافتراضية في الحزمة لا تطابقه فتُستبدل هنا لا هناك.
 *
 * ولا وجود لمسارات المشاركة العامة في هذه القائمة — `/api/shares/public/*`
 * و `/review/:token` كانتا مفتوحتين للعميل الخارجي بلا حساب، وقرار هذه
 * الجلسة إخضاعهما للدخول الموحّد. الأثر موصوف في `audit/sso-report.md`.
 */
const PUBLIC_PATHS = ['/auth/callback', '/denied', '/api/health'];

/**
 * الأصول الساكنة — بادئات مُعلنة لا اجتهاد على الامتداد.
 * `/assets/` حزمة Vite، و `/brand/` العلامة وأيقونة التبويب، وكلتاهما
 * تلزمان صفحة الرفض نفسها: صفحةٌ لا تحمّل نمطها ليست صفحة رفض.
 */
const PUBLIC_PREFIXES = ['/assets/', '/brand/'];

/** الدور الافتراضي لأول دخول — يرقّيه مسؤول المنصة من إعداداتها. */
export const DEFAULT_ROLE: PlatformRole = 'viewer';

/**
 * مطابقة الأدوار القائمة عند الربط بالبريد.
 *
 * `user` القائم يكتب اليوم: ينشئ محادثات ومسوّدات ومواعيد ويرفع ملفات،
 * وحدّ `requireAdmin` وحده يفصله عن المسؤول. فمقابله `editor` لا `viewer`،
 * وإنزاله إلى `viewer` انحدارٌ يطال قاعدة المستخدمين كلها دفعةً واحدة.
 */
function mappedRole(existingRole: string): PlatformRole {
  return existingRole === 'admin' ? 'admin' : 'editor';
}

/** ثوانٍ لا ملّي ثانية — صيغة `epoch` التي تكتب بها الحزمة أعمدة الوقت. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * سنتينل مكان تجزئة كلمة المرور لعضوٍ لا كلمة مرور له أصلاً.
 *
 * `verifyPassword` ترفض أي مخزَّن لا يتكوّن من أربعة أجزاء بادئتها `pbkdf2`،
 * فهذه القيمة لا تُطابِق أي كلمة مرور مهما كانت — ولا تفتح باباً ثانياً.
 * وعمود `password_hash` من هجرة `0001` بقيد NOT NULL ولا يُعدَّل للأمام.
 */
const NO_LOCAL_PASSWORD = 'sso';

/**
 * نقطة التعليق بين التحقق والإدراج (`onClaims`).
 *
 * هنا يُطابَق العضو القادم من المركز بسجلّه المحلي قبل أن تُنشئ الحزمة سجلّاً
 * ثانياً له. والقرار المعتمد ربطٌ بالبريد مع إبقاء `users`:
 *
 *   وُجد سجلّ عضو بهذا `sub`      → لا شيء، وهو الدخول الثاني فصاعداً
 *   طابق البريدُ سجلّاً في `users` → يُربط به ويرث دوره مترجَماً
 *   لم يطابق شيئاً                 → يُهيَّأ له سجلّ `users` ثم يُربط به
 *
 * والحالة الثالثة ليست ترفاً: `conversations` و `case_folders` و
 * `regulation_requests` تحمل مفاتيح أجنبية إلى `users(id)`، فعضوٌ بلا سجلّ
 * محلي يدخل المنصة ثم يفشل عند أول محادثة ينشئها.
 *
 * وما يكتبه هذا الخطّاف لا تلمسه `upsertMember` بعده: هي تحدّث الاسم والبريد
 * وآخر ظهور فقط، ولا تمسّ الدور ولا حالة التفعيل.
 */
export async function linkExistingMember(claims: Claims, env: Env): Promise<void> {
  const already = await env.DB.prepare('SELECT user_id FROM members WHERE user_id = ?')
    .bind(claims.sub)
    .first<{ user_id: string }>();
  if (already) return;

  const email = typeof claims.email === 'string' ? claims.email.trim() : '';
  const now = nowSeconds();

  // البريد يُطابَق بلا حساسية لحالة الأحرف: `users.email` يُخزَّن كما كُتب،
  // فالمطابقة الحرفية تُخطئ سجلّاً موجوداً وتُنشئ له سجلّاً ثانياً.
  const local = email
    ? await env.DB.prepare('SELECT id, role, name FROM users WHERE lower(email) = lower(?)')
        .bind(email)
        .first<{ id: string; role: string; name: string | null }>()
    : null;

  if (local) {
    // سجلّ محلي مرتبط بهوية مركزية أخرى لا يُختطف. الفريد على العمود يمنع
    // ذلك على مستوى القاعدة، والفحص هنا يجعل الرفض مفهوماً لا استثناءً خاماً.
    const taken = await env.DB.prepare('SELECT user_id FROM members WHERE local_user_id = ?')
      .bind(local.id)
      .first<{ user_id: string }>();
    if (taken) return;

    await env.DB.prepare(
      `INSERT INTO members (user_id, display_name, email, role, is_active, created_at, local_user_id)
       VALUES (?, ?, ?, ?, 1, ?, ?)`
    )
      .bind(
        claims.sub,
        (typeof claims.name === 'string' ? claims.name : null) ?? local.name,
        email || null,
        mappedRole(local.role),
        now,
        local.id
      )
      .run();
    return;
  }

  // عضو جديد بلا مقابل محلي: يُهيَّأ له سجلّ `users` ليصحّ ما يعلّق عليه من
  // مفاتيح. لا كلمة مرور له ولا بوابة تغييرها — بابه المركز وحده.
  const localId = uuid();
  await env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, role, name, must_change_password, created_at)
     VALUES (?, ?, ?, 'user', ?, 0, ?)`
  )
    .bind(
      localId,
      email || `${claims.sub}@sso.local`,
      NO_LOCAL_PASSWORD,
      typeof claims.name === 'string' ? claims.name : null,
      Date.now() // جداول المنصة القائمة بالملّي ثانية — وهذا أحدها
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO members (user_id, display_name, email, role, is_active, created_at, local_user_id)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  )
    .bind(
      claims.sub,
      typeof claims.name === 'string' ? claims.name : null,
      email || null,
      DEFAULT_ROLE,
      now,
      localId
    )
    .run();
}

/**
 * الإعداد. ولا شيء من قيمه مكتوب هنا: المعرّف والنطاق يأتيان من
 * `wrangler.toml`، والسرّ من `wrangler secret` ولا يمرّ بهذا الملف إطلاقاً.
 */
export function ssoConfig(env: Env): AuthConfig {
  return createConfig(env, {
    publicPaths: PUBLIC_PATHS,
    publicPrefixes: PUBLIC_PREFIXES,
    defaultRole: DEFAULT_ROLE,
    onClaims: (claims) => linkExistingMember(claims, env),
  });
}

/** المسار عامّ: مساواة تامة أو بادئة مُعلنة. لا أنماط ولا اجتهاد. */
function isPublic(pathname: string, config: AuthConfig): boolean {
  if (config.publicPaths.includes(pathname)) return true;
  return config.publicPrefixes.some((prefix) => pathname.startsWith(prefix));
}

/**
 * ردُّ الطلب غير المصادَق.
 *
 * تنقّلُ متصفح يعود إلى المركز، ونداءُ `fetch` يعود 401. والتحويل خطأ في
 * الثاني: `fetch` يتبع الـ 302 إلى نطاق المركز فيسقط على سياسة المصدر
 * وتظهر رسالة شبكة لا معنى لها. والـ 401 يجعل الواجهة تعيد تحميل الصفحة،
 * فيمرّ التنقّل على هذا الوسيط نفسه ويُحوَّل كما ينبغي.
 *
 * والكوكي يُسقَط مع الردّ متى وُجد: الجلسة التي أوصلتنا إلى هنا لم تعد
 * صالحة، وبقاء معرّفها في المتصفح يعيد قراءةً خائبة من KV عند كل طلب.
 */
function unauthenticated(c: Ctx, config: AuthConfig, staleCookie: boolean): Response {
  const res = c.req.path.startsWith('/api/')
    ? c.json({ error: 'انتهت جلسة دخولك. سجّل الدخول من جديد' }, 401)
    : startLogin(c.req.raw, config);

  if (staleCookie) res.headers.append('set-cookie', clearCookie(config.cookieName));
  return res;
}

/**
 * نصوص الرفض للـ API.
 *
 * صفحة `/denied` تترجم رمز السبب إلى مصطلحه المسجَّل، وهي وجهةُ المتصفح.
 * أمّا `fetch` فلا يقرأ صفحة: تحويلُه إلى `/denied` يعيد إليه HTML حيث
 * ينتظر JSON، فيفشل التحليل وتظهر رسالة عطل بدل سبب الرفض. فالنصّ نفسه
 * — من `Denied.tsx` حرفاً بحرف، ومصدرهما واحد — يُعاد هنا في جسم JSON.
 */
const API_DENIAL: Record<string, string> = {
  not_member: 'لا تملك صلاحية الوصول لهذه المنصة',
  inactive: 'عضويتك في هذه المنصة معطّلة. راجع مسؤول المنصة.',
};

/** الرفض: صفحةٌ للمتصفح، وجسمُ JSON بالرمز 403 لنداء الـ API. */
function denied(c: Ctx, config: AuthConfig, reason: string): Response {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: API_DENIAL[reason] ?? 'لا تملك صلاحية الوصول لهذه المنصة' }, 403);
  }
  return deniedRedirect(config, reason);
}

/**
 * الوسيط — الحارس.
 *
 * «إضافة مسار الاستقبال لا تُنشئ حارساً»: هذا هو الحارس، وهو مركَّب على `*`
 * فأيُّ مسار لم يُذكر في القائمة العامة محميٌّ افتراضياً — بما فيها جذرُ
 * الواجهة نفسه. ولذلك `run_worker_first = true` في `wrangler.toml`: بدونها
 * تُقدَّم `index.html` من الأصول قبل أن يعمل Worker أصلاً، فتُحمَّل قشرة
 * الواجهة لزائرٍ بلا جلسة ولا يمرّ بهذا الحارس.
 *
 * وثلاثة قرارات في الترتيب:
 *
 * ١) **التحقق من الرمز في كل طلب محمي، لا عند الاستقبال وحده.** الرمز
 *    مخزَّن في الجلسة، ويُفحص توقيعُه و`exp` هنا في كل مرة. وهذا ما يجعل
 *    الإيقافَ المركزي يسري خلال ربع ساعة: عمرُ الرمز خمس عشرة دقيقة، فإذا
 *    انقضى عاد الطلب إلى المركز فأصدر رمزاً جديداً — أو رفض. ولولا هذا
 *    الفحص لبقي الموقوف مركزياً داخلاً حتى تنتهي جلسته المحلية.
 *
 * ٢) انقضاءُ الرمز يحذف الجلسة ثم يعيد إلى المركز. والعودة شفّافة لمن
 *    جلستُه في المركز قائمة: تحويلتان بلا مطالبة بكلمة مرور.
 *
 * ٣) الهوية المحقونة هي المعرّف المحلي لا `sub`. كل جداول المنصة تعلّق على
 *    `users(id)`، فحقنُ `sub` يقطع كل مستخدم مُرحَّل عن محادثاته وملفاته.
 *    و`members.local_user_id` هو الجسر، وهو مضمون الوجود لأن `onClaims`
 *    يهيّئه لكل عضو بلا استثناء.
 */
export async function ssoMiddleware(c: Ctx, next: Next) {
  const config = ssoConfig(c.env);

  if (isPublic(c.req.path, config)) {
    await next();
    return;
  }

  const sid = readCookie(c.req.raw, config.cookieName);
  if (!sid) return unauthenticated(c, config, false);

  const kv = config.kv(c.env) as KVNamespace;
  const session = await kv.get<{ sub?: string; token?: string }>(`sess:${sid}`, 'json');
  if (!session?.sub || !session.token) return unauthenticated(c, config, true);

  // (١) الفحص الكامل في كل طلب محمي.
  try {
    await verifyToken(session.token, c.env, config);
  } catch {
    // (٢) الجلسة تُحذف لا يُكتفى بإسقاط الكوكي: المُسقَط يبقى صالحاً عند
    // من نسخه، والحذف يُبطله عند الجميع.
    await kv.delete(`sess:${sid}`);
    return unauthenticated(c, config, true);
  }

  const member = await getMember(c.env, config, session.sub);
  if (!member) return denied(c, config, config.reasons.notMember);
  if (!member.isActive) return denied(c, config, config.reasons.inactive);

  // (٣) الجسر إلى الهوية المحلية.
  const row = await c.env.DB.prepare(
    'SELECT local_user_id, email, display_name FROM members WHERE user_id = ?'
  )
    .bind(member.id)
    .first<{ local_user_id: string | null; email: string | null; display_name: string | null }>();

  c.set('user', {
    id: row?.local_user_id ?? member.id,
    email: row?.email ?? '',
    role: member.role as PlatformRole,
    name: row?.display_name ?? undefined,
    memberId: member.id,
    perms: member.perms,
  });

  await next();
}

/**
 * الاستقبال — من التحقق إلى الجلسة.
 *
 * `handleCallback` تتحقّق ولا تكتب شيئاً؛ وهنا يُدرَج العضو وتُفتح الجلسة.
 * وفصلُهما مقصود: ما يمسّ المركز في ملف، وما يمسّ قاعدة هذه المنصة في آخر.
 *
 * والخطأ يُبتلع إلى رمز سبب ثابت: نصّه قد يحمل تفصيلاً تقنياً أو ما أعاده
 * المركز، ولا يُعرض شيء من ذلك للمستخدم.
 */
export async function ssoCallback(c: Ctx): Promise<Response> {
  const config = ssoConfig(c.env);

  try {
    const outcome = await handleCallback(c.req.raw, c.env, config);
    if (outcome.response) return outcome.response;

    const { claims, token, next: destination } = outcome.verified!;

    // نقطة التعليق: يُطابَق العضو بسجلّه المحلي قبل أن يُنشأ له سجلّ ثانٍ.
    await linkExistingMember(claims, c.env);

    const member = await upsertMember(c.env, config, claims);

    // الموقوف محلياً لا تُفتح له جلسة ولو أذن المركز: المركز يقول من الزائر
    // وإن له حقّ الدخول، وما بعد الباب تقرّره هذه المنصة.
    if (!member || !member.isActive) {
      return deniedRedirect(config, config.reasons.inactive);
    }

    const sid = newSessionId();
    const kv = config.kv(c.env) as KVNamespace;
    await kv.put(
      `sess:${sid}`,
      JSON.stringify({ sub: claims.sub, token, createdAt: Math.floor(Date.now() / 1000) }),
      { expirationTtl: config.sessionTtlSeconds }
    );

    return new Response(null, {
      status: 302,
      headers: {
        location: destination,
        'cache-control': 'no-store',
        'set-cookie': sessionCookie(config.cookieName, sid, config.sessionTtlSeconds),
      },
    });
  } catch {
    return deniedRedirect(config, config.reasons.authFailed);
  }
}
