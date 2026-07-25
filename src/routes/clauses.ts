// بنك البنود المعتمدة: قراءة للجميع · تحرير للمسؤول
import { Hono } from 'hono';
import { requireAuth, requireAdmin, audit } from '../lib/auth';
import { uuid } from '../lib/crypto';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

// قائمة/بحث في البنود (متاح لكل المستخدمين لإدراجها في الصياغة)
app.get('/', async (c) => {
  const q = c.req.query('q')?.trim();
  const rows = q
    ? await c.env.DB.prepare(
        'SELECT id, title, category, body, created_at FROM clauses WHERE title LIKE ? OR body LIKE ? OR category LIKE ? ORDER BY category, title LIMIT 200'
      )
        .bind(`%${q}%`, `%${q}%`, `%${q}%`)
        .all()
    : await c.env.DB.prepare('SELECT id, title, category, body, created_at FROM clauses ORDER BY category, title LIMIT 200').all();
  return c.json({ clauses: rows.results });
});

app.post('/', requireAdmin, async (c) => {
  const user = c.get('user');
  const { title, category, body } = await c.req.json().catch(() => ({}));
  if (!title?.trim() || !body?.trim()) return c.json({ error: 'العنوان ونصّ البند مطلوبان' }, 400);
  const id = uuid();
  await c.env.DB.prepare(
    'INSERT INTO clauses (id, title, category, body, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(id, title.trim(), category?.trim() || null, body.trim(), user.id, Date.now())
    .run();
  await audit(c, 'clause.create', id, { title });
  return c.json({ id });
});

app.put('/:id', requireAdmin, async (c) => {
  const { title, category, body } = await c.req.json().catch(() => ({}));
  if (!title?.trim() || !body?.trim()) return c.json({ error: 'العنوان ونصّ البند مطلوبان' }, 400);
  const res = await c.env.DB.prepare(
    'UPDATE clauses SET title = ?, category = ?, body = ?, updated_at = ? WHERE id = ?'
  )
    .bind(title.trim(), category?.trim() || null, body.trim(), Date.now(), c.req.param('id'))
    .run();
  if (!res.meta.changes) return c.json({ error: 'غير موجود' }, 404);
  await audit(c, 'clause.update', c.req.param('id') ?? '', { title });
  return c.json({ ok: true });
});

app.delete('/:id', requireAdmin, async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM clauses WHERE id = ?').bind(c.req.param('id')).run();
  if (!res.meta.changes) return c.json({ error: 'غير موجود' }, 404);
  await audit(c, 'clause.delete', c.req.param('id') ?? '', {});
  return c.json({ ok: true });
});

export default app;
