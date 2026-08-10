// مسارات المحادثات — عزل صارم بـ user_id (§2)
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { uuid } from '../lib/crypto';
import { isGenerating } from '../lib/generating';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

// قائمة محادثات المستخدم (مع بحث نصّي اختياري)
app.get('/', async (c) => {
  const user = c.get('user');
  const q = c.req.query('q');
  const folder = c.req.query('folder'); // تصفية حسب مجلّد القضية
  const cols = 'id, title, consultation_type, folder_id, created_at, updated_at';
  let rows;
  if (q) {
    rows = await c.env.DB.prepare(
      `SELECT ${cols} FROM conversations WHERE user_id = ? AND title LIKE ? ORDER BY updated_at DESC LIMIT 100`
    )
      .bind(user.id, `%${q}%`)
      .all();
  } else if (folder) {
    rows = await c.env.DB.prepare(
      `SELECT ${cols} FROM conversations WHERE user_id = ? AND folder_id = ? ORDER BY updated_at DESC LIMIT 100`
    )
      .bind(user.id, folder)
      .all();
  } else {
    rows = await c.env.DB.prepare(
      `SELECT ${cols} FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100`
    )
      .bind(user.id)
      .all();
  }
  return c.json({ conversations: rows.results });
});

// إنشاء محادثة
app.post('/', async (c) => {
  const user = c.get('user');
  const { title, consultation_type } = await c.req.json().catch(() => ({}));
  const id = uuid();
  const now = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO conversations (id, user_id, title, consultation_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(id, user.id, title ?? 'محادثة جديدة', consultation_type ?? null, now, now)
    .run();
  return c.json({ id, title: title ?? 'محادثة جديدة', consultation_type, created_at: now, updated_at: now });
});

// جلب محادثة ورسائلها (مقيّدة بالمالك)
app.get('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const conv = await c.env.DB.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first();
  if (!conv) return c.json({ error: 'غير موجودة' }, 404);
  const messages = await c.env.DB.prepare(
    'SELECT id, role, content, metadata_json, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
  )
    .bind(id)
    .all();
  /* `message_id` و`parse_status` معهما: الشاشة تقسم المرفقات بهما.
     ما له رسالةٌ يُعرض في فقاعتها، وما لا رسالة له يعود إلى صندوق الكتابة —
     رُفع ولم يُرسَل، فيراه صاحبُه حيث تركه لا في مكانٍ لا يُعرَف. */
  const attachments = await c.env.DB.prepare(
    `SELECT id, message_id, filename, mime, size, parse_status, created_at
     FROM attachments WHERE conversation_id = ? ORDER BY created_at ASC`
  )
    .bind(id)
    .all();
  /* «دورٌ يجري الآن» — لمن عاد بعد إعادة تحميل الصفحة.
     التوليد يمضي في الخلفية ولا يتوقّف بانصراف صاحبه، لكن البثّ الذي كان
     يحمله ذهب مع الصفحة. فبلا هذه العلامة يرى العائد محادثةً ساكنة بلا ردّ
     ولا أثرِ عمل، فيعيد السؤال — ويدفع دوراً ثانياً على دورٍ يجري. */
  const generating = await isGenerating(c.env, id);
  return c.json({
    conversation: conv,
    messages: messages.results,
    attachments: attachments.results,
    generating,
  });
});

// إعادة تسمية
app.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const { title } = await c.req.json().catch(() => ({}));
  const res = await c.env.DB.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(title, Date.now(), id, user.id)
    .run();
  if (!res.meta.changes) return c.json({ error: 'غير موجودة' }, 404);
  return c.json({ ok: true });
});

// حذف
app.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const res = await c.env.DB.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .run();
  if (!res.meta.changes) return c.json({ error: 'غير موجودة' }, 404);
  return c.json({ ok: true });
});

export default app;
