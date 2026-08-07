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
  diffChunks,
  listLawChanges,
  upsertLegalChunks,
  embedPending,
  searchLegal,
  getArticle,
  getChunkAmendment,
  getChunkById,
  listLaws,
  listLawArticles,
  listReviewQueue,
  listReviewAudit,
  listCaptureBatches,
  reviewChunk,
  reviewDashboard,
  getLawWithRegulations,
  legalStats,
  type ReviewAction,
  type ReviewQueueKey,
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
 * كم مقطعاً يُضمَّن بعد قرار مراجعة.
 *
 * التحرير يمسّ مادةً واحدة، فالسقف صغير — لكنه ليس واحداً: قد يكون في
 * الطابور معلَّقٌ من قبل، وتصريفُه مع الحفظ أرخص من انتظار الليل.
 */
const REVIEW_EMBED_BUDGET = 25;

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
  // مقارنةٌ لا كتابة: يُقرأ الملف ويُقابَل بما في القاعدة ويُردّ الفرق.
  // ويُرسَل الملف كاملاً لا مقطّعاً، وإلا عُدَّ سائرُ النظام غائباً عنه.
  const dryRun = c.req.query('dry_run') === '1';
  // «تصحيح بيانات»: الفرق الذي سيظهر بين هذا الاستيراد وسابقه خطأُ سحبٍ ظهر
  // اليوم لا تعديلٌ نظاميّ وقع اليوم. ويُوسَم به سجلّ التحديث فلا يقول إن
  // النظام عُدِّل هذا العام وهو عُدِّل بمرسومه قبل سنوات.
  const correction = c.req.query('correction') === '1';
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
    // ما سيُحجب عن الاسترجاع حتى يُراجَع، وما سيُعرض بتنبيه أن نصّه أصليّ.
    // يُقالان لأن ملفاً نصفُ مواده محجوب يبدو مستورَداً تامّاً في العمود، ثم
    // لا يجد المحامي أثره في البحث ولا يعرف لماذا.
    needs_review: parsed.needsReview,
    amendment_pending: parsed.amendmentPending,
  };

  if (dryRun) {
    if (!parsed.rows.length) {
      return c.json({ ...report, ok: false, written: false, dry_run: true, error: 'لا سطر صالح في الملف' }, 422);
    }
    return c.json({ ...report, ok: true, written: false, dry_run: true, diff: await diffChunks(c.env, parsed.rows) });
  }

  if (parsed.errors.length && !partial) {
    return c.json({ ...report, ok: false, written: false, error: 'أسطر غير صالحة — لم يُكتب شيء' }, 422);
  }
  if (!parsed.rows.length) {
    return c.json({ ...report, ok: false, written: false, error: 'لا سطر صالح في الملف' }, 422);
  }

  // استبدال لا إضافة: المفتاح `id`. وما تغيّر يُؤرشَف قبل أن يُكتب فوقه.
  const importId = uuid();
  const { inserted, updated, archived, superseded } = await upsertLegalChunks(c.env, parsed.rows, {
    importId,
    correction,
  });

  const full = {
    ...report,
    inserted,
    updated,
    archived,
    // نسخٌ دخلت سجلّ التحديث من `text_superseded` بتاريخ تعديلها لا بتاريخ اليوم.
    superseded,
    mode: partial ? 'partial' : 'strict',
    kind: correction ? 'correction' : 'import',
  };
  await c.env.DB.prepare(
    `INSERT INTO legal_imports (id, actor_id, filename, lines, inserted, updated, failed, report_json, created_at, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      importId, c.get('user').id, filename || null, parsed.total, inserted, updated,
      parsed.errors.length, JSON.stringify(full), Date.now(), correction ? 'correction' : 'import'
    )
    .run();
  await audit(c, 'legal.import', importId, {
    filename, lines: parsed.total, inserted, updated, archived, superseded,
    failed: parsed.errors.length, kind: correction ? 'correction' : 'import',
  });

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
    'SELECT id, actor_id, filename, lines, inserted, updated, failed, created_at, kind FROM legal_imports ORDER BY created_at DESC LIMIT 50'
  ).all();
  return c.json({ imports: rows.results });
});

/**
 * ما ينتظر المراجعة البشرية.
 *
 * وهذا المسار وحده يراه: البحث والمحادثة والتقارير لا يصلها المحجوب، لأن
 * الحجب في SQL داخل طبقة الاسترجاع. و`queue` يحصره في طابورٍ بعينه،
 * و`law_id` و`captured_at` و`doc_type` تحصره في نظامٍ أو دفعةٍ أو نوع.
 */
app.get('/review', requireAdmin, async (c) => {
  const { articles, total } = await listReviewQueue(c.env, {
    queue: (c.req.query('queue') as ReviewQueueKey) || null,
    lawId: c.req.query('law_id') ?? null,
    capturedAt: c.req.query('captured_at') ?? null,
    docType: c.req.query('doc_type') ?? null,
    offset: Number(c.req.query('offset') ?? 0),
    limit: Number(c.req.query('limit') ?? 25),
  });
  return c.json({ articles, total });
});

/** لوحة حال المراجعة وعدّادات الطوابير — استعلامٌ حيّ لا رقمٌ محفوظ. */
app.get('/review/dashboard', requireAdmin, async (c) =>
  c.json(
    await reviewDashboard(c.env, {
      lawId: c.req.query('law_id') ?? null,
      capturedAt: c.req.query('captured_at') ?? null,
      docType: c.req.query('doc_type') ?? null,
    })
  )
);

/** دفعات الاستيراد المتاحة للترشيح. */
app.get('/review/batches', requireAdmin, async (c) => c.json({ batches: await listCaptureBatches(c.env) }));

/** سجلّ التدقيق: لمادةٍ بعينها بـ`?chunk_id=`، أو آخر ما وقع في المنصة. */
app.get('/review/audit', requireAdmin, async (c) =>
  c.json({
    entries: await listReviewAudit(c.env, {
      chunkId: c.req.query('chunk_id') ?? null,
      limit: Number(c.req.query('limit') ?? 50),
    }),
  })
);

/**
 * قرار المراجع على مادة: اعتماد · تحرير واعتماد · استبعاد · تأجيل · ملاحظة · تراجع.
 *
 * قرارٌ على مادةٍ بعينها لا على نظامها ولا على نوعها. ويسقط وحدَه إن تغيّر
 * نصُّها أو نافذةُ تعديلها في استيرادٍ لاحق — فاعتمادُ نصٍّ لم يعد هو النصّ
 * ليس اعتماداً. وكلُّ تغيير يُقيَّد في سجلّ التدقيق.
 */
app.post('/review/:id', requireAdmin, async (c) => {
  // الوسيط يُفقد Hono استنتاجَ نوع المعامل، فيُقرأ بقيمة احتياطية فارغة —
  // ومعرّفٌ فارغ لا يجد مادة، فيُردّ ٤٠٤ كما لو طُلبت مادةٌ غير موجودة.
  const id = c.req.param('id') ?? '';
  const body = await c.req.json<{ action?: string; text?: string; note?: string }>().catch(() => ({}) as any);
  const action = (body.action ?? 'approve') as ReviewAction;
  if (!['approve', 'edit', 'exclude', 'defer', 'note', 'undo'].includes(action)) {
    return c.json({ error: 'الإجراء غير معروف' }, 400);
  }

  const result = await reviewChunk(c.env, id, action, c.get('user').id, { text: body.text, note: body.note });
  if (!result.ok) return c.json({ error: result.error }, result.error === 'المادة غير موجودة' ? 404 : 400);

  await audit(c, 'legal.review', id, { action, status: result.status });
  // التضمين بعد الردّ: الكتابة هي العقد، والمتجه يلحق بها. وما لم يلحق في
  // هذا الطلب يبقى معلَّقاً ويصرّفه الـCron — والبحث اللفظي محدَّثٌ سلفاً
  // لأن محفّز الفهرس يعمل مع الكتابة نفسها.
  if (result.reembedded) c.executionCtx.waitUntil(embedPending(c.env, REVIEW_EMBED_BUDGET).then(() => {}));

  return c.json({ ok: true, id, status: result.status, reembedded: !!result.reembedded });
});

/**
 * نافذة التعديلات الخام لمادةٍ بعينها — وما نُسخ من نصّها.
 *
 * تُقرأ بطلبٍ صريح لا مع كل نتيجة بحث: نصٌّ خام قد يبلغ آلاف الأحرف، ولا
 * يُعرض مكان النصّ النافذ أبداً.
 */
app.get('/articles/:id/amendment', async (c) => {
  const row = await getChunkAmendment(c.env, c.req.param('id'));
  if (!row) return c.json({ error: 'المادة غير موجودة' }, 404);
  return c.json({ amendment: row });
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
    // `lexical=1` يبحث بلا نموذج تضمين — لشاشات البحث المباشر.
    lexicalOnly: c.req.query('lexical') === '1',
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
    // موجودةٌ لكنها محجوبة: يُقال لماذا غابت بدل «غير موجودة» المضلّلة —
    // والسببان مختلفان، فمنسوخةٌ خرجت من النظام ومحجوبةٌ لم تُراجَع بعد.
    const exists = await c.env.DB
      .prepare('SELECT is_repealed, status, needs_review, reviewed_at FROM legal_chunks WHERE id = ?')
      .bind(id)
      .first<{ is_repealed: number; status: string; needs_review: number; reviewed_at: number | null }>();
    if (!exists) return c.json({ error: 'المادة غير موجودة' }, 404);
    if (exists.is_repealed === 1 || exists.status === 'repealed') {
      return c.json({ error: 'المادة منسوخة — أضِف include_repealed=1 للاطّلاع عليها', repealed: true }, 404);
    }
    return c.json(
      { error: 'المادة بانتظار المراجعة — تظهر في شاشة مراجعة المواد حتى تُعتمد', needs_review: true },
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

/** سجلّ تحديث نظام: ما أُزيح من مواده ومتى وبأيّ حقل. */
app.get('/laws/:lawId/changes', async (c) => {
  const { changes, total } = await listLawChanges(c.env, c.req.param('lawId'), {
    offset: Number(c.req.query('offset') ?? 0),
    limit: Number(c.req.query('limit') ?? 25),
  });
  return c.json({ changes, total });
});

/** نظامٌ مع لوائحه — العلاقة عبر `parent_law_id`. */
app.get('/laws/:lawId', async (c) => {
  const { law, regulations } = await getLawWithRegulations(c.env, c.req.param('lawId'));
  if (!law) return c.json({ error: 'النظام غير موجود' }, 404);
  return c.json({ law, regulations });
});

export default app;
