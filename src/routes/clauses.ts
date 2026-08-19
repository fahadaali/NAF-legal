// بنك البنود المعتمدة: قراءة للجميع · تحرير للمسؤول
import { Hono } from 'hono';
import { requireAuth, requireAdmin, audit } from '../lib/auth';
import { uuid } from '../lib/crypto';
import { arabicGlobPatterns } from '../lib/arabic';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

/**
 * قائمة/بحث في البنود (متاح لكل المستخدمين لإدراجها في الصياغة).
 *
 * **والمطابقة مطبَّعة عربياً كما في `routes/search.ts`.** كانت `LIKE '%q%'`
 * خاماً، فبحثُ «الاثبات» لا يجد بنداً كُتب «الإثبات» — بينما شاشة البحث في
 * المنصة تجد المادة نفسها لأنها تمرّ بـ`arabicGlobPatterns`. ومطابقتان
 * عربيّتان مختلفتان في شاشتين تُعلّمان القارئ أن البحث «أحياناً يعمل».
 *
 * وكلُّ كلمةٍ يجب أن ترد — `AND` لا `OR` — وفي أيٍّ من الحقول الثلاثة:
 * من كتب كلمتين يريد ما جمعهما، ولا يهمّه أوقعتا في العنوان أم في النصّ.
 */
app.get('/', async (c) => {
  const q = c.req.query('q')?.trim();
  const patterns = q ? arabicGlobPatterns(q) : [];
  const cols = 'id, title, category, body, created_at';

  if (!patterns.length) {
    const rows = await c.env.DB.prepare(`SELECT ${cols} FROM clauses ORDER BY category, title LIMIT 200`).all();
    return c.json({ clauses: rows.results });
  }

  const where = patterns
    .map(() => '(title GLOB ? OR body GLOB ? OR category GLOB ?)')
    .join(' AND ');
  const args = patterns.flatMap((p) => [p, p, p]);
  const rows = await c.env.DB.prepare(
    `SELECT ${cols} FROM clauses WHERE ${where} ORDER BY category, title LIMIT 200`
  )
    .bind(...args)
    .all();
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
