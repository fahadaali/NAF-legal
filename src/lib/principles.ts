/**
 * طبقة المبادئ القضائية — الاستيراد والبحث والاستدعاء.
 *
 * **المبدأ سابقةٌ لا نصٌّ ملزم.** يُحفظ في جدولٍ وحده (`legal_principles`) ولا
 * يمرّ بشيءٍ من مسارات الموادّ: لا `searchLegal` ولا `getArticle` ولا الفهرس
 * المتجهي. فلا يظهر مبدأٌ بين الموادّ ولو أغفل موضعٌ شرطاً، لأنه ليس هناك أصلاً.
 * ويُعرض في قسمٍ بعد الموادّ في السياق وفي أداة MCP (IMPORT-RUNBOOK §5-٩).
 *
 * **والحال بأربع قيم، وكلُّها تُسترجَع.** «أساسه معدَّل» و«أساسه ملغى» لا تحجبان
 * المبدأ — يحتاجه الباحث ليعرف كيف قُضي — وإنما تُوجبان تحذيره فوق نصّه. ولا
 * يُقدَّم ما أساسُه ملغى حكماً جارياً اليوم.
 *
 * **والبحث لفظيٌّ في هذا الإصدار.** على النصّ المطبَّع وجذوعه الخفيفة معاً،
 * كمساري الموادّ اللفظيين. والدلاليُّ يحتاج فهرساً متجهياً خاصاً بالمبادئ —
 * متجهاتُها في فهرس الموادّ تزاحم موادّه على مقاعد `topK` — فيأتي بقراره.
 */
import type { Env } from '../types';
import { normalizeArabic, stemText, ftsMatchExpression, stemMatchExpression } from './arabic';

/** حالات المبدأ كما يكتبها المصدر (IMPORT-RUNBOOK §3-١٤). */
export const PRINCIPLE_EFFECTIVE = 'نافذ';
export const PRINCIPLE_WARNING = 'نافذ_بتحذير';
export const PRINCIPLE_BASIS_AMENDED = 'أساسه معدَّل';
export const PRINCIPLE_BASIS_REPEALED = 'أساسه ملغى';
export const PRINCIPLE_STATUSES = [PRINCIPLE_EFFECTIVE, PRINCIPLE_WARNING, PRINCIPLE_BASIS_AMENDED, PRINCIPLE_BASIS_REPEALED];

/** علامةُ السجلّ أنه مبدأ لا مادة. */
export const PRINCIPLE_DOC_TYPE = 'مدونة مبادئ';

/** سقف ما يُعاد من البحث الواحد. */
export const PRINCIPLE_SEARCH_MAX = 50;

/** أسطرُ الجزء الواحد عند الجمع — بقدر ما تحمله عبارةٌ مجمَّعة في D1. */
const STAGE_CHUNK = 50;

/** مدّةُ بقاء ما جُمع ولم يُكتب. */
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;

export interface PrincipleRow {
  id: string;
  collection_id: string;
  collection_title: string;
  edition: string | null;
  authority: string | null;
  parent_law_id: string | null;
  principle_no: number;
  principle_label: string;
  book: string | null;
  chapter: string | null;
  section: string | null;
  text: string;
  decision_no: string | null;
  decision_date_h: string | null;
  ref_json: string | null;
  similar_json: string | null;
  related_json: string | null;
  retrieval_status: string;
  retrieval_warning: string | null;
  source_url: string | null;
  source_pages: string | null;
  source_sha256: string | null;
  review: string | null;
  text_norm: string;
  handle_norm: string;
}

export interface PrincipleHit {
  seq: number;
  id: string;
  collectionId: string;
  collectionTitle: string;
  edition: string | null;
  parentLawId: string | null;
  principleNo: number;
  principleLabel: string;
  book: string | null;
  chapter: string | null;
  section: string | null;
  text: string;
  decisionNo: string | null;
  decisionDateH: string | null;
  ref: { volume?: number; page?: number; raw?: string } | null;
  similar: { decision_no: string | null; decision_date_h?: string; raw?: string; print_erratum?: string }[];
  related: { article_no: number; law?: string | null; law_id?: string | null; article_id?: string; state?: string }[];
  retrievalStatus: string;
  retrievalWarning: string | null;
  sourceUrl: string | null;
  sourcePages: string | null;
  score: number;
}

