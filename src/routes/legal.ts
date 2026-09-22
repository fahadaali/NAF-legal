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
  hiddenReason,
  withAttachments,
  listLaws,
  listLawArticles,
  listLawBooks,
  listReviewQueue,
  listReviewQueueIds,
  listReviewKinds,
  listBatchOrphans,
  deleteOrphans,
  stageChunks,
  planCommit,
  commitStep,
  rollbackBatch,
  recoverStaleBatches,
  getBatch,
  BatchError,
  BATCH_MESSAGES,
  listImports,
  listRevertableBatches,
  planRevert,
  revertLaw,
  listReviewAudit,
  listCaptureBatches,
  reviewChunk,
  reviewChunks,
  reviewDashboard,
  resolveLawByTitle,
  BULK_LIMIT,
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
    // ما لم يمرّ بختم الحالة — آخر خطوةٍ في سلسلة المُرسِل، وفيها تُطوى حالُ
    // النظام في `retrieval_status`. يُقال ولا يُرفض: ملفّات ما قبل الإصدار
    // الرابع لا ختم فيها، وملفٌّ فاته الختم قد يُدخل مادةً من نظامٍ لاغٍ «نافذة».
    unstamped: parsed.unstamped,
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

  /* ── `stage=1`: يُجمع الجزء جانباً ولا يُكتب (§4-٦، §8) ──
     الملف يُكتب كاملاً عند `/commit` أو لا يُكتب. والجزء فُحص أعلاه بالفحص نفسه،
     فما يُجمع هو ما كان سيُكتب — وتقريره كتقرير الكتابة إلا ما لا يُعرف قبلها:
     الجديد والمستبدَل والمؤرشَف. */
  if (c.req.query('stage') === '1') {
    const stageBatch = c.req.query('batch');
    if (!stageBatch) return c.json({ error: 'معرّف الدفعة مطلوب' }, 400);
    await recoverStaleBatches(c.env);
    try {
      const { staged } = await stageChunks(c.env, stageBatch, parsed.rows, {
        filename: filename || null,
        sha256: c.req.query('sha256') || null,
        actorId: c.get('user').id,
        correction,
        partial,
        lines: parsed.total,
        failed: parsed.errors.length,
      });
      return c.json({ ...report, ok: true, written: false, staged, batch: stageBatch });
    } catch (e) {
      if (e instanceof BatchError) return c.json({ ...report, ok: false, written: false, error: e.message }, 409);
      throw e;
    }
  }

  // استبدال لا إضافة: المفتاح `id`. وما تغيّر يُؤرشَف قبل أن يُكتب فوقه.
  const importId = uuid();
  // معرّف الدفعة يجمع أجزاء الملف الواحد. الملف يُرفع مقسَّماً، ولا يُعرف
  // ما ورد فيه كلِّه إلا بجمع أجزائه — وعليه وحده يقع حذف اليتيم في الخطوة
  // الختامية. وبلا معرّف لا تُقيَّد المعرّفات ولا يقع حذفٌ بحال.
  const batchId = c.req.query('batch') || null;
  const { inserted, updated, archived, superseded } = await upsertLegalChunks(c.env, parsed.rows, {
    importId,
    correction,
    batchId: batchId ?? undefined,
    // صاحبُ الدفعة يُقيَّد على قرارات المراجعة التي أسقطتها — كلُّ تغييرٍ بصاحبه.
    actorId: c.get('user').id,
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
    `INSERT INTO legal_imports (id, actor_id, filename, lines, inserted, updated, failed, report_json, created_at,
                                kind, file_sha256, batch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      importId, c.get('user').id, filename || null, parsed.total, inserted, updated,
      parsed.errors.length, JSON.stringify(full), Date.now(), correction ? 'correction' : 'import',
      c.req.query('sha256') || null, batchId
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

/**
 * ختامُ الدفعة — وهو الموضع الوحيد الذي يقع فيه حذف.
 *
 * **`upsert` تُحدّث وتُضيف ولا تحذف ما اختفى**، فمادةٌ أُسقطت من المصدر تبقى
 * في النتائج إلى الأبد. والحذف لا يقع مع كل جزء: الملف يُرفع مقسَّماً،
 * وقياسُ الزائد على جزءٍ منه محوُ نظامٍ لا تنظيفُ أثر. فيُقاس على الدفعة
 * تامّةً بمعرّفها، ولا يُقاس إلا على الأنظمة التي حملتها.
 *
 * ويُعرض قبل أن يقع: `?apply=1` يحذف، وبدونه يُحصى ويُردّ ليُنظر فيه.
 */
app.post('/finalize', requireAdmin, async (c) => {
  const batchId = c.req.query('batch') ?? '';
  if (!batchId) return c.json({ error: 'معرّف الدفعة مطلوب' }, 400);

  const orphans = await listBatchOrphans(c.env, batchId);
  /* **ولا حذف على دفعةٍ تُخطّيت منها أسطر.** السطر المتخطّى لم يُكتب، فمعرّفُه
     غائبٌ عن الدفعة وحاضرٌ في القاعدة — والحذف على هذا الظنّ يمحو مادةً لم
     يُسقطها المصدر، بل أسقطها فحصُ خانة. والحارس هنا لا في الشاشة وحدها: السكربت
     والأتمتة يصلان هذا المسار مباشرةً. */
  const skipped =
    (
      await c.env.DB.prepare('SELECT COALESCE(SUM(failed), 0) AS n FROM legal_imports WHERE batch_id = ?')
        .bind(batchId)
        .first<{ n: number }>()
    )?.n ?? 0;
  if (!c.req.query('apply')) {
    return c.json({ ok: true, applied: false, orphans, count: orphans.length, skipped });
  }
  if (skipped > 0) {
    return c.json(
      {
        ok: false,
        applied: false,
        orphans,
        count: orphans.length,
        skipped,
        error: 'لم يُعرض حذف ما غاب عن الملف: تُخطّيت منه أسطر، والغائب قد يكون ما تُخطّي',
      },
      409
    );
  }

  const importId = uuid();
  const deleted = await deleteOrphans(c.env, orphans.map((o) => o.id), {
    importId,
    actorId: c.get('user').id,
  });
  // ولا يمرّ الحذف بلا قيد: كلُّ معرّف مذكورٌ في السجلّ، ونصُّه محفوظٌ في
  // سجلّ التحديث قبل ذهابه.
  await audit(c, 'legal.orphans_deleted', batchId, {
    deleted,
    ids: orphans.map((o) => o.id),
    edited: orphans.filter((o) => o.was_edited).map((o) => o.id),
  });
  await c.env.DB.prepare('UPDATE legal_imports SET deleted = deleted + ? WHERE batch_id = ? AND deleted = 0')
    .bind(deleted, batchId)
    .run();

  return c.json({ ok: true, applied: true, deleted, orphans });
});

/**
 * إتمامُ دفعةٍ جُمعت بـ`/import?stage=1` — الملف يُكتب كاملاً أو لا يُكتب.
 *
 * بلا `apply=1` يُردّ ما سيقع: كم يُكتب، وكم نظاماً، وكم في القاعدة من أنظمته لم
 * يرد فيه — ومنه سؤالُ الحذف قبل الكتابة. و`apply=1` يكتب خطوةً (نظاماً نظاماً،
 * وكلُّ نظامٍ مجمَّدٌ وهو يُكتب)، ويُنادى حتى يعود `done`. و`prune=1` يحذف ما غاب
 * مع كل نظام، ويُرفض على ملفٍّ تُخطّيت منه أسطر كما في `/finalize`.
 *
 * وما تعذّر في أثناء الكتابة يُردّ كلُّه في النداء نفسه: القاعدة إمّا على ما كانت
 * أو على ما في الملف كلِّه.
 */
app.post('/commit', requireAdmin, async (c) => {
  const batchId = c.req.query('batch') ?? '';
  if (!batchId) return c.json({ error: 'معرّف الدفعة مطلوب' }, 400);
  await recoverStaleBatches(c.env);

  if (!c.req.query('apply')) {
    const plan = await planCommit(c.env, batchId);
    if (!plan || plan.state === 'rolled_back' || plan.state === 'abandoned') {
      return c.json({ ok: false, error: BATCH_MESSAGES.missing }, 404);
    }
    return c.json({ ok: true, ...plan });
  }

  try {
    const progress = await commitStep(c.env, batchId, {
      prune: c.req.query('prune') === '1',
      actorId: c.get('user').id,
    });
    if (progress.done) {
      const batch = await getBatch(c.env, batchId);
      await audit(c, 'legal.import', progress.import_id ?? batchId, {
        batch: batchId, filename: batch?.filename, lines: batch?.lines, inserted: progress.inserted,
        updated: progress.updated, archived: progress.archived, superseded: progress.superseded,
        deleted: progress.deleted, failed: batch?.failed, kind: batch?.kind, staged: true,
      });
      // التضمين بعد الردّ، كما في الكتابة المباشرة — وما لم يلحق يصرّفه الـCron.
      c.executionCtx.waitUntil(embedPending(c.env, IMPORT_EMBED_BUDGET).then(() => {}));
    }
    return c.json({ ok: true, ...progress });
  } catch (e) {
    // رُفض قبل أن يُكتب شيء: السبب يُقال ولا يُردّ شيء — الدفعة على حالها.
    const batch = await getBatch(c.env, batchId);
    if (e instanceof BatchError && batch?.state !== 'committing') {
      return c.json({ ok: false, error: e.message, code: e.code }, e.code === 'missing' ? 404 : 409);
    }
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`legal commit ${batchId} failed:`, reason);
    // تعذّر في أثناء الكتابة: يُردّ ما كُتب. وإن تعذّر الردُّ نفسه بقيت الدفعة
    // «تُكتب» فيردّها المؤقّت — ولا يُقال «أُعيدت» عن ردٍّ لم يتمّ.
    await rollbackBatch(c.env, batchId, reason);
    await audit(c, 'legal.import_rolled_back', batchId, { reason });
    return c.json({ ok: false, rolled_back: true, error: BATCH_MESSAGES.rolledBack }, 500);
  }
});

/**
 * إلغاءُ دفعة: ما جُمع يُسقط، وما بدأت كتابتُه يُردّ. ولا أثرَ لدفعةٍ اعتُمدت —
 * ردُّها بعد الاعتماد من `/revert` نظاماً نظاماً.
 */
app.post('/abort', requireAdmin, async (c) => {
  const batchId = c.req.query('batch') ?? '';
  if (!batchId) return c.json({ error: 'معرّف الدفعة مطلوب' }, 400);
  const result = await rollbackBatch(c.env, batchId, 'aborted');
  return c.json({ ok: true, ...result });
});

/**
 * الدفعات التي بقيت صورُها — وما تمسّه كلٌّ من أنظمة.
 *
 * وهي ثلاثٌ لا أكثر: الصور تُقلَّم عند كل دفعة جديدة، ومن أراد ما هو أقدم
 * فمصدرُه النسخة الاحتياطية لا هذا المسار.
 */
app.get('/revertable', requireAdmin, async (c) => c.json({ batches: await listRevertableBatches(c.env) }));

/**
 * التراجع عن دفعةٍ **في نطاق نظام** — يُعرض قبل أن يقع.
 *
 * النطاق نظامٌ واحد لا الدفعة كلَّها: «أعِد نظام العمل إلى ما كان قبل دفعة
 * كذا» جملةٌ تُقرأ ويُقدَّر أثرها، و«أعِد الدفعة» تمسّ ما لا يعلمه صاحب القرار.
 *
 * وبلا `?apply=1` يُردّ الخطّة وحدها: كم يُستعاد، وكم يُحذف، وأيُّ قرارات
 * مراجعةٍ ستسقط. **وتلك الأخيرة أخطر ما فيه** — الصورة تحمل حالَ المراجعة كما
 * كانت قبل الدفعة، فردُّها يردّ معها قراراتٍ وقعت بعدها. تُعرض ليقرّر صاحبُ
 * القرار وهو يعلم، لا ليكتشفها مراجعٌ فقد عملَ يومه.
 */
app.post('/revert', requireAdmin, async (c) => {
  const batchId = c.req.query('batch') ?? '';
  const lawId = c.req.query('law_id') ?? '';
  if (!batchId || !lawId) return c.json({ error: 'معرّف الدفعة والنظام مطلوبان' }, 400);

  const plan = await planRevert(c.env, batchId, lawId);
  if (!plan.restore.length && !plan.remove.length) {
    return c.json({ ok: false, applied: false, plan, error: 'لا صورة لهذا النظام في هذه الدفعة' }, 404);
  }
  if (!c.req.query('apply')) return c.json({ ok: true, applied: false, plan });

  const result = await revertLaw(c.env, batchId, lawId, { actorId: c.get('user').id });
  await audit(c, 'legal.revert', `${batchId}:${lawId}`, {
    ...result,
    review_lost: plan.review_lost.map((r) => r.id),
  });
  // ما استُعيد صُفِّر متجهُه، فيُصرَّف في الحال لا في الليلة القادمة.
  c.executionCtx.waitUntil(embedPending(c.env, IMPORT_EMBED_BUDGET).then(() => {}));
  return c.json({ ok: true, applied: true, ...result, plan });
});

/**
 * صحّة القاعدة — عدٌّ حيّ يُقابَل ببيان آخر دفعة.
 *
 * و`vectors=1` يسأل الفهرس المتجهي نفسه عن عدده ويقابله بسجلاته (§6-7). وهو
 * بطلبٍ صريح لا مع كل جسّ: شريط الحال يجسّ كل خمس ثوانٍ، وسؤالُ الفهرس نداءٌ
 * خارج القاعدة لا يستحقّ هذا الإيقاع.
 */
app.get('/stats', requireAdmin, async (c) =>
  c.json(await legalStats(c.env, { vectors: c.req.query('vectors') === '1' }))
);

/**
 * سجلّ الدفعات — وأثرُ كلٍّ: مضاف ومحدَّث ومحذوف.
 *
 * والبصمة معها: بها يُعرف أيُّ ملفٍ أنتج ما في القاعدة، وتُطابَق ببصمة
 * المُرسِل. ومعرّفُ الدفعة يجمع أجزاء الملف الواحد، فيُقرأ سجلُّها سطراً
 * واحداً لا خمسةَ أسطر لملفٍ قُسِّم خمساً.
 */
app.get('/imports', requireAdmin, async (c) => c.json({ imports: await listImports(c.env) }));

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
    amendmentKind: c.req.query('amendment_kind') ?? null,
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
      amendmentKind: c.req.query('amendment_kind') ?? null,
    })
  )
);

/**
 * معرّفات الطابور كلِّه — لتحديدٍ يشمله لا يشمل صفحته.
 *
 * قراءةٌ لا كتابة: تُجلب المعرّفات لتعود صريحةً إلى مسار القرار، فيبقى العدد
 * الذي يراه المراجع قبل التأكيد هو العدد الذي يقع عليه القرار، ويبقى كلُّ
 * اعتماد مقيَّداً وحده في سجلّ التدقيق.
 */
app.get('/review/ids', requireAdmin, async (c) =>
  c.json(
    await listReviewQueueIds(c.env, {
      queue: (c.req.query('queue') as ReviewQueueKey) || null,
      lawId: c.req.query('law_id') ?? null,
      capturedAt: c.req.query('captured_at') ?? null,
      docType: c.req.query('doc_type') ?? null,
      amendmentKind: c.req.query('amendment_kind') ?? null,
    })
  )
);

/** دفعات الاستيراد المتاحة للترشيح. */
app.get('/review/batches', requireAdmin, async (c) => c.json({ batches: await listCaptureBatches(c.env) }));

/**
 * أنواع التعديل في الطابور — لقائمة المرشّح (§6-3)، حيّةً من القاعدة بعدد ما
 * ينتظر من كلٍّ. ومرشّحات الطابور الأخرى تحصرها، فلا يُعرض نوعٌ لا مادة له.
 */
app.get('/review/kinds', requireAdmin, async (c) =>
  c.json({
    kinds: await listReviewKinds(c.env, {
      lawId: c.req.query('law_id') ?? null,
      capturedAt: c.req.query('captured_at') ?? null,
      docType: c.req.query('doc_type') ?? null,
    }),
  })
);

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
/**
 * قرارٌ واحد على موادّ محدَّدة بأعيانها.
 *
 * **بمعرّفاتها لا بشرطٍ يُطابقها**، وبسقفٍ يقابل صفحة الطابور: نداءٌ يقبل «كل
 * الطابور» يعتمد ما لم يُعرض على أحد. وكلُّ مادة تُقيَّد وحدها في سجلّ
 * التدقيق موسومةً `bulk`، فيُعرف لاحقاً أن الاعتماد وقع جملةً لا مادةً مادة.
 *
 * والتحرير خارجه: نصٌّ يُحرَّر يُحرَّر وحده.
 */
app.post('/review-selected', requireAdmin, async (c) => {
  const body = await c.req
    .json<{ ids?: unknown; action?: string; note?: string }>()
    .catch(() => ({}) as { ids?: unknown; action?: string; note?: string });
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
  if (!ids.length) return c.json({ error: 'حدِّد مادةً واحدة على الأقل' }, 400);
  const action = (body.action ?? 'approve') as Exclude<ReviewAction, 'edit'>;
  if (!['approve', 'exclude', 'defer', 'note', 'undo'].includes(action)) {
    return c.json({ error: 'الإجراء غير معروف' }, 400);
  }

  const result = await reviewChunks(c.env, ids, action, c.get('user').id, { note: body.note });
  await audit(c, 'legal.review.bulk', ids[0] ?? '', { action, requested: ids.length, done: result.done });
  if (result.reembedded) c.executionCtx.waitUntil(embedPending(c.env, REVIEW_EMBED_BUDGET).then(() => {}));
  return c.json({ ok: true, ...result, limit: BULK_LIMIT });
});

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
    // الباب كما ورد في الملف — ويُطابَق مطبَّعاً في طبقة الاسترجاع (§6-1).
    book: c.req.query('book') ?? null,
    withRegulations: c.req.query('with_regulations') !== '0',
    includeRepealed: c.req.query('include_repealed') === '1',
    // `lexical=1` يبحث بلا نموذج تضمين — لشاشات البحث المباشر.
    lexicalOnly: c.req.query('lexical') === '1',
  });
  return c.json({ results: hits, count: hits.length });
});

/**
 * استدعاء مادة بعينها: `?id=`، أو `?law_id=&article_no=`، أو
 * `?law_title=&article_no=`.
 *
 * والعنوان بابٌ ثالث لأجل الاستشهادات القديمة: حُفظت بعنوان النظام ورقم
 * المادة وحدهما، فبلا هذا الباب تبقى محادثاتٌ كاملة تذكر مصادرها ولا تفتحها.
 * والمطابقة تامّة — انظر `resolveLawIdByTitle`.
 */
app.get('/article', async (c) => {
  const includeRepealed = c.req.query('include_repealed') === '1';
  const id = c.req.query('id');
  if (id) {
    const hit = await getChunkById(c.env, id, includeRepealed);
    if (hit) {
      // ومرفقاتُها معها بعدها (§5-6): الاستشهاد يفتح المادة، والجدول الذي تحيل
      // إليه في مرفقها — والتصفية نفسها تسري على المرفق.
      const results = await withAttachments(c.env, [hit], {
        lawId: hit.lawId,
        withRegulations: false,
        includeRepealed,
      });
      return c.json({ results, count: results.length });
    }
    // موجودةٌ لكنها محجوبة: يُقال لماذا غابت بدل «غير موجودة» المضلّلة —
    // والسببان مختلفان، فمنسوخةٌ خرجت من النظام ومحجوبةٌ لم تُراجَع بعد.
    const reason = await hiddenReason(c.env, id);
    if (reason === 'missing') return c.json({ error: 'المادة غير موجودة' }, 404);
    if (reason === 'repealed') {
      return c.json({ error: 'المادة منسوخة — أضِف include_repealed=1 للاطّلاع عليها', repealed: true }, 404);
    }
    return c.json(
      { error: 'المادة بانتظار المراجعة — تظهر في شاشة مراجعة المواد حتى تُعتمد', needs_review: true },
      404
    );
  }

  const articleNo = c.req.query('article_no');
  const lawTitle = c.req.query('law_title')?.trim();
  const byTitle = !c.req.query('law_id') && lawTitle ? await resolveLawByTitle(c.env, lawTitle) : null;
  // الاسم يطابق نظامين: لا يُفتح أقربُهما، ويُقال لماذا (`naf-terms.md` — نافذة المصدر).
  if (byTitle?.ambiguous) {
    return c.json(
      { error: 'في المنصة أكثر من نظام بهذا الاسم — افتح المادة من صفحة نظامها', ambiguous: true },
      409
    );
  }
  const lawId = c.req.query('law_id') || byTitle?.lawId || null;
  if (!lawId || !articleNo) {
    // عنوانٌ أُرسل ولم يُطابق نظاماً: السبب غيابُ النظام لا نقصُ المعاملات.
    if (lawTitle && articleNo) return c.json({ error: 'المادة غير موجودة' }, 404);
    return c.json({ error: 'المطلوب: id أو (law_id و article_no) أو (law_title و article_no)' }, 400);
  }
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

/** أبوابُ نظامٍ بترتيب ورودها — لمرشّح الباب في البحث (§6-1). */
app.get('/laws/:lawId/books', async (c) => c.json({ books: await listLawBooks(c.env, c.req.param('lawId')) }));

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
