// مسارات الملفات: الرفع والاستخراج والتصدير — §11
import { Hono, type Context } from 'hono';
import { requireAuth } from '../lib/auth';
import { uuid } from '../lib/crypto';
import { TRUNCATED_NOTE, UNREAD_PAGE_NOTE } from '../lib/extract';
import { startExtraction, MAX_TEXT, type PageLayout } from '../lib/attachmentExtraction';
import { buildDocx, annotateDates } from '../lib/docx';
import { splitDocTitle, stripLawyerNotes, toPlainText } from '../lib/draftText';
import { loadDocTemplate, loadLetterhead, LETTERHEAD_KEY } from '../lib/docTemplate';
import { toHijri } from '../lib/hijri';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const MAX_SIZE = 15 * 1024 * 1024; // 15MB

/** حدّا صور الصفحات الممسوحة — يوافقان `MAX_OCR_PAGES` ورسمَ الصفحة في `web/src/lib/extractText.ts`. */
const MAX_PAGE_IMAGES = 60;
const MAX_PAGE_IMAGE_SIZE = 4 * 1024 * 1024;
/**
 * الأنواع المقبولة، ونوعُ كلٍّ منها كما يُخزَّن ويُقدَّم.
 *
 * **والنوع من هذا الجدول لا من المتصفّح.** كان يُخزَّن `file.type` كما أرسله
 * المتصفّح ثم يُقدَّم به الملفّ من نطاق المنصة نفسه، فملفٌّ اسمه «تقرير.pdf»
 * معلَنٌ `text/html` كان يُعرض صفحةً تُنفَّذ نصوصها بصلاحيات المنصة.
 */
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** الامتدادُ ونوعُه المعتمد — من الامتداد أولاً، ثم من النوع المعلَن إن طابق الجدول. */
function canonicalType(name: string, declared: string | null): { ext: string; mime: string } | null {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (MIME_BY_EXT[ext]) return { ext, mime: MIME_BY_EXT[ext] };
  const base = (declared ?? '').split(';')[0].trim().toLowerCase();
  const hit = Object.entries(MIME_BY_EXT).find(([, m]) => m === base);
  return hit ? { ext: hit[0], mime: hit[1] } : null;
}

/**
 * يرفع ملفاً إلى محادثة، ويردّ **قبل** استخراج نصّه.
 *
 * **والاستخراج بعد الردّ لأنه نداءٌ إلى نموذج لا قراءةُ ملف.** ملفُّ PDF أو
 * صورةٍ يمرّ على `extractViaClaude` — ثوانٍ عشرٌ أو أكثر — وكان يقع بين وصول
 * البايتات وردِّ الخادم. فيرى الرافع دائرةً تدور بلا خبر، ويظنّ الرفع متعثّراً
 * فيُلغيه ويعيده، فيقع النداءُ مرّتين ويطول مرّتين.
 *
 * فالبايتات تُحفَظ في R2 والصفُّ يُكتب `pending`، ويردّ الخادم فوراً بمعرِّفٍ
 * تعرضه الشاشة شارةً. ثم يجري الاستخراج في منفّذٍ بالخلفية (`startExtraction`)
 * وتسأل الشاشة عن حاله. والملف مرفوعٌ ومحفوظٌ ويُنزَّل في كل هذه المدّة، أَخرج
 * نصُّه أم لم يخرج.
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

  const kind = canonicalType(file.name, file.type);
  if (!kind) return c.json({ error: 'نوع الملف غير مدعوم' }, 415);
  const mime = kind.mime;

  const buf = await file.arrayBuffer();
  const id = uuid();
  const r2Key = `uploads/${user.id}/${conversationId}/${id}-${sanitize(file.name)}`;
  await c.env.R2.put(r2Key, buf, { httpMetadata: { contentType: mime } });

  /* نصٌّ اُستخرج في المتصفّح — إن جاء فلا نداءَ للنموذج أصلاً.
     المتصفّح يقرأ ملفّ PDF بـMuPDF قبل أن يرفعه (`web/src/lib/extractText.ts`)،
     فيصل النصّ مع البايتات في طلبٍ واحد. وكان كلُّ ملفٍّ يُرسَل كاملاً إلى
     كلود ليقرأه — عقدٌ من عشرين صفحة يكلّف ما يكلّفه في كل رفعة.

     والحدّ حارسٌ لا تجميل: `parsed_text` عمودٌ في D1، وحقلُ نموذجٍ بلا سقف
     يملؤه من يشاء بما يشاء. */
  const clientText = (form.get('text')?.toString() ?? '').slice(0, MAX_TEXT).trim();

  /* أو صفحاتٌ بعضُها نصٌّ قرأه المتصفّح وبعضُها صورٌ رسمها لصفحاتٍ بلا طبقة
     نصّ. فلا يُقرأ هنا إلا الصور، ثم يوضع كلُّ نصٍّ في موضع صفحته. وما لا
     يستقيم من ذلك يُترك ويُقرأ الملفُّ كلُّه كما كان. */
  const layout = clientText ? null : parseLayout(form);

  /* الملفُّ نفسه رُفع من قبل وقُرئ: يأخذ نصَّه فوراً ولا يُقرأ ثانيةً.
     ولا يُعاد نصٌّ ناقص — قُصّ أو غابت منه صفحة — فقراءةٌ جديدة قد تُتمّه. */
  const contentHash = await sha256Hex(buf);
  const reused = clientText ? null : await reusableText(c.env, user.id, contentHash);
  const knownText = clientText || reused || '';

  // `message_id` يبقى فارغاً: مرفوعٌ في صندوق الكتابة ولم يُرسَل بعد.
  await c.env.DB.prepare(
    `INSERT INTO attachments (id, conversation_id, r2_key, filename, mime, size, parsed_text, parse_status, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      conversationId,
      r2Key,
      file.name,
      mime,
      file.size,
      knownText || null,
      knownText ? 'ready' : 'pending',
      contentHash,
      Date.now()
    )
    .run();

  // ما قُرئ محلّياً لا يُقرأ ثانيةً. وما لم يُقرأ — صورةٌ أو ممسوحٌ ضوئياً —
  // يتولّاه الخادم بصرياً: صورُ صفحاته وحدها إن جاءت، وإلا الملفُّ كلُّه.
  if (!knownText) {
    await startExtraction(c.env, c.executionCtx, { id, buf, mime, filename: file.name, layout });
  }

  return c.json({
    id,
    filename: file.name,
    size: file.size,
    mime,
    parse_status: knownText ? 'ready' : 'pending',
  });
});

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** ذيولٌ يكتبها الاستخراج في نصٍّ ناقص (`src/lib/extract.ts`) — ونصٌّ يحملها لا يُعاد. */
const INCOMPLETE_MARKS = [TRUNCATED_NOTE.trim(), UNREAD_PAGE_NOTE];

/**
 * نصُّ ملفٍّ بالبصمة نفسها رفعه **المستخدمُ نفسه** وقُرئ كاملاً، أو `null`.
 * والقيد بالمستخدم مقصود: انظر `migrations/0033_attachment_content_hash.sql`.
 */
async function reusableText(env: Env, userId: string, hash: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT a.parsed_text AS t FROM attachments a
     JOIN conversations c ON c.id = a.conversation_id
     WHERE a.content_hash = ? AND c.user_id = ? AND a.parse_status = 'ready'
       AND a.parsed_text IS NOT NULL AND a.parsed_text != ''
     ORDER BY a.created_at DESC LIMIT 1`
  )
    .bind(hash, userId)
    .first<{ t: string }>()
    .catch(() => null);
  if (!row?.t || INCOMPLETE_MARKS.some((m) => row.t.includes(m))) return null;
  return row.t;
}

