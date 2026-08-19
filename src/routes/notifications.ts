// إشعارات داخل المنصّة
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

app.get('/', async (c) => {
  const user = c.get('user');
  const rows = await c.env.DB.prepare(
    'SELECT id, kind, title, body, link, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
  )
    .bind(user.id)
    .all();
  /* العدّاد على الجدول لا على الخمسين المعروضة.
     كان يُحسب من نتيجة `LIMIT 50` نفسها، فمن تجاوز غيرُ المقروء عنده
     الخمسين يرى عدداً أقلّ من الحقيقة — والشارة تقول «خمسون» وهي مئة. */
  const unread = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL'
  )
    .bind(user.id)
    .first<{ n: number }>();
  return c.json({ notifications: rows.results, unread: unread?.n ?? 0 });
});

app.post('/read', async (c) => {
  const user = c.get('user');
  const { id } = await c.req.json().catch(() => ({}));
  if (id) {
    await c.env.DB.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?')
      .bind(Date.now(), id, user.id)
      .run();
  } else {
    await c.env.DB.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
      .bind(Date.now(), user.id)
      .run();
  }
  return c.json({ ok: true });
});

export default app;
