// مسارات الملفات: الرفع والاستخراج والتصدير — §11
import { Hono, type Context } from 'hono';
import { requireAuth } from '../lib/auth';
import { uuid } from '../lib/crypto';
import { extractText } from '../lib/extract';
import { buildDocx, annotateDates } from '../lib/docx';
import { loadDocTemplate, loadLetterhead, LETTERHEAD_KEY } from '../lib/docTemplate';
import { toHijri } from '../lib/hijri';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const MAX_SIZE = 15 * 1024 * 1024; // 15MB
const ALLOWED = ['application/pdf', 'text/plain', 'text/markdown', 'image/png', 'image/jpeg', 'image/webp'];
const ALLOWED_EXT = ['pdf', 'txt', 'md', 'docx', 'png', 'jpg', 'jpeg', 'webp'];

/**
 * يرفع ملفاً إلى محادثة، ويردّ **قبل** استخراج نصّه.
 *
 * **والاستخراج بعد الردّ لأنه نداءٌ إلى نموذج لا قراءةُ ملف.** ملفُّ PDF أو
 * صورةٍ يمرّ على `extractViaClaude` — ثوانٍ عشرٌ أو أكثر — وكان يقع بين وصول
 * البايتات وردِّ الخادم. فيرى الرافع دائرةً تدور بلا خبر، ويظنّ الرفع متعثّراً
 * فيُلغيه ويعيده، فيقع النداءُ مرّتين ويطول مرّتين.
 *
 * فالبايتات تُحفَظ في R2 والصفُّ يُكتب `pending`، ويردّ الخادم فوراً بمعرِّفٍ
 * تعرضه الشاشة شارةً. ثم يجري الاستخراج في `ctx.waitUntil` وتسأل الشاشة عن
 * حاله. والملف مرفوعٌ ومحفوظٌ ويُنزَّل في كل هذه المدّة، أَخرج نصُّه أم لم
 * يخرج.
 */
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

  // `message_id` يبقى فارغاً: مرفوعٌ في صندوق الكتابة ولم يُرسَل بعد.
  await c.env.DB.prepare(
    `INSERT INTO attachments (id, conversation_id, r2_key, filename, mime, size, parsed_text, parse_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', ?)`
  )
    .bind(id, conversationId, r2Key, file.name, file.type, file.size, Date.now())
    .run();

  c.executionCtx.waitUntil(runExtract(c.env, id, buf, file.type, file.name));

  return c.json({
    id,
    filename: file.name,
    size: file.size,
    mime: file.type,
    parse_status: 'pending',
  });
});

/**
 * يستخرج نصّ المرفق ويَسِم حالَه، ولا يترك صفّاً معلَّقاً مهما وقع.
 *
 * رميةٌ من تحت `ctx.waitUntil` تُبتلع في العامل بلا أثر، فيبقى الصفُّ
 * `pending` أبداً وتبقى الشارة تدور. فما يخرج من هنا حالٌ مستقرّة دائماً:
 * `ready` أو `error`.
 *
 * ونصٌّ فارغ حالُه `error` كتعثّر النداء سواء: نتيجتُهما على القارئ واحدة —
 * ملفٌّ قائمٌ يُنزَّل ولا يبلغ نصُّه المساعد — وحالان لنتيجةٍ واحدة تفترقان
 * أوّل شاشة.
 */
async function runExtract(env: Env, id: string, buf: ArrayBuffer, mime: string, filename: string): Promise<void> {
  let text = '';
  let error: string | null = null;
  try {
    text = await extractText(env, buf, mime, filename);
  } catch (e: any) {
    error = String(e?.message ?? e);
  }
  if (!text.trim() && !error) error = 'لم يُستخرَج نصّ من الملف';

  await env.DB.prepare('UPDATE attachments SET parsed_text = ?, parse_status = ?, parse_error = ? WHERE id = ?')
    .bind(error ? null : text, error ? 'error' : 'ready', error, id)
    .run()
    .catch(() => {});
}

/** حال المرفق — تسألها الشاشة ما دامت الشارة تدور. */
app.get('/attachments/:id', async (c) => {
  const att = await ownedAttachment(c);
  if (!att) return c.json({ error: 'المرفق غير موجود' }, 404);
  return c.json({
    id: att.id,
    filename: att.filename,
    mime: att.mime,
    size: att.size,
    message_id: att.message_id,
    parse_status: att.parse_status,
    created_at: att.created_at,
  });
});

/**
 * الملف كما رُفع — للنافذة العائمة وللتنزيل.
 *
 * وكان لا مسار له أصلاً: يُرفع الملف إلى R2 ولا شيء في المنصة يُخرجه منها.
 * فالشارة تقول إن ملفاً هناك ولا سبيل إلى رؤيته — «مرفوعٌ في مكانٍ لا يُعرَف».
 *
 * و`inline` لا `attachment`: النافذة تعرضه في إطارها، وزرُّ التنزيل يطلب
 * `?download=1` فيقلبها. وترويسةٌ واحدة تخدم البابين تجعل العرض تنزيلاً.
 */
app.get('/attachments/:id/file', async (c) => {
  const att = await ownedAttachment(c);
  if (!att) return c.json({ error: 'المرفق غير موجود' }, 404);

  const obj = await c.env.R2.get(att.r2_key);
  if (!obj) return c.json({ error: 'المرفق غير موجود' }, 404);

  const disposition = c.req.query('download') ? 'attachment' : 'inline';
  return new Response(obj.body, {
    headers: {
      'content-type': att.mime || 'application/octet-stream',
      // الاسم عربيٌّ غالباً، و`filename` وحدها لا تحمل غير ASCII.
      'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
      'cache-control': 'private, max-age=300',
    },
  });
});

