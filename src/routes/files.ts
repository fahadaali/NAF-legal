// مسارات الملفات: الرفع والاستخراج والتصدير — §11
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { uuid } from '../lib/crypto';
import { extractText } from '../lib/extract';
import { buildDocx } from '../lib/docx';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

const MAX_SIZE = 15 * 1024 * 1024; // 15MB
const ALLOWED = ['application/pdf', 'text/plain', 'text/markdown', 'image/png', 'image/jpeg', 'image/webp'];
const ALLOWED_EXT = ['pdf', 'txt', 'md', 'docx', 'png', 'jpg', 'jpeg', 'webp'];

// رفع ملف إلى محادثة + استخراج نصّه
app.post('/upload/:conversationId', async (c) => {
  const user = c.get('user');
  const conversationId = c.req.param('conversationId');

  const conv = await c.env.DB.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
    .bind(conversationId, user.id)
    .first();
  if (!conv) return c.json({ error: 'المحادثة غير موجودة' }, 404);

  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ error: 'لم يُرفَق ملف' }, 400);
  if (file.size > MAX_SIZE) return c.json({ error: 'حجم الملف يتجاوز الحد (15MB)' }, 413);

  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  const isDocx = ext === 'docx' || file.type.includes('officedocument.wordprocessingml');
  if (!ALLOWED.includes(file.type) && !ALLOWED_EXT.includes(ext) && !isDocx) {
    return c.json({ error: 'نوع الملف غير مدعوم' }, 415);
  }

  const buf = await file.arrayBuffer();
  const id = uuid();
  const r2Key = `uploads/${user.id}/${conversationId}/${id}-${sanitize(file.name)}`;
  await c.env.R2.put(r2Key, buf, { httpMetadata: { contentType: file.type || 'application/octet-stream' } });

  let parsedText = '';
  let parseError: string | null = null;
  try {
    parsedText = await extractText(c.env, buf, file.type, file.name);
  } catch (e: any) {
    parseError = String(e?.message ?? e);
  }

  await c.env.DB.prepare(
    'INSERT INTO attachments (id, conversation_id, r2_key, filename, mime, size, parsed_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(id, conversationId, r2Key, file.name, file.type, file.size, parsedText || null, Date.now())
    .run();

  return c.json({
    id,
    filename: file.name,
    size: file.size,
    mime: file.type,
    extracted_chars: parsedText.length,
    parse_error: parseError,
  });
});

// تصدير رسالة إلى Word أو نص (GET ليعمل مع روابط التنزيل المباشرة)
app.get('/export/:messageId', async (c) => {
  const user = c.get('user');
  const messageId = c.req.param('messageId');
  const format = c.req.query('format') === 'txt' ? 'txt' : 'docx';

  // تأكيد ملكية الرسالة عبر المحادثة
  const msg = await c.env.DB.prepare(
    `SELECT m.id, m.content, c.title, c.consultation_type FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.id = ? AND c.user_id = ?`
  )
    .bind(messageId, user.id)
    .first<{ content: string; title: string; consultation_type: string | null }>();
  if (!msg) return c.json({ error: 'الرسالة غير موجودة' }, 404);

  const title = msg.title || 'مسودّة مستشار ناف';

  if (format === 'txt') {
    const body = `${title}\n\n${msg.content}`;
    return new Response(body, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="naf-${messageId}.txt"`,
      },
    });
  }

  // رأسية الشركة إن رُفعت (§2 قوالب)
  let letterhead;
  try {
    const lhMime = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'letterhead_mime'").first<{ value: string }>();
    if (lhMime?.value) {
      const obj = await c.env.R2.get('settings/letterhead');
      if (obj) {
        const ext = lhMime.value.includes('jp') ? 'jpeg' : 'png';
        letterhead = { bytes: new Uint8Array(await obj.arrayBuffer()), ext: ext as 'png' | 'jpeg' };
      }
    }
  } catch {}

  const docx = buildDocx(title, msg.content, letterhead);
  const r2Key = `exports/${user.id}/${messageId}.docx`;
  await c.env.R2.put(r2Key, docx, {
    httpMetadata: { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  });
  await c.env.DB.prepare('INSERT INTO exports (id, message_id, format, r2_key, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(uuid(), messageId, 'docx', r2Key, Date.now())
    .run();

  return new Response(docx, {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'content-disposition': `attachment; filename="naf-${messageId}.docx"`,
    },
  });
});

function sanitize(name: string): string {
  return name.replace(/[^\w.\-؀-ۿ]/g, '_').slice(0, 80);
}

export default app;
