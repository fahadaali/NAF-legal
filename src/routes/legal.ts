// المحتوى النظامي المستورد: الاستيراد والبحث والاستدعاء.
//
// الاستيراد للمسؤول وحده، والبحث لكل من دخل. والتصفية على السريان لا تُقرَّر
// هنا: `lib/legal.ts` يحملها في SQL نفسه، فما يُكتب في هذا الملف لا يستطيع
// تجاوزها ولو أراد.
import { Hono } from 'hono';
import { requireAuth, requireAdmin, audit } from '../lib/auth';
import { uuid } from '../lib/crypto';
import {
  parseJsonl,
  summarizeErrors,
  upsertLegalChunks,
  embedPending,
  searchLegal,
  getArticle,
  getChunkById,
  listLaws,
  listLawArticles,
  getLawWithRegulations,
  legalStats,
} from '../lib/legal';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

/** سقف ما يُعرَض من أخطاء الأسطر في التقرير — لئلا يصير الردّ ملفاً ثانياً. */
const MAX_REPORTED_ERRORS = 50;

/**
 * كم مقطعاً يُضمَّن داخل طلب الاستيراد نفسه قبل أن يتولّى الباقيَ الـCron.
 *
 * بقدر دفعة الشاشة (٥٠٠ سطر) فتُضمَّن الدفعة التي وصلت للتوّ ولا يتراكم
 * معلَّقٌ يحتاج ليالي. كان مئةً، فترك من استورد ستّة آلاف مادة ينتظر أربع
 * ليالٍ ليعمل نصفُ بحثه.
 */
const IMPORT_EMBED_BUDGET = 500;

/**
 * استيراد JSONL — سطر واحد = مقطع واحد.
 *
 * الجسم إمّا الملف خاماً (`application/x-ndjson`) أو حقل `file` في نموذج.
 * والافتراضي صارم: سطرٌ واحد فاسد يوقف الدفعة كلها ولا يُكتب منها شيء —
 * نظامٌ نصفه مستورد أسوأ من نظام لم يُستورَد. و`?partial=1` يقبل الصالح
 * ويردّ قائمة ما رُفض.
 */
