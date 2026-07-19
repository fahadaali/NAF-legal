// مشاركة المسودّة مع محامٍ للمراجعة — §3 إنتاجية
// المالك ينشئ رابطًا برمز؛ المراجِع يفتح الرابط (بلا حساب) ويعلّق ويعتمد.
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { uuid } from '../lib/crypto';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── مسارات عامة (بلا مصادقة) للمراجِع ──
app.get('/public/:token', async (c) => {
  const token = c.req.param('token');
  const share = await c.env.DB.prepare(
    `SELECT s.id, s.status, s.reviewer_label, s.created_at, m.content, m.id AS message_id, c.title, c.consultation_type
     FROM shares s JOIN messages m ON m.id = s.message_id JOIN conversations c ON c.id = m.conversation_id
     WHERE s.token = ?`
  )
    .bind(token)
    .first<any>();
  if (!share) return c.json({ error: 'رابط غير صالح' }, 404);
  const comments = await c.env.DB.prepare(
    'SELECT author, body, created_at FROM share_comments WHERE share_id = ? ORDER BY created_at ASC'
  )
    .bind(share.id)
    .all();
  return c.json({ share, comments: comments.results });
});

app.post('/public/:token/comment', async (c) => {
  const token = c.req.param('token');
  const { author, body } = await c.req.json().catch(() => ({}));
  if (!body?.trim()) return c.json({ error: 'التعليق فارغ' }, 400);
  const share = await c.env.DB.prepare('SELECT id FROM shares WHERE token = ?').bind(token).first<{ id: string }>();
  if (!share) return c.json({ error: 'رابط غير صالح' }, 404);
  await c.env.DB.prepare('INSERT INTO share_comments (id, share_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(uuid(), share.id, (author ?? 'المراجِع').slice(0, 60), body, Date.now())
    .run();
  return c.json({ ok: true });
});

app.post('/public/:token/decision', async (c) => {
  const token = c.req.param('token');
  const { decision, author } = await c.req.json().catch(() => ({}));
  if (!['approved', 'changes_requested'].includes(decision)) return c.json({ error: 'قرار غير صالح' }, 400);
  const share = await c.env.DB.prepare('SELECT id FROM shares WHERE token = ?').bind(token).first<{ id: string }>();
  if (!share) return c.json({ error: 'رابط غير صالح' }, 404);
  await c.env.DB.prepare('UPDATE shares SET status = ?, updated_at = ? WHERE id = ?')
    .bind(decision, Date.now(), share.id)
    .run();
  await c.env.DB.prepare('INSERT INTO share_comments (id, share_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(
      uuid(),
      share.id,
      (author ?? 'المراجِع').slice(0, 60),
      decision === 'approved' ? '✅ اعتمد المسودّة' : '✏️ طلب تعديلات',
      Date.now()
    )
    .run();
  return c.json({ ok: true });
});

// ── مسارات المالك (تتطلب مصادقة) ──
app.post('/', requireAuth, async (c) => {
  const user = c.get('user');
  const { message_id, reviewer_label } = await c.req.json().catch(() => ({}));
  const owns = await c.env.DB.prepare(
    `SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ? AND c.user_id = ?`
  )
    .bind(message_id, user.id)
    .first();
  if (!owns) return c.json({ error: 'الرسالة غير موجودة' }, 404);

  const id = uuid();
  const token = uuid().replace(/-/g, '') + uuid().replace(/-/g, '').slice(0, 8);
  const now = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO shares (id, message_id, owner_id, token, reviewer_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(id, message_id, user.id, token, reviewer_label ?? null, 'pending', now, now)
    .run();
  return c.json({ id, token, url: `/review/${token}` });
});

app.get('/', requireAuth, async (c) => {
  const user = c.get('user');
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.token, s.reviewer_label, s.status, s.created_at, s.updated_at, c.title,
       (SELECT COUNT(*) FROM share_comments sc WHERE sc.share_id = s.id) AS comment_count
     FROM shares s JOIN messages m ON m.id = s.message_id JOIN conversations c ON c.id = m.conversation_id
     WHERE s.owner_id = ? ORDER BY s.updated_at DESC LIMIT 100`
  )
    .bind(user.id)
    .all();
  return c.json({ shares: rows.results });
});

app.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const res = await c.env.DB.prepare('DELETE FROM shares WHERE id = ? AND owner_id = ?')
    .bind(c.req.param('id'), user.id)
    .run();
  if (!res.meta.changes) return c.json({ error: 'غير موجود' }, 404);
  return c.json({ ok: true });
});

export default app;
