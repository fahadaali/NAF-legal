// تقسيم النص وتوليد التضمينات وتخزينها في Vectorize — §6
// يُستدعى مباشرةً عبر ctx.waitUntil (بلا Queues لدعم الخطة المجانية).
import { chunkText, embedBatch } from './lib/rag';
import type { Env } from './types';

export async function ingestDocument(env: Env, docId: string): Promise<void> {
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
    await env.VECTORIZE.deleteByIds(oldIds).catch(() => {});
  }

  // ضمّن على دفعات
  const BATCH = 20;
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
    await env.VECTORIZE.upsert(toUpsert);
  }

  await env.DB.prepare("UPDATE kb_documents SET ingest_status = 'ready', chunk_count = ? WHERE id = ?")
    .bind(chunks.length, docId)
    .run();
}

function extractArticleRef(chunk: string): string {
  const m = chunk.match(/(?:المادة|مادة)\s+([\(\)\d٠-٩]+)/);
  return m ? `المادة ${m[1]}` : '';
}
