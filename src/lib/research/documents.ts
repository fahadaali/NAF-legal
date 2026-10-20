// البحث في الوثائق المرفوعة — هجينٌ كالبحث في الأنظمة: لفظيّ (على النصّ المطبَّع وعلى
// الجذوع) ودلاليّ (في مساحة `documents` من Vectorize)، مدموجان بالرتب.
//
// والتصفية على سريان الوثيقة هنا لا في الواجهة: وثيقةٌ نُسخت لا يعود منها مقطع.
import { ftsMatchExpression, stemMatchExpression } from '../arabic';
import { EFFECTIVE_STATUSES } from '../legal';
import type { RagResult } from '../rag';
import type { Env } from '../../types';

/** مساحة متجهات الوثائق في الفهرس المشترك. */
export const DOC_NAMESPACE = 'documents';
/** نسخة الفهرسة الحالية — ما دونها يُعاد في الخلفية (`reindexDocuments`). */
export const DOC_INDEX_VERSION = 2;

const RRF_K = 60;
const CANDIDATES = 20;

interface ChunkRow {
  id: string;
  document_id: string;
  text: string;
  article_ref: string | null;
  title: string;
}

const EFFECTIVE_DOC = `(d.status IS NULL OR d.status IN (${EFFECTIVE_STATUSES.map((s) => `'${s}'`).join(',')}))`;

function toResult(r: ChunkRow, score: number): RagResult {
  return {
    text: r.text,
    score,
    documentId: r.document_id,
    title: r.title,
    articleRef: r.article_ref || undefined,
    key: r.id,
    source: 'document',
  };
}

/** مقاطعُ بمعرّفاتها، بترتيبها، من وثائق سارية — لاستعادة مذكرةٍ أو نتيجةٍ دلالية. */
export async function getDocumentChunks(env: Env, ids: string[]): Promise<RagResult[]> {
  const unique = [...new Set(ids)].slice(0, 90);
  if (!unique.length) return [];
  const rows = await env.DB.prepare(
    `SELECT k.id, k.document_id, k.text, k.article_ref, d.title
     FROM kb_doc_chunks k JOIN kb_documents d ON d.id = k.document_id
     WHERE k.id IN (${unique.map(() => '?').join(',')}) AND ${EFFECTIVE_DOC}`
  )
    .bind(...unique)
    .all<ChunkRow>();
  const byId = new Map((rows.results ?? []).map((r) => [r.id, r]));
  return unique.map((id) => byId.get(id)).filter((r): r is ChunkRow => !!r).map((r) => toResult(r, 0));
}

