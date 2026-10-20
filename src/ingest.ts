// تقسيم النص وتوليد التضمينات وتخزينها في Vectorize — §6
// يُستدعى مباشرةً عبر ctx.waitUntil (بلا Queues لدعم الخطة المجانية).
import { chunkText, embedBatch } from './lib/rag';
import { normalizeArabic, stemText } from './lib/arabic';
import { DOC_NAMESPACE, DOC_INDEX_VERSION } from './lib/research/documents';
import type { Env } from './types';

/**
 * يضمّن وثيقةً مرفوعة، ولا يتركها معلَّقة مهما وقع.
 *
 * **الحارس هنا لأن المستدعي لا يملك حارساً.** `ingestDocument` يُستدعى من
 * `ctx.waitUntil`، ورميةٌ منه تُبتلع في العامل بلا أثر — بعد أن تكون الوثيقة
 * قد وُسمت `processing`. فتبقى «جارٍ التضمين» إلى الأبد: لا الـCron يلتقطها
 * (يسأل عن `pending`)، ولا المسؤول يعرف أنها تحتاج شيئاً.
 *
 * فما يخرج من هنا حالٌ مستقرّة دائماً: `ready` أو `pending` أو `error`.
 *
 * ويُردّ ما استقرّت عليه، لا `void`: المستدعي يعدّ ما ضُمِّن، وعدُّ وثيقةٍ
 * انتهت إلى `error` مضمَّنةً يجعل الشاشة تقول «ضُمِّنت عشر» وعمودُها يقول
 * «تعذّر التضمين» في ثلاثٍ منها. والعدد الذي يناقض الجدول تحته أسوأ من
 * لا عدد.
 */
export type IngestOutcome = 'ready' | 'pending' | 'error';

export async function ingestDocument(env: Env, docId: string): Promise<IngestOutcome> {
  try {
    return await runIngest(env, docId);
  } catch {
    // السبب لا يُخزَّن: `kb_documents` بلا عمودٍ له، وإضافتُه قرارُ مخطَّطٍ
    // قائم بذاته. والحال وحدها تكفي لتُعاد الوثيقة بـ«إعادة تضمين».
    await env.DB.prepare("UPDATE kb_documents SET ingest_status = 'error' WHERE id = ?")
      .bind(docId)
      .run()
      .catch(() => {});
    return 'error';
  }
}

async function runIngest(env: Env, docId: string): Promise<IngestOutcome> {
  const doc = await env.DB.prepare('SELECT title, category, chunk_count FROM kb_documents WHERE id = ?')
    .bind(docId)
    .first<{ title: string; category: string | null; chunk_count: number | null }>();
  if (!doc) throw new Error('الوثيقة غير موجودة');

  const textObj = await env.R2.get(`kb-text/${docId}.txt`);
  const text = textObj ? await textObj.text() : '';
  if (!text.trim()) {
    await env.DB.prepare("UPDATE kb_documents SET ingest_status = 'error' WHERE id = ?").bind(docId).run();
    return 'error';
  }
  if (env.VECTORIZE) {
    await env.DB.prepare("UPDATE kb_documents SET ingest_status = 'processing' WHERE id = ?").bind(docId).run();
  }

  const chunks = chunkText(text);

  /* ── المقاطع في D1 أوّلاً ──
     بنصّها كاملاً، مطبَّعاً ومجذوعاً، فيعمل البحث اللفظيّ فيها ولو بلا فهرسٍ متجهي.
     وما سبقها من مقاطع الوثيقة يُحذف ومعه متجهاتُه: بمعرّفاته الجديدة وبالقديمة
     (`<docId>:<i>` في المساحة الافتراضية قبل الهجرة 0040). */
  const prev = await env.DB.prepare('SELECT id FROM kb_doc_chunks WHERE document_id = ?')
    .bind(docId)
    .all<{ id: string }>();
  const staleIds = [
    ...(prev.results ?? []).map((r) => r.id),
    ...Array.from({ length: doc.chunk_count ?? 0 }, (_, i) => `${docId}:${i}`),
  ];
  if (env.VECTORIZE && staleIds.length) await env.VECTORIZE.deleteByIds(staleIds).catch(() => {});

  const now = Date.now();
  const rows = chunks.map((chunk, i) => ({
    id: `doc:${docId}:${i}`,
    text: chunk,
    norm: normalizeArabic(chunk),
    ref: extractArticleRef(chunk),
  }));
  const stmts = [
    env.DB.prepare('DELETE FROM kb_doc_chunks WHERE document_id = ?').bind(docId),
    ...rows.map((r, i) =>
      env.DB.prepare(
        `INSERT INTO kb_doc_chunks (id, document_id, ord, text, text_norm, text_stem, article_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(r.id, docId, i, r.text, r.norm, stemText(r.norm), r.ref || null, now)
    ),
  ];
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));

  /* بلا فهرس متجهي لا يقع تضمين — والوثيقة تبقى **منتظرة** لا «جاهزة»، وإن كان
     بحثُها اللفظيّ يعمل الآن من مقاطعها في D1. */
  if (!env.VECTORIZE) {
    await env.DB.prepare("UPDATE kb_documents SET ingest_status = 'pending', chunk_count = ? WHERE id = ?")
      .bind(chunks.length, docId)
      .run();
    return 'pending';
  }

  /* ضمّن على دفعات — في مساحة `documents` وحدها، فلا تزاحمها موادّ الأنظمة.
     والوثيقة كلٌّ لا يتجزّأ: إن تعثّرت دفعةٌ رُميت كلُّها إلى `error` — تُرى في
     الجدول وتُعاد بـ«إعادة تضمين» — ولا تُوسم «جاهزة» ونصفُ مقاطعها بلا متجه. */
  const BATCH = 10;
  for (let start = 0; start < rows.length; start += BATCH) {
    const slice = rows.slice(start, start + BATCH);
    const vectors = await embedBatch(env, slice.map((r) => r.text));
    await env.VECTORIZE.upsert(
      slice.map((r, i) => ({
        id: r.id,
        values: vectors[i],
        namespace: DOC_NAMESPACE,
        metadata: { kind: 'document', document_id: docId, category: doc.category ?? '' },
      }))
    );
  }

  await env.DB.prepare(
    "UPDATE kb_documents SET ingest_status = 'ready', chunk_count = ?, index_version = ? WHERE id = ?"
  )
    .bind(chunks.length, DOC_INDEX_VERSION, docId)
    .run();
  return 'ready';
}

function extractArticleRef(chunk: string): string {
  const m = chunk.match(/(?:المادة|مادة)\s+([\(\)\d٠-٩]+)/);
  return m ? `المادة ${m[1]}` : '';
}
