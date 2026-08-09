// تظليل نصٍّ داخل رسائل المحادثة — أثرُ قراءةٍ يبقى بعد إغلاق الصفحة.
//
// العزل صارم كما في `conversations.ts`: كلُّ نداءٍ يمرّ بضمٍّ إلى `messages`
// ثم `conversations` مقيَّدٍ بـ`user_id`. ومعرّف الرسالة يأتي من الواجهة،
// فبلا هذا الضمّ يستطيع صاحبُ حسابٍ أن يظلّل في محادثة غيره ويقرأ تظليلاته.
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { uuid } from '../lib/crypto';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

/**
 * سقف طول المقتطع الواحد.
 *
 * الشاهد يُقابَل به الموضع ولا يُقرأ منه، ورسالةٌ كاملة في عمود `text` تُضاعف
 * حجم المحادثة في القاعدة بلا فائدة. وأطولُ ما يُظلَّل عادةً فقرةٌ أو مادة.
 */
const MAX_TEXT = 4000;

/** أكثر ما يُحفظ من تظليلٍ في رسالةٍ واحدة — حدٌّ يمنع نداءً يكتب بلا نهاية. */
const MAX_PER_MESSAGE = 200;

interface OwnedMessage {
  id: string;
  conversation_id: string;
}

/** الرسالة إن كانت في محادثةٍ يملكها القارئ، و`null` فيما عدا ذلك. */
async function ownedMessage(env: Env, messageId: string, userId: string): Promise<OwnedMessage | null> {
  return await env.DB.prepare(
    `SELECT m.id, m.conversation_id
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.id = ? AND c.user_id = ?`
  )
    .bind(messageId, userId)
    .first<OwnedMessage>();
}

/**
 * تظليلات محادثةٍ كاملة — نداءٌ واحد عند فتحها لا نداءٌ لكل رسالة.
 *
 * محادثةٌ فيها أربعون رسالة تعني أربعين نداءً، وهي تُفتح مع كل نقرةٍ في
 * الشريط الجانبي.
 */
app.get('/:conversationId', async (c) => {
  const user = c.get('user');
  const conversationId = c.req.param('conversationId');
  const conv = await c.env.DB.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
    .bind(conversationId, user.id)
    .first<{ id: string }>();
  if (!conv) return c.json({ error: 'غير موجودة' }, 404);

  const rows = await c.env.DB.prepare(
    `SELECT h.id, h.message_id, h.start_off, h.end_off, h.text, h.created_at
     FROM message_highlights h JOIN messages m ON m.id = h.message_id
     WHERE m.conversation_id = ? AND h.user_id = ?
     ORDER BY h.start_off ASC`
  )
    .bind(conversationId, user.id)
    .all();
  return c.json({ highlights: rows.results ?? [] });
});

/** تظليلٌ جديد على رسالة. */
app.post('/:messageId', async (c) => {
  const user = c.get('user');
  const messageId = c.req.param('messageId');
  type Body = { start?: unknown; end?: unknown; text?: unknown };
  const body = await c.req.json<Body>().catch(() => ({}) as Body);

  const start = Number(body.start);
  const end = Number(body.end);
  const text = typeof body.text === 'string' ? body.text : '';
  // مدىً مقلوبٌ أو فارغ أو سالب لا يقع من تحديدٍ حقيقيّ، فهو خللٌ في المرسِل
  // لا اختيارُ قارئ — ويُردّ ولا يُصحَّح: تصحيحُه يكتب تظليلاً لم يطلبه أحد.
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
    return c.json({ error: 'حدّد نصّاً أولاً' }, 400);
  }
  if (!text.trim()) return c.json({ error: 'حدّد نصّاً أولاً' }, 400);

  const message = await ownedMessage(c.env, messageId, user.id);
  if (!message) return c.json({ error: 'غير موجودة' }, 404);

  const count = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM message_highlights WHERE message_id = ? AND user_id = ?'
  )
    .bind(messageId, user.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PER_MESSAGE) {
    return c.json({ error: 'بلغت الحدّ الأقصى للتظليل في هذه الرسالة' }, 400);
  }

  const id = uuid();
  const created_at = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO message_highlights (id, message_id, user_id, start_off, end_off, text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, messageId, user.id, start, end, text.slice(0, MAX_TEXT), created_at)
    .run();

  return c.json({ id, message_id: messageId, start_off: start, end_off: end, text, created_at });
});

/** مسح تظليل — بمعرّفه، ومقيَّداً بصاحبه. */
app.delete('/:id', async (c) => {
  const user = c.get('user');
  const res = await c.env.DB.prepare('DELETE FROM message_highlights WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id)
    .run();
  if (!res.meta.changes) return c.json({ error: 'غير موجودة' }, 404);
  return c.json({ ok: true });
});

export default app;