export interface PrincipleLineError {
  line: number;
  error: string;
}

// ── قراءة الملف ──

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

function orNull(v: unknown): string | null {
  const s = str(v);
  return s ? s : null;
}

function jsonOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v) && !v.length) return null;
  return JSON.stringify(v);
}

/**
 * سطرٌ واحد من `principles.jsonl` إلى صفّ — أو سببُ رفضه.
 *
 * الملف يحمل حقول `all-articles.jsonl` نفسها (IMPORT-RUNBOOK §3-١٤)، ويُقرأ منها
 * ما تحتاجه الطبقة. وما يُرفض: سطرٌ ليس مبدأً (`doc_type`)، أو بلا معرّفٍ أو نصّ
 * أو رقم، أو بحالٍ ليست من الأربع، أو من إصدارٍ لم يُعتمد.
 */
export function preparePrinciple(raw: unknown): PrincipleRow | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'السطر ليس كائن JSON';
  const o = raw as Record<string, unknown>;
  const id = str(o.id);
  if (!id) return '`id` مفقود';
  if (str(o.doc_type) !== PRINCIPLE_DOC_TYPE) return `\`doc_type\` ليس «${PRINCIPLE_DOC_TYPE}» — هذا المسار للمبادئ وحدها، والموادّ في /api/legal/import`;
  const text = str(o.text);
  if (!text) return '`text` فارغ';
  const collectionId = str(o.law_id);
  if (!collectionId) return '`law_id` (معرّف المدوّنة) مفقود';
  const no = Number(o.article_no);
  if (!Number.isInteger(no) || no < 1) return '`article_no` ليس رقماً صحيحاً موجباً';
  const status = str(o.retrieval_status);
  if (!PRINCIPLE_STATUSES.includes(status)) {
    return `\`retrieval_status\` غير معروف: ${status || '(فارغ)'} — المسموح: ${PRINCIPLE_STATUSES.join(' | ')}`;
  }
  const warning = orNull(o.retrieval_warning);
  if (status !== PRINCIPLE_EFFECTIVE && !warning) return `حالُه «${status}» بلا \`retrieval_warning\` — والتحذير يُعرض فوق النصّ`;
  // لا يُرفع إصدارٌ لم يعتمده المحامي (IMPORT-RUNBOOK §3-١٤).
  if (str(o.review) !== 'معتمد') return '`review` ليس «معتمد» — لا يُرفع مبدأٌ لم يُعتمد';

  const pages = Array.isArray(o.source_pages) ? (o.source_pages as unknown[]).map(Number).filter(Number.isFinite) : [];
  const sourcePages = pages.length ? (pages[0] === pages[pages.length - 1] ? String(pages[0]) : `${pages[0]}-${pages[pages.length - 1]}`) : null;
  const title = str(o.law_name) || collectionId;
  const label = str(o.article_label) || `المبدأ ${no}`;
  const decisionNo = orNull(o.decision_no);
  const norm = normalizeArabic(text);
  return {
    id,
    collection_id: collectionId,
    collection_title: title,
    edition: orNull(o.source_version),
    authority: orNull(o.authority),
    parent_law_id: orNull(o.parent_law_id),
    principle_no: no,
    principle_label: label,
    book: orNull(o.book),
    chapter: orNull(o.chapter),
    section: orNull(o.section),
    text,
    decision_no: decisionNo,
    decision_date_h: orNull(o.decision_date_h),
    ref_json: jsonOrNull(o.ref),
    similar_json: jsonOrNull(o.similar_decisions),
    related_json: jsonOrNull(o.related),
    retrieval_status: status,
    retrieval_warning: warning,
    source_url: orNull(o.source_url),
    source_pages: sourcePages,
    source_sha256: orNull(o.source_sha256),
    review: 'معتمد',
    // النصّ مطبَّعاً وجذوعُه معاً في عمودٍ واحد: «للعامل» تطابق «العامل».
    text_norm: `${norm} ${stemText(norm)}`,
    handle_norm: normalizeArabic([title, label, decisionNo && `القرار ${decisionNo}`].filter(Boolean).join(' ')),
  };
}

export interface ParsedPrinciples {
  rows: PrincipleRow[];
  errors: PrincipleLineError[];
  total: number;
  /** مدوّناتُ الملف — والاستبدال يقع عليها وحدها. */
  collections: string[];
}

