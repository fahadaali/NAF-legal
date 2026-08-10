// تقسيم النص وتوليد التضمينات وتخزينها في Vectorize — §6
// يُستدعى مباشرةً عبر ctx.waitUntil (بلا Queues لدعم الخطة المجانية).
import { chunkText, embedBatch } from './lib/rag';
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
 */
export async function ingestDocument(env: Env, docId: string): Promise<void> {
  try {
    await runIngest(env, docId);
  } catch {
    // السبب لا يُخزَّن: `kb_documents` بلا عمودٍ له، وإضافتُه قرارُ مخطَّطٍ
    // قائم بذاته. والحال وحدها تكفي لتُعاد الوثيقة بـ«إعادة تضمين».
    await env.DB.prepare("UPDATE kb_documents SET ingest_status = 'error' WHERE id = ?")
      .bind(docId)
      .run()
      .catch(() => {});
  }
}

async function runIngest(env: Env, docId: string): Promise<void> {
  /* بلا فهرس متجهي لا يقع تضمين — والوثيقة تبقى **منتظرة** لا «جاهزة».

     وكانت تُوسم «جاهزة» بـ«المقاطع ٠»، فيقرأ المسؤول نجاحاً حيث لم يقع شيء:
     `retrieveKbDocuments` في `lib/rag.ts` يردّ فارغاً بلا الفهرس، فالوثيقة
     لا تبلغ المساعدَ أصلاً. ثم يسأل لماذا لا يجد وثيقةً «جاهزة» رفعها بيده.

     و`pending` هي الحال الصادقة: لم تُضمَّن بعد. والشاشة تقول للمسؤول **لماذا**
     — «بانتظار الفهرس» — لأنها وحدها تعرف أن الفهرس غير مهيّأ. ولا حالَ رابعة
     في القاعدة: `ingest_status` محصورٌ بأربعٍ في `CHECK` منذ `0001_init.sql`،
     وتوسيعُه يعيد بناء الجدول مقابل ما يُشتقّ بلا لبس.

     و`chunk_count` يُصفَّر معها: وثيقةٌ ضُمِّنت ثم أُعيد تضمينها بلا فهرس
     تبقى تعرض عدد مقاطعها القديم وقد حُذفت متجهاتُه. */
  if (!env.VECTORIZE) {
    await env.DB.prepare("UPDATE kb_documents SET ingest_status = 'pending', chunk_count = 0 WHERE id = ?")
      .bind(docId)
      .run();
    return;
  }
  await env.DB.prepare("UPDATE kb_documents SET ingest_status = 'processing' WHERE id = ?").bind(docId).run();

  const doc = await env.DB.prepare('SELECT title, category FROM kb_documents WHERE id = ?')
    .bind(docId)
    .first<{ title: string; category: string | null }>();
  if (!doc) throw new Error('الوثيقة غير موجودة');

  const textObj = await env.R2.get(`kb-text/${docId}.txt`);
  const text = textObj ? await textObj.text() : '';
  if (!text.trim()) {
    await env.DB.prepare("UPDATE kb_documents SET ingest_status = 'error' WHERE id = ?").bind(docId).run();
    return;
  }

  const chunks = chunkText(text);
  // امسح المتجهات القديمة (في حال إعادة التضمين)
  const oldDoc = await env.DB.prepare('SELECT chunk_count FROM kb_documents WHERE id = ?')
    .bind(docId)
    .first<{ chunk_count: number }>();
  if (oldDoc?.chunk_count) {
    const oldIds = Array.from({ length: oldDoc.chunk_count }, (_, i) => `${docId}:${i}`);
    await env.VECTORIZE!.deleteByIds(oldIds).catch(() => {});
  }

  /* ضمّن على دفعات — والوثيقة كلٌّ لا يتجزّأ.

     المقطع في `legal_chunks` صفٌّ قائم بذاته، فتعثّرُ دفعةٍ هناك يترك ما
     نجح مضمَّناً ويعيد ما فشل. أما الوثيقة فحالُها عمودٌ واحد
     (`ingest_status`) وعدُّ مقاطعها عمودٌ واحد: فوسمُها «مضمَّنة» ونصفُ
     مقاطعها بلا متجه يجعلها تُسترجَع ناقصةً ولا شيء يقول ذلك. فإن تعثّرت
     دفعةٌ رُميت الوثيقةُ كلُّها إلى `error` — تُرى في الجدول، وتُعاد
     بـ«إعادة تضمين». */
  const BATCH = 10;
  for (let start = 0; start < chunks.length; start += BATCH) {
    const slice = chunks.slice(start, start + BATCH);
    const vectors = await embedBatch(env, slice);
    const toUpsert = slice.map((chunk, i) => ({
      id: `${docId}:${start + i}`,
      values: vectors[i],
      metadata: {
        document_id: docId,
        title: doc.title,
        category: doc.category ?? '',
        text: chunk.slice(0, 4000),
        article_ref: extractArticleRef(chunk),
      },
    }));
    await env.VECTORIZE!.upsert(toUpsert);
  }

  await env.DB.prepare("UPDATE kb_documents SET ingest_status = 'ready', chunk_count = ? WHERE id = ?")
    .bind(chunks.length, docId)
    .run();
}

function extractArticleRef(chunk: string): string {
  const m = chunk.match(/(?:المادة|مادة)\s+([\(\)\d٠-٩]+)/);
  return m ? `المادة ${m[1]}` : '';
}
