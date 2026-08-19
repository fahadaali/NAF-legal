// مجلدات القضايا والوسوم — §3 إنتاجية
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { uuid } from '../lib/crypto';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

/**
 * نغمةُ شارة القضية — رمزٌ من سلّم ناف لا لونٌ خام.
 *
 * كانت ستّ قيم hex تُولَّد هنا وتُرسَم في الشريط بـ`style={{background}}`:
 * لا تتبع الوضعين، ولا تُحدَّث بتحديث الثيم، ولا يشملها أيٌّ من استثناءات
 * `CLAUDE.md` §1 الأربعة — فكلُّها سياقاتٌ لا تقرأ متغيّراً، وهذه تقرأ.
 *
 * والمخزَّن الآن اسمُ نغمةٍ يقابل `--chart-1..5` في `naf-theme.css`، وهي
 * مسجَّلة في السجلّ ولها قيمتان في الوضعين. والخادم لا يعرف لوناً ولا
 * يحتاج أن يعرف: يختار نغمةً، والثيم يقول ما هي.
 *
 * وخمسٌ لا ستّ: السلّم خمس درجات، وسادسةٌ تُخترع هي الانحراف بعينه.
 */
const TONES = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'];

app.get('/', async (c) => {
  const user = c.get('user');
  const rows = await c.env.DB.prepare(
    `SELECT f.id, f.name, f.color, f.created_at,
       (SELECT COUNT(*) FROM conversations cv WHERE cv.folder_id = f.id) AS count
     FROM case_folders f WHERE f.user_id = ? ORDER BY f.created_at DESC`
  )
    .bind(user.id)
    .all();
  return c.json({ folders: rows.results });
});

app.post('/', async (c) => {
  const user = c.get('user');
  const { name } = await c.req.json().catch(() => ({}));
  if (!name?.trim()) return c.json({ error: 'اسم القضية مطلوب' }, 400);
  const id = uuid();
  const color = TONES[Math.floor(Math.random() * TONES.length)];
  await c.env.DB.prepare('INSERT INTO case_folders (id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, user.id, name.trim(), color, Date.now())
    .run();
  return c.json({ id, name: name.trim(), color, count: 0 });
});

app.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  await c.env.DB.prepare('UPDATE conversations SET folder_id = NULL WHERE folder_id = ? AND user_id = ?')
    .bind(id, user.id)
    .run();
  const res = await c.env.DB.prepare('DELETE FROM case_folders WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  if (!res.meta.changes) return c.json({ error: 'غير موجودة' }, 404);
  return c.json({ ok: true });
});

// ربط محادثة بمجلّد قضية
app.post('/assign', async (c) => {
  const user = c.get('user');
  const { conversation_id, folder_id } = await c.req.json().catch(() => ({}));
  const res = await c.env.DB.prepare('UPDATE conversations SET folder_id = ? WHERE id = ? AND user_id = ?')
    .bind(folder_id ?? null, conversation_id, user.id)
    .run();
  if (!res.meta.changes) return c.json({ error: 'المحادثة غير موجودة' }, 404);
  return c.json({ ok: true });
});

export default app;