/** يقرأ JSONL كاملاً. والسطر الفارغ يُتجاوز، وعلامة BOM تُسقط. */
export function parsePrinciples(input: string, firstLine = 1): ParsedPrinciples {
  const rows: PrincipleRow[] = [];
  const errors: PrincipleLineError[] = [];
  const seen = new Set<string>();
  let total = 0;
  const lines = input.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    total++;
    const lineNo = firstLine + i;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      errors.push({ line: lineNo, error: 'ليس JSON صالحاً' });
      return;
    }
    const r = preparePrinciple(obj);
    if (typeof r === 'string') {
      errors.push({ line: lineNo, error: r });
      return;
    }
    if (seen.has(r.id)) {
      errors.push({ line: lineNo, error: `\`id\` مكرّر في الملف: ${r.id}` });
      return;
    }
    seen.add(r.id);
    rows.push(r);
  });
  return { rows, errors, total, collections: [...new Set(rows.map((r) => r.collection_id))] };
}

// ── الكتابة: جمعٌ ثم استبدالٌ في عبارةٍ واحدة ──

/** يجمع جزءاً من الملف جانباً. لا يمسّ `legal_principles`. */
export async function stagePrinciples(env: Env, importId: string, rows: PrincipleRow[], firstLine: number): Promise<number> {
  const now = Date.now();
  // ما جُمع ولم يُكتب منذ يوم — انقطاعٌ لم يُكمَل.
  await env.DB.prepare('DELETE FROM legal_principles_staging WHERE created_at < ?').bind(now - STAGING_TTL_MS).run();
  for (let i = 0; i < rows.length; i += STAGE_CHUNK) {
    const slice = rows.slice(i, i + STAGE_CHUNK);
    await env.DB.batch(
      slice.map((r, j) =>
        env.DB.prepare(
          `INSERT INTO legal_principles_staging (import_id, line_no, row_json, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(import_id, line_no) DO UPDATE SET row_json = excluded.row_json`
        ).bind(importId, firstLine + i + j, JSON.stringify(r), now)
      )
    );
  }
  return rows.length;
}

export interface PrincipleCommit {
  written: number;
  replaced: number;
  collections: string[];
}

const COLS = [
  'id', 'collection_id', 'collection_title', 'edition', 'authority', 'parent_law_id', 'principle_no', 'principle_label',
  'book', 'chapter', 'section', 'text', 'decision_no', 'decision_date_h', 'ref_json', 'similar_json', 'related_json',
  'retrieval_status', 'retrieval_warning', 'source_url', 'source_pages', 'source_sha256', 'review', 'text_norm', 'handle_norm',
] as const;

/**
 * يكتب ما جُمع: يحذف ما للمدوّنات نفسها في القاعدة ويُدرج الجديد — في دفعةٍ
 * واحدة، وD1 ينفّذ الدفعة معاملةً واحدة. فإمّا المدوّنة الجديدة كاملةً وإمّا
 * القديمة كما كانت. والمدوّنات التي ليست في الملف لا تُمسّ.
 */