/** يقرأ `layout` و`page` من النموذج، أو `null` إن لم يستقم شيءٌ منهما. */
function parseLayout(form: FormData): PageLayout | null {
  const raw = form.get('layout');
  if (typeof raw !== 'string') return null;
  let pages: unknown;
  try {
    pages = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(pages) || !pages.every((p) => p === null || typeof p === 'string')) return null;
  const files = form.getAll('page').filter((f): f is File => f instanceof File);
  const blanks = pages.filter((p) => p === null).length;
  if (!blanks || blanks !== files.length || files.length > MAX_PAGE_IMAGES) return null;
  if (files.some((f) => f.size > MAX_PAGE_IMAGE_SIZE || !f.type.startsWith('image/'))) return null;
  // والنصُّ الآتي مع الصور محدودٌ بحدّ النصّ نفسه.
  let budget = MAX_TEXT;
  const capped = (pages as (string | null)[]).map((p) => {
    if (p === null) return null;
    const t = p.slice(0, Math.max(0, budget));
    budget -= t.length;
    return t;
  });
  return { pages: capped, images: files.map((f) => ({ load: () => f.arrayBuffer(), mime: f.type })) };
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
  /* النوع يُعاد اشتقاقه عند التقديم لا يُقرأ كما خُزِّن: صفوفٌ رُفعت قبل الجدول
     تحمل نوعاً أعلنه المتصفّح. وما لا يطابق الجدول يُقدَّم بايتاتٍ للتنزيل.
     و`sandbox` يمنع أيَّ نصٍّ في الملف من العمل بصلاحيات المنصة — إلا PDF:
     عارضُ المتصفّح لا يعمل في وثيقةٍ معزولة، وPDF لا يحمل HTML يُنفَّذ. */
  const kind = canonicalType(att.filename, att.mime);
  const type = kind ? (kind.mime.startsWith('text/') ? `${kind.mime}; charset=utf-8` : kind.mime) : 'application/octet-stream';
  return new Response(obj.body, {
    headers: {
      'content-type': type,
      'x-content-type-options': 'nosniff',
      ...(kind?.ext === 'pdf' ? {} : { 'content-security-policy': 'sandbox' }),
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
    // نصٌّ مجرّد لا Markdown: لا `#` ولا `**` ولا أسطر فارغة متتالية، ولا «ملاحظات للمحامي».
    const split = splitDocTitle(stripLawyerNotes(msg.content));
    const body = `${split.title ?? title}\n\n${toPlainText(split.body)}\n`;
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