app.post('/import', requireAdmin, async (c) => {
  const partial = c.req.query('partial') === '1';
  // بناء نصّ التضمين عند غيابه — بطلبٍ صريح وحده، ومعدودٌ في التقرير.
  const buildEmbedText = c.req.query('build_embed_text') === '1';
  const contentType = c.req.header('content-type') ?? '';

  let bytes: ArrayBuffer;
  let filename = c.req.query('filename') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return c.json({ error: 'أرفِق ملف JSONL في الحقل file' }, 400);
    bytes = await file.arrayBuffer();
    filename = filename || file.name;
  } else {
    bytes = await c.req.arrayBuffer();
  }
  if (!bytes.byteLength) return c.json({ error: 'الملف فارغ' }, 400);

  const parsed = parseJsonl(bytes, { buildEmbedText });
  if (!parsed.total) return c.json({ error: 'لا سطور في الملف' }, 400);

  const report = {
    lines: parsed.total,
    accepted: parsed.rows.length,
    failed: parsed.errors.length,
    // الأسباب مجموعةً على **كل** الأسطر لا على المعروض منها: ملفٌّ مولَّد
    // بقالب واحد تفشل أسطره بالسبب نفسه، وسقفُ العرض كان يُخفي الحقيقة خلف
    // «وأخطاء أخرى لم تُعرَض» فلا يعرف صاحب الملف ما الذي يصلحه.
    error_summary: summarizeErrors(parsed.errors),
    errors: parsed.errors.slice(0, MAX_REPORTED_ERRORS),
    errors_truncated: Math.max(0, parsed.errors.length - MAX_REPORTED_ERRORS),
    warnings: parsed.warnings,
    // مدخل المتجه وحده هو ما قُصَّ — المقطع لم يُقسَّم ونصّه كامل كما ورد.
    embed_text_truncated: parsed.longEmbedText,
    // ما بُني نصُّ تضمينه لغيابه. يُقال دائماً: بناءٌ صامت يجعل جودة
    // الاسترجاع تتغيّر بلا أثرٍ يدلّ عليها.
    embed_text_built: parsed.builtEmbedText,
  };

  if (parsed.errors.length && !partial) {
    return c.json({ ...report, ok: false, written: false, error: 'أسطر غير صالحة — لم يُكتب شيء' }, 422);
  }
  if (!parsed.rows.length) {
    return c.json({ ...report, ok: false, written: false, error: 'لا سطر صالح في الملف' }, 422);
  }

  // استبدال لا إضافة: المفتاح `id`.
  const { inserted, updated } = await upsertLegalChunks(c.env, parsed.rows);

  const importId = uuid();
  const full = { ...report, inserted, updated, mode: partial ? 'partial' : 'strict' };
  await c.env.DB.prepare(
    `INSERT INTO legal_imports (id, actor_id, filename, lines, inserted, updated, failed, report_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(importId, c.get('user').id, filename || null, parsed.total, inserted, updated, parsed.errors.length, JSON.stringify(full), Date.now())
    .run();
  await audit(c, 'legal.import', importId, { filename, lines: parsed.total, inserted, updated, failed: parsed.errors.length });

  // التضمين بعد الردّ: الكتابة إلى D1 هي العقد، والتضمين يلحق بها. وما لم
  // يلحق في هذا الطلب يبقى معلَّقاً ويصرّفه الـCron.
  c.executionCtx.waitUntil(embedPending(c.env, IMPORT_EMBED_BUDGET).then(() => {}));

  const stats = await legalStats(c.env);
  return c.json({
    ...full,
    ok: true,
    written: true,
    import_id: importId,
    // التقطيع التلقائي معطَّل في هذا المسار: سطرٌ = مقطع.
    chunking: 'disabled',
    pending_embeddings: stats.pending_embeddings,
  });
});

/** تصريف ما ينتظر التضمين يدوياً (بعد تهيئة الفهرس المتجهي مثلاً). */
app.post('/embed-pending', requireAdmin, async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 200), 1), 1000);
  const result = await embedPending(c.env, limit);
  return c.json(result);
});

app.get('/stats', requireAdmin, async (c) => c.json(await legalStats(c.env)));

app.get('/imports', requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, actor_id, filename, lines, inserted, updated, failed, created_at FROM legal_imports ORDER BY created_at DESC LIMIT 50'
  ).all();
  return c.json({ imports: rows.results });
});

/**
 * البحث الهجين.
 *
 * `include_repealed=1` يفتح الأرشيف صراحةً — وهو الاستثناء الوحيد، ولا
 * يُمرَّر من مسار استشهاد.
 */
app.get('/search', async (c) => {
  const q = c.req.query('q')?.trim() ?? '';
  const hits = await searchLegal(c.env, q, {
    limit: Number(c.req.query('limit') ?? 10),
    lawId: c.req.query('law_id') ?? null,
    docType: c.req.query('doc_type') ?? null,
    articleNo: c.req.query('article_no') ?? null,
    withRegulations: c.req.query('with_regulations') !== '0',
    includeRepealed: c.req.query('include_repealed') === '1',
  });
  return c.json({ results: hits, count: hits.length });
});

/** استدعاء مادة بعينها: `?law_id=&article_no=` أو `?id=`. */
app.get('/article', async (c) => {
  const includeRepealed = c.req.query('include_repealed') === '1';
  const id = c.req.query('id');
  if (id) {
    const hit = await getChunkById(c.env, id, includeRepealed);
    if (hit) return c.json({ results: [hit], count: 1 });
    // موجودةٌ لكنها منسوخة: يُقال لماذا غابت بدل «غير موجودة» المضلّلة.
    const exists = await c.env.DB.prepare('SELECT 1 AS found FROM legal_chunks WHERE id = ?').bind(id).first();
    return c.json(
      exists
        ? { error: 'المادة منسوخة — أضِف include_repealed=1 للاطّلاع عليها', repealed: true }
        : { error: 'المادة غير موجودة' },
      404
    );
  }

  const lawId = c.req.query('law_id');
  const articleNo = c.req.query('article_no');
  if (!lawId || !articleNo) return c.json({ error: 'المطلوب: id أو (law_id و article_no)' }, 400);
  const hits = await getArticle(c.env, { lawId, articleNo, includeRepealed, docType: c.req.query('doc_type') ?? null });
  if (!hits.length) return c.json({ error: 'المادة غير موجودة' }, 404);
  return c.json({ results: hits, count: hits.length });
});

/** الأنظمة المستوردة — لبناء قوائم التصفية. */
app.get('/laws', async (c) => c.json({ laws: await listLaws(c.env) }));

/** مواد نظامٍ بعينه — للتصفّح، مرتّبةً كما وردت في ملفه. */
app.get('/laws/:lawId/articles', async (c) => {
  const { articles, total } = await listLawArticles(c.env, c.req.param('lawId'), {
    offset: Number(c.req.query('offset') ?? 0),
    limit: Number(c.req.query('limit') ?? 50),
    includeRepealed: c.req.query('include_repealed') !== '0',
  });
  return c.json({ articles, total });
});

/** نظامٌ مع لوائحه — العلاقة عبر `parent_law_id`. */
app.get('/laws/:lawId', async (c) => {
  const { law, regulations } = await getLawWithRegulations(c.env, c.req.param('lawId'));
  if (!law) return c.json({ error: 'النظام غير موجود' }, 404);
  return c.json({ law, regulations });
});

export default app;
