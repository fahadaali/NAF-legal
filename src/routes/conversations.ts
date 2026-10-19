// مسارات المحادثات — عزل صارم بـ user_id (§2)
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { uuid } from '../lib/crypto';
import { isGenerating } from '../lib/generating';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

/**
 * قائمة محادثات المستخدم، وترشيحٌ اختياريّ بالقضية.
 *
 * ولا بحثَ هنا. كان فرعُ `q` يطابق **العنوان** بـ`LIKE` بلا تطبيعٍ عربي،
 * ولم يناديه أحد: الشريط الجانبي يبحث عبر `/api/search` — في متن الرسائل،
 * بأنماطٍ مطبَّعة الهمزات والتاء المربوطة. ففرعان للبحث أحدهما أضعف ولا
 * يُنادى ليسا خياراً، وهذا هو الذي سقط.
 */
app.get('/', async (c) => {
  const user = c.get('user');
  const folder = c.req.query('folder'); // تصفية حسب مجلّد القضية
  const cols = 'id, title, consultation_type, folder_id, created_at, updated_at';
  let rows;
  if (folder) {
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
/**
 * حذف محادثةٍ يحذف ما يتبعها كلَّه: ملفاتِ العميل في R2، والصفوفَ المعلَّقة برسائلها.
 *
 * كان الحذف يقع على صفّ المحادثة وحده، فتتبعه الرسائل والمرفقات بالتتالي في D1
 * وتبقى ملفاتُ العميل نفسُها في R2 بلا صفٍّ يدلّ عليها ولا أحدٍ يعرف أنها بقيت —
 * مستنداتٌ قانونية لعميلٍ طلب صاحبُها حذفها. ونُسخُ المسودّة وتقييماتُها
 * واعتمادُها ومشاركاتُها بلا مفتاحٍ أجنبيّ، فكانت تبقى يتيمة.
 */
app.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const owned = await c.env.DB.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first();
  if (!owned) return c.json({ error: 'غير موجودة' }, 404);

  const files = await c.env.DB.prepare(
    `SELECT r2_key FROM attachments WHERE conversation_id = ?
     UNION SELECT e.r2_key FROM exports e JOIN messages m ON m.id = e.message_id WHERE m.conversation_id = ?`
  )
    .bind(id, id)
    .all<{ r2_key: string | null }>();

  const ofMessages = 'SELECT id FROM messages WHERE conversation_id = ?';
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM draft_versions WHERE message_id IN (${ofMessages})`).bind(id),
    c.env.DB.prepare(`DELETE FROM message_feedback WHERE message_id IN (${ofMessages})`).bind(id),
    c.env.DB.prepare(`DELETE FROM message_approvals WHERE message_id IN (${ofMessages})`).bind(id),
    c.env.DB.prepare(`DELETE FROM shares WHERE message_id IN (${ofMessages})`).bind(id),
    c.env.DB.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').bind(id, user.id),
  ]);

  // الملفات بعد الصفوف: لو انقطع الحذف بينهما بقي ملفٌّ بلا صفّ، وهو ما كان يقع
  // دائماً — لا صفٌّ يشير إلى ملفٍّ محذوف.
  const keys = (files.results ?? []).map((r) => r.r2_key).filter((k): k is string => !!k);
  if (keys.length) {
    c.executionCtx.waitUntil(
      c.env.R2.delete(keys).catch((e: any) => console.error('r2 cleanup failed:', e?.message ?? e))
    );
  }
  return c.json({ ok: true });
});

export default app;