export async function searchDocuments(
  env: Env,
  query: string,
  opts: { limit?: number; queryVector?: number[]; onSignal?: (s: { stage: string; count?: number; error?: string }) => void } = {}
): Promise<RagResult[]> {
  const limit = opts.limit ?? 5;
  const lists: RagResult[][] = [];

  // ── لفظيّ: النصّ المطبَّع والجذوع معاً ──
  const plain = ftsMatchExpression(query);
  const stems = stemMatchExpression(query);
  const match = [plain && `(text_norm : (${plain}))`, stems && `(text_stem : (${stems}))`].filter(Boolean).join(' OR ');
  if (match) {
    try {
      const rows = await env.DB.prepare(
        `SELECT k.id, k.document_id, k.text, k.article_ref, d.title
         FROM kb_doc_fts JOIN kb_doc_chunks k ON k.seq = kb_doc_fts.rowid
         JOIN kb_documents d ON d.id = k.document_id
         WHERE kb_doc_fts MATCH ? AND ${EFFECTIVE_DOC}
         ORDER BY bm25(kb_doc_fts) ASC LIMIT ?`
      )
        .bind(match, CANDIDATES)
        .all<ChunkRow>();
      lists.push((rows.results ?? []).map((r) => toResult(r, 0)));
      opts.onSignal?.({ stage: 'documents-lexical', count: rows.results?.length ?? 0 });
    } catch (e: any) {
      opts.onSignal?.({ stage: 'documents-lexical', error: String(e?.message ?? e) });
    }
  }

  // ── دلاليّ: مساحة الوثائق وحدها، فلا تزاحمها موادّ الأنظمة ──
  if (env.VECTORIZE && opts.queryVector) {
    try {
      const res = await env.VECTORIZE.query(opts.queryVector, {
        topK: CANDIDATES,
        namespace: DOC_NAMESPACE,
        returnMetadata: 'none',
      });
      const ids = (res.matches ?? []).map((m) => m.id);
      lists.push(await getDocumentChunks(env, ids));
      opts.onSignal?.({ stage: 'documents-semantic', count: ids.length });
    } catch (e: any) {
      opts.onSignal?.({ stage: 'documents-semantic', error: String(e?.message ?? e) });
    }
    // ووثائقُ لم تُعَد فهرستُها بعد: من مسارها القديم حتى تُعاد.
    lists.push(await legacyDocuments(env, opts.queryVector, CANDIDATES));
  }

  const merged = new Map<string, RagResult>();
  for (const list of lists) {
    list.forEach((r, rank) => {
      const k = r.key!;
      const cur = merged.get(k);
      if (cur) cur.score += 1 / (RRF_K + rank);
      else merged.set(k, { ...r, score: 1 / (RRF_K + rank) });
    });
  }
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * المسار القديم — متجهاتٌ في المساحة الافتراضية ونصُّها في بياناتها الوصفية — لوثائق
 * لم تُعَد فهرستُها. لا يجري إن لم تبقَ منها واحدة.
 */
async function legacyDocuments(env: Env, queryVector: number[], topK: number): Promise<RagResult[]> {
  const left = await env.DB.prepare(
    `SELECT 1 AS x FROM kb_documents WHERE index_version < ${DOC_INDEX_VERSION} AND ingest_status = 'ready' LIMIT 1`
  )
    .first<{ x: number }>()
    .catch(() => null);
  if (!left) return [];
  try {
    const res = await env.VECTORIZE!.query(queryVector, { topK: Math.min(topK, 20), returnMetadata: 'all' });
    const found = (res.matches ?? [])
      .filter((m) => !m.id.startsWith('legal:') && !m.id.startsWith('doc:'))
      .map((m) => {
        const meta = (m.metadata ?? {}) as any;
        return {
          docId: String(meta.document_id ?? ''),
          r: {
            text: meta.text ?? '',
            score: m.score,
            documentId: String(meta.document_id ?? ''),
            title: meta.title ?? '',
            articleRef: meta.article_ref || undefined,
            key: m.id,
            source: 'document' as const,
          },
        };
      });
    if (!found.length) return [];
    const ids = [...new Set(found.map((f) => f.docId).filter(Boolean))];
    const rows = await env.DB.prepare(
      `SELECT id FROM kb_documents d WHERE id IN (${ids.map(() => '?').join(',')})
       AND index_version < ${DOC_INDEX_VERSION} AND ${EFFECTIVE_DOC}`
    )
      .bind(...ids)
      .all<{ id: string }>();
    const ok = new Set((rows.results ?? []).map((r) => r.id));
    return found.filter((f) => ok.has(f.docId)).map((f) => f.r);
  } catch {
    return [];
  }
}

/**
 * إعادة فهرسة الوثائق التي فُهرست بالطريقة القديمة — بضعٌ في كل نبضة Cron.
 * التضمين نداءُ نموذج لكل عشرة مقاطع، فالدفعة صغيرة.
 */
export async function reindexDocuments(
  env: Env,
  ingest: (env: Env, id: string) => Promise<string>,
  limit = 3
): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id FROM kb_documents WHERE index_version < ${DOC_INDEX_VERSION} AND ingest_status = 'ready'
     ORDER BY created_at LIMIT ?`
  )
    .bind(limit)
    .all<{ id: string }>();
  for (const r of rows.results ?? []) await ingest(env, r.id);
  return rows.results?.length ?? 0;
}
