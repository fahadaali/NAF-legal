// إنشاء الإشعارات داخل المنصّة (وبريدًا اختياريًا عبر Resend إن توفّر المفتاح)
import { uuid } from './crypto';
import type { Env } from '../types';

export async function notify(
  env: Env,
  opts: { userId: string; kind: string; title: string; body?: string; link?: string; email?: string }
): Promise<void> {
  try {
    await env.DB.prepare(
      'INSERT INTO notifications (id, user_id, kind, title, body, link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(uuid(), opts.userId, opts.kind, opts.title, opts.body ?? null, opts.link ?? null, Date.now())
      .run();
  } catch {
    // لا نُفشل العملية الأصلية بسبب الإشعار
  }

  // بريد اختياري: يعمل فقط إذا ضُبط RESEND_API_KEY و NOTIFY_FROM
  if (env.RESEND_API_KEY && opts.email) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: env.NOTIFY_FROM || 'no-reply@naf-legal.app',
          to: [opts.email],
          subject: opts.title,
          text: `${opts.body ?? opts.title}\n\n— مستشار ناف`,
        }),
      });
    } catch {
      // فشل البريد لا يعطّل الإشعار الداخلي
    }
  }
}

/**
 * يُبلّغ مسؤولي المنصة جميعاً.
 *
 * **والمسؤول يُقرأ من `members` لا من `users`.** بعد الدخول الموحّد صار
 * `members.role` هو ما يقرأه `requireAdmin` وما تكتبه شاشة «الأعضاء»،
 * و`users.role` عمودٌ لا يقرّر شيئاً: `lib/sso.ts` يكتب فيه `'user'` ثابتةً
 * لكل عضوٍ جديد ولا يرفعه أحد بعدها.
 *
 * فاستعلامٌ على `users WHERE role = 'admin'` — وهو ما كان — لا يجد أحداً في
 * منصةٍ بُدئت بعد الربط، ويجد المسؤولين القدامى وحدهم فيما بُدئ قبله. وأثرُه
 * صامت: الطلب يُحفظ صحيحاً ولا يُنبَّه إليه أحد.
 *
 * والموقوف لا يُبلَّغ: `is_active = 0` عضوٌ سُحب وصولُه، وإشعارٌ يصله لا
 * يستطيع فتحه.
 *
 * و`local_user_id` شرطٌ لا ترفٌ: `notifications.user_id` مفتاحٌ أجنبيّ إلى
 * `users(id)`، فعضوٌ بلا سجلّ محلي لا يُعلَّق عليه إشعار. وهو مضمون الوجود
 * لكل عضوٍ يهيّئه `onClaims`، والشرط حارسٌ للصفوف القديمة.
 */
export async function notifyAdmins(
  env: Env,
  opts: { kind: string; title: string; body?: string; link?: string }
): Promise<void> {
  const admins = await env.DB.prepare(
    `SELECT local_user_id AS id, email FROM members
     WHERE role = 'admin' AND is_active = 1 AND local_user_id IS NOT NULL`
  ).all<{ id: string; email: string | null }>();

  for (const a of admins.results ?? []) {
    await notify(env, { ...opts, userId: a.id, email: a.email ?? undefined });
  }
}
