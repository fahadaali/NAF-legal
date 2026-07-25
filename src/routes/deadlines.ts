// المواعيد النظامية: حفظ · قائمة · إنجاز · حذف
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { uuid } from '../lib/crypto';
import { parseFlexibleDate, toHijri, addDays } from '../lib/hijri';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

// قائمة المواعيد (المفتوحة أولًا حسب الأقرب)
app.get('/', async (c) => {
  const user = c.get('user');
  const status = c.req.query('status') ?? 'open';
  const rows = await c.env.DB.prepare(
    `SELECT d.*, f.name AS folder_name FROM deadlines d
     LEFT JOIN case_folders f ON f.id = d.folder_id
     WHERE d.user_id = ? AND (? = 'all' OR d.status = ?)
     ORDER BY d.due_date ASC LIMIT 200`
  )
    .bind(user.id, status, status)
    .all();
  return c.json({ deadlines: rows.results });
});

// إنشاء موعد: إمّا due_date مباشرة، أو base_date + days لحسابه
app.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const { title, kind, base_date, days, due_date, notes, conversation_id, folder_id } = body;
  if (!title?.trim()) return c.json({ error: 'عنوان الموعد مطلوب' }, 400);

  let due = (due_date ?? '').trim();
  if (!due) {
    const base = parseFlexibleDate(base_date ?? '');
    const n = parseInt(String(days ?? ''), 10);
    if (!base || isNaN(n)) return c.json({ error: 'أدخل تاريخ الاستحقاق، أو تاريخ الأساس مع عدد الأيام' }, 400);
    due = addDays(base, n);
  } else {
    const d = parseFlexibleDate(due);
    if (!d) return c.json({ error: 'تاريخ استحقاق غير صالح' }, 400);
    due = d.toISOString().slice(0, 10);
  }

  const id = uuid();
  await c.env.DB.prepare(
    `INSERT INTO deadlines (id, user_id, conversation_id, folder_id, title, kind, base_date, due_date, due_hijri, notes, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
  )
    .bind(
      id,
      user.id,
      conversation_id ?? null,
      folder_id ?? null,
      title.trim(),
      kind ?? null,
      base_date ?? null,
      due,
      toHijri(due) || null,
      notes ?? null,
      Date.now()
    )
    .run();
  return c.json({ id, due_date: due, due_hijri: toHijri(due) });
});

app.patch('/:id', async (c) => {
  const user = c.get('user');
  const { status } = await c.req.json().catch(() => ({}));
  if (!['open', 'done', 'cancelled'].includes(status)) return c.json({ error: 'حالة غير صالحة' }, 400);
  const res = await c.env.DB.prepare('UPDATE deadlines SET status = ? WHERE id = ? AND user_id = ?')
    .bind(status, c.req.param('id'), user.id)
    .run();
  if (!res.meta.changes) return c.json({ error: 'غير موجود' }, 404);
  return c.json({ ok: true });
});

app.delete('/:id', async (c) => {
  const user = c.get('user');
  const res = await c.env.DB.prepare('DELETE FROM deadlines WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id)
    .run();
  if (!res.meta.changes) return c.json({ error: 'غير موجود' }, 404);
  return c.json({ ok: true });
});

export default app;