export async function commitPrinciples(env: Env, importId: string): Promise<PrincipleCommit> {
  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS n, json_group_array(DISTINCT json_extract(row_json, '$.collection_id')) AS cols
     FROM legal_principles_staging WHERE import_id = ?`
  )
    .bind(importId)
    .first<{ n: number; cols: string }>();
  const n = counts?.n ?? 0;
  if (!n) throw new Error('لا شيء مجموعاً لهذا الاستيراد — اجمع الملف أولاً');
  const collections = (JSON.parse(counts?.cols ?? '[]') as (string | null)[]).filter((x): x is string => !!x);
  const before = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM legal_principles WHERE collection_id IN (${collections.map(() => '?').join(',')})`
  )
    .bind(...collections)
    .first<{ n: number }>();

  const select = COLS.map((c) => `json_extract(row_json, '$.${c}')`).join(', ');
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM legal_principles WHERE collection_id IN (${collections.map(() => '?').join(',')})`).bind(
      ...collections
    ),
    env.DB.prepare(
      `INSERT INTO legal_principles (${COLS.join(', ')}, import_id, imported_at)
       SELECT ${select}, ?, ? FROM legal_principles_staging WHERE import_id = ? ORDER BY line_no`
    ).bind(importId, now, importId),
    env.DB.prepare('DELETE FROM legal_principles_staging WHERE import_id = ?').bind(importId),
  ]);
  return { written: n, replaced: before?.n ?? 0, collections };
}

/** يُسقط ما جُمع لاستيرادٍ أُلغي. */
export async function abortPrinciples(env: Env, importId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM legal_principles_staging WHERE import_id = ?').bind(importId).run();
}

// ── القراءة ──

const HIT_COLUMNS = `p.seq, p.id, p.collection_id, p.collection_title, p.edition, p.parent_law_id, p.principle_no,
  p.principle_label, p.book, p.chapter, p.section, p.text, p.decision_no, p.decision_date_h, p.ref_json,
  p.similar_json, p.related_json, p.retrieval_status, p.retrieval_warning, p.source_url, p.source_pages`;

type HitRow = Omit<PrincipleRow, 'authority' | 'source_sha256' | 'review' | 'text_norm' | 'handle_norm'> & {
  seq: number;
  lex?: number;
};

function parseJson<T>(v: string | null, fallback: T): T {
  if (!v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function toHit(r: HitRow, score = 0): PrincipleHit {
  return {
    seq: r.seq,
    id: r.id,
    collectionId: r.collection_id,
    collectionTitle: r.collection_title,
    edition: r.edition,
    parentLawId: r.parent_law_id,
    principleNo: r.principle_no,
    principleLabel: r.principle_label,
    book: r.book,
    chapter: r.chapter,
    section: r.section,
    text: r.text,
    decisionNo: r.decision_no,
    decisionDateH: r.decision_date_h,
    ref: parseJson(r.ref_json, null),
    similar: parseJson(r.similar_json, []),
    related: parseJson(r.related_json, []),
    retrievalStatus: r.retrieval_status,
    retrievalWarning: r.retrieval_warning,
    sourceUrl: r.source_url,
    sourcePages: r.source_pages,
    score,
  };
}

export interface PrincipleSearchOptions {
  limit?: number;
  /** حصرٌ في مدوّنة. */
  collectionId?: string | null;
  /** حصرٌ في نظامٍ تتبعه المدوّنات: «نظام-العمل». */
  parentLawId?: string | null;
}

/**
 * بحثٌ لفظيٌّ في المبادئ: النصّ مطبَّعاً وجذوعُه، ومقبضُ المبدأ (المدوّنة ورقم
 * المبدأ ورقم القرار). والترتيب bm25. والجدول غير مهيّأ (هجرة لم تُطبَّق) لا
 * يُسقط ما يناديه: يعود فارغاً.
 */
export async function searchPrinciples(env: Env, query: string, opts: PrincipleSearchOptions = {}): Promise<PrincipleHit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), PRINCIPLE_SEARCH_MAX);
  const exprs = [ftsMatchExpression(query), stemMatchExpression(query)].filter((x): x is string => !!x);
  if (!exprs.length) return [];
  const match = exprs.map((e) => `(${e})`).join(' OR ');
  const where: string[] = [];
  const binds: unknown[] = [match];
  if (opts.collectionId) {
    where.push('p.collection_id = ?');
    binds.push(opts.collectionId);
  }
  if (opts.parentLawId) {
    where.push('p.parent_law_id = ?');
    binds.push(opts.parentLawId);
  }
  try {
    const rows = await env.DB.prepare(
      `SELECT ${HIT_COLUMNS}, bm25(legal_principles_fts) AS lex
       FROM legal_principles_fts JOIN legal_principles p ON p.seq = legal_principles_fts.rowid
       WHERE legal_principles_fts MATCH ?${where.length ? ` AND ${where.join(' AND ')}` : ''}
       ORDER BY lex ASC LIMIT ?`
    )
      .bind(...binds, limit)
      .all<HitRow>();
    return (rows.results ?? []).map((r, i) => toHit(r, 1 / (60 + i)));
  } catch {
    return [];
  }
}

/** مبدأٌ بمعرّفه. */
export async function getPrinciple(env: Env, id: string): Promise<PrincipleHit | null> {
  try {
    const row = await env.DB.prepare(`SELECT ${HIT_COLUMNS} FROM legal_principles p WHERE p.id = ?`).bind(id).first<HitRow>();
    return row ? toHit(row) : null;
  } catch {
    return null;
  }
}

export interface PrincipleCollection {
  collection_id: string;
  collection_title: string;
  edition: string | null;
  parent_law_id: string | null;
  principles: number;
  by_status: Record<string, number>;
}

/** المدوّنات المستوردة وعددُ مبادئ كلٍّ منها بحالها. */
export async function listPrincipleCollections(env: Env): Promise<PrincipleCollection[]> {
  try {
    const rows = await env.DB.prepare(
      `SELECT collection_id, collection_title, edition, parent_law_id, retrieval_status, COUNT(*) AS n
       FROM legal_principles GROUP BY collection_id, retrieval_status ORDER BY collection_id`
    ).all<{ collection_id: string; collection_title: string; edition: string | null; parent_law_id: string | null; retrieval_status: string; n: number }>();
    const out = new Map<string, PrincipleCollection>();
    for (const r of rows.results ?? []) {
      const c = out.get(r.collection_id) ?? {
        collection_id: r.collection_id,
        collection_title: r.collection_title,
        edition: r.edition,
        parent_law_id: r.parent_law_id,
        principles: 0,
        by_status: {},
      };
      c.principles += r.n;
      c.by_status[r.retrieval_status] = r.n;
      out.set(r.collection_id, c);
    }
    return [...out.values()];
  } catch {
    return [];
  }
}

/** سقفُ صفحة التصفّح. */
export const PRINCIPLE_PAGE_MAX = 50;

export interface PrincipleBook {
  book: string | null;
  principles: number;
  first_no: number;
}

/**
 * أبوابُ المدوّنة بترتيب ورودها — أوّلُ رقم مبدأٍ فيها — وعددُ مبادئ كلٍّ.
 * والمبدأ بلا باب يُجمع تحت `null`.
 */
export async function listPrincipleBooks(env: Env, collectionId: string): Promise<PrincipleBook[]> {
  try {
    const rows = await env.DB.prepare(
      `SELECT book, COUNT(*) AS principles, MIN(principle_no) AS first_no
       FROM legal_principles WHERE collection_id = ? GROUP BY book ORDER BY first_no`
    )
      .bind(collectionId)
      .all<PrincipleBook>();
    return rows.results ?? [];
  } catch {
    return [];
  }
}

export interface PrincipleBrowse {
  principles: PrincipleHit[];
  total: number;
  offset: number;
}

/**
 * مبادئُ مدوّنةٍ بترتيب أرقامها، صفحةً صفحة — وحصرٌ في بابٍ أو في حال إن طُلب.
 * والحالات الأربع كلُّها تُعرض: التصفّح اطّلاعٌ لا استشهاد، وكلٌّ يحمل تحذيره.
 */
export async function browsePrinciples(
  env: Env,
  collectionId: string,
  opts: { book?: string | null; status?: string | null; offset?: number; limit?: number } = {}
): Promise<PrincipleBrowse> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), PRINCIPLE_PAGE_MAX);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where = ['p.collection_id = ?'];
  const binds: unknown[] = [collectionId];
  if (opts.book) {
    where.push('p.book = ?');
    binds.push(opts.book);
  }
  if (opts.status && PRINCIPLE_STATUSES.includes(opts.status)) {
    where.push('p.retrieval_status = ?');
    binds.push(opts.status);
  }
  const cond = where.join(' AND ');
  try {
    const [rows, count] = await Promise.all([
      env.DB.prepare(`SELECT ${HIT_COLUMNS} FROM legal_principles p WHERE ${cond} ORDER BY p.principle_no LIMIT ? OFFSET ?`)
        .bind(...binds, limit, offset)
        .all<HitRow>(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM legal_principles p WHERE ${cond}`)
        .bind(...binds)
        .first<{ n: number }>(),
    ]);
    return { principles: (rows.results ?? []).map((r) => toHit(r)), total: count?.n ?? 0, offset };
  } catch {
    return { principles: [], total: 0, offset };
  }
}

