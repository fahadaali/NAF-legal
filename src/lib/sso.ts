// الدخول الموحّد — التركيب المحلي لحزمة `naf-auth`
//
// هذا الملف يقابل `functions/_middleware.js` في وثيقة الربط. الوثيقة تفترض
// Cloudflare Pages Functions حيث يُكتشف الوسيط بالاسم، وهذه المنصة Worker
// على Hono، فالتركيب صريح لا ضمني — وهو المسار الذي يوثّقه README الحزمة
// نفسها تحت «Worker على Hono».
//
// ولا شيء هنا ينسخ منطق الحزمة: كل ما يلي إعدادٌ وقراءةُ نتيجة.
// `authenticate` و `createConfig` و `upsertMember` من سطحها العام المستقرّ.

import { authenticate, createConfig } from 'naf-auth';
import type { AuthConfig, Claims } from 'naf-auth';
import type { Context, Next } from 'hono';
import { uuid } from './crypto';
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
 * عمود `password_hash` من هجرة `0001` بقيد NOT NULL ولا يُعدَّل للأمام،
 * فيلزمه قيمة. وهذه لا تُطابِق كلمةً مهما كانت: صيغةُ التجزئة أربعةُ أجزاء
 * بادئتها `pbkdf2`، وهذه كلمةٌ واحدة.
 *
 * ولم يبقَ ما يقارنها بشيء أصلاً: `verifyPassword` ومسارُ الدخول المحلي
 * أُسقطا كلاهما — انظر `src/routes/auth.ts`. فهي حشوُ عمودٍ لا حارسُ باب.
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
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(user_id) DO NOTHING`
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
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(user_id) DO NOTHING`
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

    /**
     * حالة ردّ المركز تُسجَّل مع رمز الخطأ لا الرمز وحده.
     *
     * الرمز وحده يجعل كل فشل `auth_failed` بلا سبب، والفرق بين تشخيص في
     * دقيقة وآخر في ساعة هو هذا السطر. والحالة تفرّق ما لا يفرّقه الرمز:
     *
     *   secret_missing              السرّ غير مضبوط
     *   exchange_failed — … (401)   السرّ خاطئ أو `platformId` لا يطابق
     *   exchange_failed — … (400)   رمز عبور مستهلَك — لا تُحدَّث صفحة الاستقبال
     *   exchange_failed — … (403)   لا صفّ `granted` في `platform_access`
     *   bad_issuer / bad_audience   `AUTH_ISSUER` أو `PLATFORM_ID` لا يطابق حرفياً
     *   callback_failed — no such table   الهجرة لم تُطبَّق
     *
     * ورسالة الخطأ لا تُلحق إن كانت نسخةً من الرمز: تكرارُه ضجيج لا خبر.
     * والسرّ لا يمرّ بهذه الدالة — `exchangeCode` لا تُدخله في رسالة خطأ.
     */
    onError: (code, err) => {
      const message = err instanceof Error ? err.message : '';
      const status = message && message !== code ? ` — ${message}` : '';
      console.error(`naf-auth: ${code}${status}`);
    },
  });
}

/**
 * الوسيط.
 *
 * يقرأ نتيجة `authenticate` ويحقن المستخدم في السياق. وزيادةٌ واحدة على
 * غلاف Hono الجاهز في الحزمة، وهي من منطق هذه المنصة لا من منطق المصادقة:
 *
 * الهوية المحقونة هي المعرّف المحلي لا `sub`. كل جداول المنصة تعلّق على
 * `users(id)`، فحقنُ `sub` يقطع كل مستخدم مُرحَّل عن محادثاته وملفاته.
 * و`members.local_user_id` هو الجسر، وهو مضمون الوجود لأن `onClaims`
 * يهيّئه لكل عضو بلا استثناء.
 *
 * وما كان زيادةً ثانية أُسقط: كان هذا الوسيط يحوّل ردّ الحزمة إلى 401 حين
 * يبدأ المسار بـ `/api/`. ومنذ `v3.0.0` تفرّق الحزمة بين تصفّحٍ ونداءٍ
 * برمجي **بطبيعة الطلب** (`Sec-Fetch-Mode` ثم `Accept`، والبادئة آخر ما
 * يُسأل) — فالتفريق بالبادئة صار خطأً لا تكراراً:
 *
 *   `/api/files/export/…` و `/api/cases/:id/export` و `/api/kb/…/file`
 *   روابط **تنزيل يفتحها المستخدم بنفسه**، وهي تنقّلٌ لا نداء `fetch`.
 *   فبالبادئة كان التنقّل إليها يأخذ 401 بجسم JSON، فيقرأ المستخدم نصّاً
 *   خاماً مكان أن يعود إلى الدخول.
 *
 * والحزمة تعطي الآن ما يناسب كلاً منهما: 302 للتنقّل، و401 ومعه `login`
 * لنداء `fetch`، و403 ومعه `denied` للعضو الموقوف — والفرعان يُقرآن في
 * `web/src/lib/api.ts`.
 */
export async function ssoMiddleware(c: Ctx, next: Next) {
  const config = ssoConfig(c.env);
  const result = await authenticate(c.req.raw, c.env, config);

  if (result.response) return result.response;

  if (result.user) {
    const row = await c.env.DB.prepare(
      'SELECT local_user_id, email, display_name FROM members WHERE user_id = ?'
    )
      .bind(result.user.id)
      .first<{ local_user_id: string | null; email: string | null; display_name: string | null }>();

    c.set('user', {
      id: row?.local_user_id ?? result.user.id,
      email: row?.email ?? '',
      role: result.user.role as PlatformRole,
      name: row?.display_name ?? undefined,
      memberId: result.user.id,
      perms: result.user.perms,
    });
  }

  await next();
}
