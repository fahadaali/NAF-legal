// ملف القضية: عرض مجمّع (محادثات · مسوّدات · مرفقات · مواعيد) + تصدير حزمة ZIP
import { Hono, type Context } from 'hono';
import { requireAuth } from '../lib/auth';
import { zip } from '../lib/zip';
import { buildDocx } from '../lib/docx';
import { CONSULTATION_LABELS } from '../lib/prompts';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

// تجميع بيانات القضية (مقيّدة بالمالك)
async function loadCase(c: Ctx, folderId: string) {
  const user = c.get('user');
  const folder = await c.env.DB.prepare('SELECT id, name, color, created_at FROM case_folders WHERE id = ? AND user_id = ?')
    .bind(folderId, user.id)
    .first<{ id: string; name: string }>();
  if (!folder) return null;

  const conversations = await c.env.DB.prepare(
    'SELECT id, title, consultation_type, created_at, updated_at FROM conversations WHERE folder_id = ? AND user_id = ? ORDER BY updated_at DESC'
  )
    .bind(folderId, user.id)
    .all<{ id: string; title: string; consultation_type: string | null }>();

  const convIds = (conversations.results ?? []).map((x: { id: string }) => x.id);
  const placeholders = convIds.map(() => '?').join(',') || "''";

  const drafts = convIds.length
    ? await c.env.DB.prepare(
        `SELECT m.id, m.content, m.created_at, m.conversation_id, c.title AS conv_title, c.consultation_type,
                (SELECT approved_at FROM message_approvals a WHERE a.message_id = m.id) AS approved_at
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.conversation_id IN (${placeholders}) AND m.role = 'assistant'
         ORDER BY m.created_at DESC`
      )
        .bind(...convIds)
        .all()
    : { results: [] as any[] };

  const attachments = convIds.length
    ? await c.env.DB.prepare(
        `SELECT id, conversation_id, filename, mime, size, r2_key, created_at
         FROM attachments WHERE conversation_id IN (${placeholders}) ORDER BY created_at DESC`
      )
        .bind(...convIds)
        .all()
    : { results: [] as any[] };

  const deadlines = await c.env.DB.prepare(
    'SELECT id, title, kind, due_date, due_hijri, status FROM deadlines WHERE folder_id = ? AND user_id = ? ORDER BY due_date ASC'
  )
    .bind(folderId, user.id)
    .all();

  return { folder, conversations: conversations.results ?? [], drafts: drafts.results ?? [], attachments: attachments.results ?? [], deadlines: deadlines.results ?? [] };
}

app.get('/:folderId', async (c) => {
  const data = await loadCase(c, c.req.param('folderId'));
  if (!data) return c.json({ error: 'القضية غير موجودة' }, 404);
  // لا نُرسل نصّ المسوّدات كاملًا في العرض المجمّع
  return c.json({
    ...data,
    drafts: data.drafts.map((d: any) => ({ ...d, content: undefined, excerpt: String(d.content ?? '').slice(0, 200) })),
  });
});

// تصدير حزمة القضية: مسوّدات Word + المرفقات الأصلية + ملخّص
app.get('/:folderId/export', async (c) => {
  const data = await loadCase(c, c.req.param('folderId'));
  if (!data) return c.json({ error: 'القضية غير موجودة' }, 404);

  const files: Record<string, string | Uint8Array> = {};
  const safe = (s: string) => (s || 'ملف').replace(/[^\w.\-؀-ۿ ]/g, '_').slice(0, 60);

  // ملخّص القضية
  const summary = [
    `# ملف القضية: ${data.folder.name}`,
    '',
    `عدد المحادثات: ${data.conversations.length}`,
    `عدد المسوّدات: ${data.drafts.length}`,
    `عدد المرفقات: ${data.attachments.length}`,
    '',
    '## المواعيد النظامية',
    ...(data.deadlines.length
      ? data.deadlines.map((d: any) => `- ${d.title} — ${d.due_date}${d.due_hijri ? ` (${d.due_hijri})` : ''} [${d.status}]`)
      : ['لا مواعيد.']),
    '',
    '## المحادثات',
    ...data.conversations.map((cv: any) => `- ${cv.title} (${CONSULTATION_LABELS[cv.consultation_type ?? ''] ?? 'استشارة'})`),
    '',
    'تنبيه: جميع المسوّدات مخرجات مساعِدة تتطلّب مراجعة محامٍ مختصّ قبل الاعتماد.',
  ].join('\n');
  files['ملخص-القضية.txt'] = summary;

  // المسوّدات كملفات Word
  let i = 1;
  for (const d of data.drafts as any[]) {
    const label = CONSULTATION_LABELS[d.consultation_type ?? ''] ?? 'مسودّة';
    const name = `مسودات/${String(i).padStart(2, '0')}-${safe(label)}${d.approved_at ? '-معتمدة' : ''}.docx`;
    try {
      files[name] = buildDocx(`${label} — ${d.conv_title ?? ''}`, String(d.content ?? ''));
    } catch {
      files[name.replace('.docx', '.txt')] = String(d.content ?? '');
    }
    i++;
  }

  // المرفقات الأصلية من R2
  for (const a of data.attachments as any[]) {
    try {
      const obj = await c.env.R2.get(a.r2_key);
      if (obj) files[`مرفقات/${safe(a.filename)}`] = new Uint8Array(await obj.arrayBuffer());
    } catch {
      // نتخطّى المرفق المتعذّر
    }
  }

  const bundle = zip(files);
  return new Response(bundle, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="case-${encodeURIComponent(data.folder.name)}.zip"`,
    },
  });
});

export default app;