/** عددُ المبادئ كلِّها — لشريط حال قاعدة المعرفة. وجدولٌ لم يُهيّأ صفر. */
export async function countPrinciples(env: Env): Promise<number> {
  try {
    return (await env.DB.prepare('SELECT COUNT(*) AS n FROM legal_principles').first<{ n: number }>())?.n ?? 0;
  } catch {
    return 0;
  }
}

// ── التنسيق للسياق ولأداة MCP ──

/** سطر الإسناد: المدوّنة، ثم المبدأ، ثم القرار وتاريخه، ثم الصفحة. */
export function principleCitation(h: PrincipleHit): string {
  const parts = [h.collectionTitle, h.principleLabel];
  if (h.decisionNo) parts.push(`القرار ${h.decisionNo}${h.decisionDateH ? ` وتاريخ ${h.decisionDateH}هـ` : ''}`);
  if (h.sourcePages) parts.push(`ص ${h.sourcePages.replace('-', '–')}`);
  return parts.join(' — ');
}

/**
 * مبدأٌ في السياق: سطرُ مصدره، ثم تحذيرُه، ثم نصّه.
 *
 * التحذير **فوق** النصّ كتحذير الموادّ (`noticeLines` في `lib/rag.ts`): ما يُقرأ
 * بعد النصّ يُقرأ متأخراً. وما سوى «نافذ» يحمل تحذيره من المصدر بنصّه.
 */
