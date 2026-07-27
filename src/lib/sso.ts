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

/**
 * الوسيط.
 *
 * يقرأ نتيجة `authenticate` ويحقن المستخدم في السياق. وزيادتان على غلاف
 * Hono الجاهز في الحزمة، كلتاهما من منطق هذه المنصة لا من منطق المصادقة:
 *
 * ١) الهوية المحقونة هي المعرّف المحلي لا `sub`. كل جداول المنصة تعلّق على
 *    `users(id)`، فحقنُ `sub` يقطع كل مستخدم مُرحَّل عن محادثاته وملفاته.
 *    و`members.local_user_id` هو الجسر، وهو مضمون الوجود لأن `onClaims`
 *    يهيّئه لكل عضو بلا استثناء.
 *
 * ٢) طلب API غير مصادَق يعود 401 لا تحويلاً. التحويل صحيح لتنقّل المتصفح،
 *    أمّا `fetch` فيتبع الـ 302 إلى نطاق المركز فيسقط على سياسة المصدر
 *    وتظهر للمستخدم رسالة شبكة لا معنى لها. والـ 401 يجعل الواجهة تعيد
 *    تحميل الصفحة، فيمرّ الطلب على هذا الوسيط نفسه ويُحوَّل كما ينبغي —
 *    فالنتيجة واحدة: الجلسة المنتهية تعود إلى المركز ولا تجدّد نفسها.
 */
export async function ssoMiddleware(c: Ctx, next: Next) {
  const config = ssoConfig(c.env);
  const result = await authenticate(c.req.raw, c.env, config);

  if (result.response) {
    if (c.req.path.startsWith('/api/') && result.response.status === 302) {
      return c.json({ error: 'انتهت جلسة دخولك. سجّل الدخول من جديد' }, 401);
    }
    return result.response;
  }

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
