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