export function formatPrincipleBlock(h: PrincipleHit, label: string): string {
  const notice = h.retrievalStatus !== PRINCIPLE_EFFECTIVE && h.retrievalWarning ? `تنبيه: ${h.retrievalWarning}\n` : '';
  return `[${label}] المصدر: ${principleCitation(h)}\n${notice}${h.text}`;
}

/** تعليماتُ قسم المبادئ في سياق التوليد — نصٌّ واحد للمنصة ولأداة MCP. */
export const PRINCIPLES_CONTEXT_INSTRUCTIONS = `المقاطع التالية مبادئ قضائية من مدوّنات رسمية — سوابقُ تُعين على فهم كيف قُضي، لا نصوصٌ ملزمة. السندُ الموادُّ النظامية في السياق النظامي؛ والمبدأ يُذكر بعدها ولا يقوم مقامها، ولا يُصاغ صياغة الإلزام. ويُستشهد به باسم المدوّنة ورقم المبدأ ورقم القرار، ولا يُنسب إليه ما لم يرد في نصّه. وما سبقه سطرٌ يبدأ بـ«تنبيه:» فقد تغيّر أساسُه أو جهتُه: اذكره سابقةً بتحذيرها، ولا تقدّمه حكماً جارياً اليوم — وإن أجابت مادةٌ نافذة فهي المقدَّمة. وإن لم يرد في هذا القسم مبدأٌ يتصل بالمسألة فلا تذكر المبادئ أصلاً.`;

/**
 * قسمُ المبادئ في سياق التوليد — بعد السياق النظاميّ لا داخله، كقسم التدعيم
 * الفقهي (`formatFiqhContext`): يبدأ بسطرين فارغين ويُلحق بذيل الرسالة.
 */
export function formatPrinciplesContext(hits: PrincipleHit[]): string {
  if (!hits.length) return '';
  const blocks = hits.map((h, i) => formatPrincipleBlock(h, `م${i + 1}`)).join('\n\n---\n\n');
  return `\n\n<مبادئ_قضائية>\n${PRINCIPLES_CONTEXT_INSTRUCTIONS} والتنبيه جزءٌ من مبدئه — اعمل بمقتضاه ولا تنقل لفظه، ولا تُكتب كلمة «تنبيه» في المستند:\n\n${blocks}\n</مبادئ_قضائية>`;
}

/**
 * مبادئُ لاستعلامات الدور الواحد — مدموجةٌ بالرتب ومقصوصةٌ إلى السقف.
 *
 * لا تُدمج بالموادّ: قائمةٌ وحدها تُعرض في قسمها. وما تعذّر بحثُه يُتجاوز.
 */
export async function retrievePrinciples(env: Env, queries: string[], perQuery = 3, total = 4): Promise<PrincipleHit[]> {
  const merged = new Map<string, PrincipleHit>();
  for (const q of queries) {
    if (!q?.trim()) continue;
    const hits = await searchPrinciples(env, q, { limit: perQuery }).catch(() => [] as PrincipleHit[]);
    hits.forEach((h, rank) => {
      const existing = merged.get(h.id);
      if (existing) existing.score += 1 / (60 + rank);
      else merged.set(h.id, { ...h, score: 1 / (60 + rank) });
    });
  }
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, total);
}
