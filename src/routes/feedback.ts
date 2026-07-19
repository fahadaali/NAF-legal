// تقييم الردود 👍/👎 مع تعليق — §2 موثوقية
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { uuid } from '../lib/crypto';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

// إرسال/تحديث تقييم رسالة (مقيّد بملكية المحادثة)
app.post('/:messageId', async (c) => {
  const user = c.get('user');
  const messageId = c.req.param('messageId');
  const { rating, comment } = await c.req.json().catch(() => ({}));
  if (rating !== 1 && rating !== -1) return c.json({ error: 'تقييم غير صالح' }, 400);

  const owns = await c.env.DB.prepare(
    `SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.id = ? AND c.user_id = ?`
  )
    .bind(messageId, user.id)
    .first();
  if (!owns) return c.json({ error: 'الرسالة غير موجودة' }, 404);

  await c.env.DB.prepare(
    `INSERT INTO message_feedback (id, message_id, user_id, rating, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (message_id, user_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment`
  )
    .bind(uuid(), messageId, user.id, rating, comment ?? null, Date.now())
    .run();
  return c.json({ ok: true });
});

// جلب تقييم المستخدم لرسالة
app.get('/:messageId', async (c) => {
  const user = c.get('user');
  const fb = await c.env.DB.prepare('SELECT rating, comment FROM message_feedback WHERE message_id = ? AND user_id = ?')
    .bind(c.req.param('messageId'), user.id)
    .first();
  return c.json({ feedback: fb ?? null });
});

export default app;
