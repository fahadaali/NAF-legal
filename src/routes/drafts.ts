// المسوّدات: سجل النُسخ · التحرير داخل الموقع · اعتماد المحامي
import { Hono, type Context } from 'hono';
import { requireAuth } from '../lib/auth';
import { uuid } from '../lib/crypto';
import { callClaude } from '../lib/claude';
import { getEffectiveConfig } from '../lib/consultationConfig';
import { logUsage, usageFromRaw } from '../lib/usage';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

// يتحقّق أن الرسالة تابعة لمستخدم الجلسة ويعيد محتواها
async function ownedMessage(c: Ctx, messageId: string) {
  return c.env.DB.prepare(
    `SELECT m.id, m.content, m.conversation_id, c.title, c.consultation_type
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.id = ? AND c.user_id = ?`
  )
    .bind(messageId, c.get('user').id)
    .first<{ id: string; content: string; conversation_id: string; title: string; consultation_type: string | null }>();
}

// سجل نُسخ المسودّة
app.get('/:messageId/versions', async (c) => {
  const msg = await ownedMessage(c, c.req.param('messageId'));
  if (!msg) return c.json({ error: 'الرسالة غير موجودة' }, 404);
  const rows = await c.env.DB.prepare(
    'SELECT id, version, content, note, created_at FROM draft_versions WHERE message_id = ? ORDER BY version DESC'
  )
    .bind(msg.id)
    .all();
  const approval = await c.env.DB.prepare(
    `SELECT a.approved_at, a.note, u.email AS approver
     FROM message_approvals a LEFT JOIN users u ON u.id = a.approved_by
     WHERE a.message_id = ?`
  )
    .bind(msg.id)
    .first();
  return c.json({ current: msg.content, versions: rows.results, approval: approval ?? null });
});

// حفظ تحرير المسودّة كنسخة جديدة (ويصبح هو المحتوى الحالي)
app.post('/:messageId', async (c) => {
  const msg = await ownedMessage(c, c.req.param('messageId'));
  if (!msg) return c.json({ error: 'الرسالة غير موجودة' }, 404);
  const { content, note } = await c.req.json().catch(() => ({}));
  if (!content?.trim()) return c.json({ error: 'المحتوى فارغ' }, 400);

  const last = await c.env.DB.prepare('SELECT MAX(version) AS v FROM draft_versions WHERE message_id = ?')
    .bind(msg.id)
    .first<{ v: number | null }>();
  const nextVersion = (last?.v ?? 0) + 1;

  await c.env.DB.prepare(
    'INSERT INTO draft_versions (id, message_id, version, content, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(uuid(), msg.id, nextVersion, content, note ?? 'تحرير يدوي', Date.now())
    .run();
  await c.env.DB.prepare('UPDATE messages SET content = ? WHERE id = ?').bind(content, msg.id).run();

  // أي تعديل يُلغي الاعتماد السابق (يلزم اعتماد النسخة الجديدة)
  await c.env.DB.prepare('DELETE FROM message_approvals WHERE message_id = ?').bind(msg.id).run();

  return c.json({ ok: true, version: nextVersion });
});

// استرجاع نسخة سابقة لتصبح الحالية
app.post('/:messageId/restore/:versionId', async (c) => {
  const msg = await ownedMessage(c, c.req.param('messageId'));
  if (!msg) return c.json({ error: 'الرسالة غير موجودة' }, 404);
  const v = await c.env.DB.prepare('SELECT content, version FROM draft_versions WHERE id = ? AND message_id = ?')
    .bind(c.req.param('versionId'), msg.id)
    .first<{ content: string; version: number }>();
  if (!v) return c.json({ error: 'النسخة غير موجودة' }, 404);

  const last = await c.env.DB.prepare('SELECT MAX(version) AS v FROM draft_versions WHERE message_id = ?')
    .bind(msg.id)
    .first<{ v: number | null }>();
  await c.env.DB.prepare(
    'INSERT INTO draft_versions (id, message_id, version, content, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(uuid(), msg.id, (last?.v ?? 0) + 1, v.content, `استرجاع النسخة ${v.version}`, Date.now())
    .run();
  await c.env.DB.prepare('UPDATE messages SET content = ? WHERE id = ?').bind(v.content, msg.id).run();
  await c.env.DB.prepare('DELETE FROM message_approvals WHERE message_id = ?').bind(msg.id).run();
  return c.json({ ok: true, content: v.content });
});

// صياغة بديلة للمسودّة (تُحفَظ كنسخة جديدة للمقارنة والاختيار)
app.post('/:messageId/alternative', async (c) => {
  const user = c.get('user');
  const msg = await ownedMessage(c, c.req.param('messageId'));
  if (!msg) return c.json({ error: 'الرسالة غير موجودة' }, 404);
  const { instruction } = await c.req.json().catch(() => ({}));

  const cfg = await getEffectiveConfig(c.env, msg.consultation_type ?? 'consultation');
  const system = `${cfg.system_prompt}

مهمّتك الآن: إعادة صياغة المسودّة التالية بأسلوب بديل مع الحفاظ على المضمون القانوني والأسانيد والطلبات.
غيّر الترتيب والصياغة والتركيز بما يقدّم بديلًا حقيقيًا للمقارنة، ولا تُسقِط أي معلومة جوهرية.
أعِد المسودّة البديلة كاملة فقط.`;

  const { text, raw } = await callClaude(c.env, {
    model: c.env.GENERATION_MODEL,
    system,
    messages: [
      {
        role: 'user',
        content: `${instruction ? `توجيه إضافي: ${instruction}\n\n` : ''}المسودّة الحالية:\n\n${msg.content.slice(0, 40000)}`,
      },
    ],
    max_tokens: 8192,
    temperature: 0.7,
  });
  await logUsage(c.env, {
    userId: user.id,
    kind: 'generation',
    model: c.env.GENERATION_MODEL,
    ...usageFromRaw(raw),
    consultationType: msg.consultation_type ?? undefined,
  });

  const last = await c.env.DB.prepare('SELECT MAX(version) AS v FROM draft_versions WHERE message_id = ?')
    .bind(msg.id)
    .first<{ v: number | null }>();
  const versionId = uuid();
  await c.env.DB.prepare(
    'INSERT INTO draft_versions (id, message_id, version, content, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(versionId, msg.id, (last?.v ?? 0) + 1, text, 'صياغة بديلة', Date.now())
    .run();

  return c.json({ ok: true, version_id: versionId, content: text });
});

// اعتماد المسودّة (بوّابة ما قبل التصدير)
app.post('/:messageId/approve', async (c) => {
  const user = c.get('user');
  const msg = await ownedMessage(c, c.req.param('messageId'));
  if (!msg) return c.json({ error: 'الرسالة غير موجودة' }, 404);
  const { note } = await c.req.json().catch(() => ({}));
  await c.env.DB.prepare(
    'INSERT INTO message_approvals (message_id, approved_by, approved_at, note) VALUES (?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET approved_by = excluded.approved_by, approved_at = excluded.approved_at, note = excluded.note'
  )
    .bind(msg.id, user.id, Date.now(), note ?? null)
    .run();
  return c.json({ ok: true });
});

app.delete('/:messageId/approve', async (c) => {
  const msg = await ownedMessage(c, c.req.param('messageId'));
  if (!msg) return c.json({ error: 'الرسالة غير موجودة' }, 404);
  await c.env.DB.prepare('DELETE FROM message_approvals WHERE message_id = ?').bind(msg.id).run();
  return c.json({ ok: true });
});

export default app;