/** النصّ المستخرَج — تعرضه النافذة لِما لا يُعرض في إطار (docx ونصّ). */
app.get('/attachments/:id/text', async (c) => {
  const att = await ownedAttachment(c);
  if (!att) return c.json({ error: 'المرفق غير موجود' }, 404);
  return new Response(att.parsed_text ?? '', {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
});

/**
 * حذف مرفقٍ **لم يُرسَل بعد**.
 *
 * والقيد مقصود: المرفق المرسَل جزءٌ من سجلّ المحادثة — الرسالة تقول إنها
 * حملته والمساعد بنى عليه — وحذفُه يترك فقاعةً تشير إلى ملفٍّ لا وجود له.
 * وما لم يُرسَل بعدُ ملكُ صاحبه وحده، يزيله من صندوق كتابته كما وضعه.
 */
app.delete('/attachments/:id', async (c) => {
  const att = await ownedAttachment(c);
  if (!att) return c.json({ error: 'المرفق غير موجود' }, 404);
  if (att.message_id) return c.json({ error: 'المرفق مُرسَل مع رسالته ولا يُحذف منها' }, 409);

  await c.env.R2.delete(att.r2_key).catch(() => {});
  await c.env.DB.prepare('DELETE FROM attachments WHERE id = ?').bind(att.id).run();
  return c.json({ ok: true });
});

interface AttachmentRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  r2_key: string;
  filename: string;
  mime: string | null;
  size: number | null;
  parsed_text: string | null;
  parse_status: string;
  created_at: number;
}

/**
 * يقرأ المرفق بشرط ملكيته.
 *
 * والملكية تُقرأ من المحادثة لا من المرفق: `attachments` بلا `user_id`،
 * والمعرِّف وحده يفتح ملفَّ غيرِك لو لم يُقيَّد. والقيد في `JOIN` واحد
 * يمرّ به كلُّ مسارٍ هنا — لا في كلِّ مسارٍ على حدة حيث يُنسى واحد.
 */
async function ownedAttachment(c: AppContext): Promise<AttachmentRow | null> {
  const user = c.get('user');
  return await c.env.DB.prepare(
    `SELECT a.id, a.conversation_id, a.message_id, a.r2_key, a.filename, a.mime, a.size,
            a.parsed_text, a.parse_status, a.created_at
     FROM attachments a
     JOIN conversations cv ON cv.id = a.conversation_id
     WHERE a.id = ? AND cv.user_id = ?`
  )
    .bind(c.req.param('id'), user.id)
    .first<AttachmentRow>();
}

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

  // بوّابة الاعتماد: إن فُعِّلت في الإعدادات، يُمنع التصدير قبل اعتماد محامٍ
  const gate = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'require_approval_before_export'")
    .first<{ value: string }>();
  if (gate?.value === 'true') {
    const approved = await c.env.DB.prepare('SELECT message_id FROM message_approvals WHERE message_id = ?')
      .bind(messageId)
      .first();
    if (!approved) {
      return c.json({ error: 'التصدير موقوف: يلزم اعتماد المسودّة من محامٍ قبل التصدير.' }, 403);
    }
  }

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

  // قالب المستند ورأسية الشركة — المصدر نفسه الذي تقرأه الطباعة (§2 قوالب)
  const [template, letterhead] = await Promise.all([loadDocTemplate(c.env), loadLetterhead(c.env)]);

  // يُلحق المكافئ الهجري بالتواريخ الميلادية في المخرَج النهائي
  const docx = buildDocx(title, annotateDates(msg.content, toHijri), { template, letterhead });
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

/**
 * قالب المستند لقالب الطباعة في المتصفّح.
 *
 * الطباعة تجري في نافذة القارئ لا في الخادم، فتحتاج القيم نفسها التي يبني
 * بها Word مستنده — وإلا خرج المستندان بخطّين وهامشين.
 */
app.get('/doc-template', async (c) => {
  const template = await loadDocTemplate(c.env);
  const lh = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'letterhead_mime'")
    .first<{ value: string }>()
    .catch(() => null);
  return c.json({ template, letterhead: !!lh?.value });
});

/**
 * صورة الرأسية كما رُفعت — المتجهة متجهةً لا نقطيّتها.
 *
 * نافذة الطباعة من أصل المنصة نفسه، فتحمّلها بكوكي الجلسة. ولا تُخزَّن في
 * الوسيط: تتغيّر من لوحة الإدارة، ونسخةٌ محفوظة تُبقي رأسيةً بُدِّلت.
 */
app.get('/letterhead', async (c) => {
  const row = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'letterhead_mime'")
    .first<{ value: string }>()
    .catch(() => null);
  if (!row?.value) return c.json({ error: 'لا توجد رأسية' }, 404);
  const obj = await c.env.R2.get(LETTERHEAD_KEY);
  if (!obj) return c.json({ error: 'لا توجد رأسية' }, 404);
  return new Response(obj.body, {
    headers: { 'content-type': row.value, 'cache-control': 'no-store' },
  });
});

function sanitize(name: string): string {
  return name.replace(/[^\w.\-؀-ۿ]/g, '_').slice(0, 80);
}

export default app;
