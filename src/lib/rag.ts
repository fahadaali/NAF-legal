// الاسترجاع (RAG) — §6
//
// مصدران يغذّيان السياق النظامي:
//
// ١) **المقاطع المستوردة** (`legal_chunks`) — مقطوعة سلفاً بحدود موادّها،
//    يبحث فيها بحثٌ هجين (دلاليّ + لفظيّ) في `lib/legal.ts`.
// ٢) **الوثائق المرفوعة** (`kb_documents`) — يقطّعها `chunkText` أدناه لأن
//    لا أحد قطّعها قبلنا.
//
// والتصفية على السريان تُطبَّق على المصدرين هنا — في طبقة الاسترجاع — لا في
// الواجهة. فأيّ مسار: محادثة أو تقرير أو أتمتة أو واجهة برمجية، يمرّ بها.
import { searchLegal, AMENDMENT_NOTICE, DEFERRED_NOTICE, EFFECTIVE_STATUSES, type LegalHit } from './legal';
import { embed } from './embed';
import type { Env } from '../types';

// تُعاد من هنا حفاظاً على مستورديها القائمين (`ingest.ts`).
export { embed, embedBatch } from './embed';

/**
 * تقسيم النص إلى مقاطع بحدود منطقية (المواد/الفقرات) مع تداخل بسيط.
 *
 * **لوثائق تُرفَع فتُستخرَج نصّاً وحدها.** المقاطع المستوردة عبر عقد
 * الاستيراد لا تمرّ من هنا أبداً: سطرٌ = مقطع، وإعادة تقطيعه تقصّ في منتصف
 * المواد بلا وعي بحدودها.
 */
export function chunkText(text: string, targetChars = 1200, overlap = 150): string[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length <= targetChars) return clean ? [clean] : [];

  // نحاول القطع عند حدود المواد أولًا
  const articleSplit = clean.split(/(?=(?:المادة|مادة)\s+[\(\d])/);
  const chunks: string[] = [];
  let current = '';
  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const part of articleSplit) {
    if ((current + part).length > targetChars && current) {
      pushCurrent();
      // تداخل: أعِد آخر جزء
      current = current.length > overlap ? '' : current;
    }
    current += part;
    while (current.length > targetChars * 1.5) {
      chunks.push(current.slice(0, targetChars).trim());
      current = current.slice(targetChars - overlap);
    }
  }
  pushCurrent();
  return chunks.filter(Boolean);
}

export interface RagResult {
  /** النصّ المعروض والمُستشهَد به. للمقاطع المستوردة: `text` لا `embed_text`. */
  text: string;
  score: number;
  documentId: string;
  title: string;
  articleRef?: string;
  /** مفتاح المقطع للدمج — معرّف المتجه للوثائق، ومعرّف العقد للمقاطع. */
  key?: string;
  // ── ما يزيد في المقاطع المستوردة (للاستشهاد الدقيق) ──
  source?: 'legal' | 'document';
  lawId?: string;
  docType?: string;
  articleNo?: string;
  /** نوع أداة الإصدار: مرسوم ملكي، قرار مجلس الوزراء… */
  instrument?: string;
  instrumentNo?: string;
  /** الجهة صاحبة النظام. */
  authority?: string;
  issueDate?: string;
  issueDateHijri?: string;
  sourceUrl?: string;
  /** مادةٌ عُدِّلت ونصُّها المعروض أصليّ — يُذكر تنبيهها مع المقطع. */
  amendmentPending?: boolean;
  /** دُمج تعديلُها في نصّها — فالاستشهاد يقول «بصيغتها بعد كذا». */
  amendmentApplied?: boolean;
  amendmentInstrument?: string;
  amendedOn?: string;
  /** تاريخ نفاذها لم يحلّ بعد — نصُّها سابقٌ لأوانه. */
  effectivePending?: boolean;
  effectiveFrom?: string;
}

/** ثابت دمج الرتب — كما في `lib/legal.ts`. */
const RRF_K = 60;

/**
 * البحث في المصدرين وإعادة أوثق المقاطع مع الإسناد.
 *
 * الدمج بالرتب لا بالدرجات: درجة bm25 ودرجة التشابه الجيبي ورتب مصدرين
 * مختلفين لا تُجمع على مقياس واحد.
 */
export async function retrieve(env: Env, queries: string[], topK = 5): Promise<RagResult[]> {
  const lists: RagResult[][] = [];

  for (const q of queries) {
    if (!q?.trim()) continue;
    // تضمينٌ واحد للاستعلام يخدم المصدرين: هو استدعاء شبكة، وحسابه مرّتين
    // يضيف زمناً على كل دور محادثة بلا مقابل.
    let queryVector: number[] | undefined;
    if (env.VECTORIZE) {
      try {
        queryVector = await embed(env, q);
      } catch {
        // نموذج التضمين غير متاح — يبقى البحث اللفظي في المقاطع المستوردة.
      }
    }
    // المقاطع المستوردة — بحث هجين، والتصفية على السريان داخله.
    try {
      const legal = await searchLegal(env, q, { limit: topK, queryVector });
      if (legal.length) lists.push(legal.map(fromLegalHit));
    } catch {
      // جدول المقاطع غير مهيّأ بعد (هجرة لم تُطبَّق) — نتابع بالوثائق وحدها.
    }
    // الوثائق المرفوعة — دلاليّ وحده، فهي غير مفهرسة لفظياً.
    if (queryVector) {
      const docs = await retrieveDocuments(env, queryVector, topK);
      if (docs.length) lists.push(docs);
    }
  }

  const merged = new Map<string, RagResult>();
  for (const list of lists) {
    list.forEach((r, rank) => {
      const key = r.key ?? `${r.source ?? 'document'}:${r.documentId}`;
      const existing = merged.get(key);
      if (existing) {
        existing.score += 1 / (RRF_K + rank);
      } else {
        merged.set(key, { ...r, score: 1 / (RRF_K + rank) });
      }
    });
  }

  return Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function fromLegalHit(h: LegalHit): RagResult {
  return {
    // `text` وحده. ولو وُضع `embed_text` هنا لتلوّث الاستشهاد بسياق زائد.
    text: h.text,
    score: h.score,
    documentId: h.id,
    title: h.lawTitle || h.lawId || 'نظام',
    articleRef: h.articleNo ? `المادة ${h.articleNo}` : undefined,
    key: `legal:${h.id}`,
    source: 'legal',
    lawId: h.lawId ?? undefined,
    docType: h.docType ?? undefined,
    articleNo: h.articleNo ?? undefined,
    instrument: h.instrument ?? undefined,
    instrumentNo: h.instrumentNo ?? undefined,
    authority: h.authority ?? undefined,
    issueDate: h.issueDate ?? undefined,
    issueDateHijri: h.issueDateHijri ?? undefined,
    sourceUrl: h.sourceUrl ?? undefined,
    amendmentPending: h.hasAmendments && !h.amendmentApplied,
    amendmentApplied: h.hasAmendments && h.amendmentApplied,
    amendmentInstrument: h.amendmentInstrument ?? undefined,
    amendedOn: h.amendedOn ?? undefined,
    effectivePending: h.effectivePending,
    effectiveFrom: h.effectiveFrom ?? h.effectiveFromHijri ?? undefined,
  };
}

/**
 * الوثائق المرفوعة: بحث دلاليّ في `VECTORIZE` ثم إسقاط ما وثيقتُه منسوخة.
 *
 * الإسقاط هنا لا في الواجهة، للسبب نفسه: تقريرٌ أو أتمتة تستدعي الاسترجاع
 * مباشرةً لا تمرّ بواجهةٍ أصلاً.
 */
async function retrieveDocuments(env: Env, queryVector: number[], topK: number): Promise<RagResult[]> {
  if (!env.VECTORIZE) return [];
  let matches: VectorizeMatches;
  try {
    matches = await env.VECTORIZE.query(queryVector, { topK, returnMetadata: 'all' });
  } catch {
    return [];
  }

  const found: { docId: string; result: RagResult }[] = [];
  for (const m of matches.matches ?? []) {
    // متجهات المقاطع المستوردة تُسترجَع من مسارها الهجين لا من هنا.
    if (m.id.startsWith('legal:')) continue;
    const meta = (m.metadata ?? {}) as any;
    const docId = String(meta.document_id ?? '');
    found.push({
      docId,
      result: {
        text: meta.text ?? '',
        score: m.score,
        documentId: docId,
        title: meta.title ?? 'نظام',
        articleRef: meta.article_ref || undefined,
        key: m.id,
        source: 'document',
      },
    });
  }
  if (!found.length) return [];

  const effective = await effectiveDocumentIds(env, [...new Set(found.map((f) => f.docId).filter(Boolean))]);
  return found.filter((f) => !f.docId || effective.has(f.docId)).map((f) => f.result);
}

/** معرّفات الوثائق السارية من بين المعطاة. حالةٌ غير مضبوطة تُعامَل كسارية. */
async function effectiveDocumentIds(env: Env, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const marks = ids.map(() => '?').join(',');
  const statuses = EFFECTIVE_STATUSES.map(() => '?').join(',');
  try {
    const rows = await env.DB.prepare(
      `SELECT id FROM kb_documents WHERE id IN (${marks}) AND (status IS NULL OR status IN (${statuses}))`
    )
      .bind(...ids, ...EFFECTIVE_STATUSES)
      .all<{ id: string }>();
    return new Set((rows.results ?? []).map((r) => r.id));
  } catch {
    return new Set(ids);
  }
}

/* ══ فهرس المحادثات المتجهي — أُسقط ══
 *
 * كان هنا `indexConversationMessage` و`searchConversations`: الأولى تُنادى
 * مرّتين في كل دور محادثة — لرسالة المستخدم ولردّ المساعد — فتستدعي نموذج
 * التضمين ثم تدفع المتجه إلى `CONV_VECTORIZE`. والثانية القارئُ الوحيد لذلك
 * الفهرس، **ولم تُنادَ من أي موضع في المنصة**.
 *
 * فكان الفهرس يُكتب ولا يُقرأ: نداءَا تضمين وكتابتان على كل رسالةٍ من كل
 * مستخدم، لفهرسٍ لا يستعلمه أحد. وليس تأجيلاً: `DEPLOY_TRIGGER.md` يقيّد أن
 * صلاحية Vectorize مُنحت، وسير النشر يفكّ تعليق الربط متى وجد الفهرسين.
 *
 * والبحث في المنصة لفظيٌّ بقرارٍ مكتوب في `routes/search.ts`: «يبحث المستخدم
 * بكلماته فتُطابَق كلماتُه» — لا تضمين ولا نداء نموذج ولا كلفتُه ولا تأخيرُه.
 * فالكتابة هي اليتيمة لا القراءة، وهي التي تُنزع.
 *
 * والاسترجاع للتوليد لا يمسّه شيء من هذا: مصدره `VECTORIZE` و`legal_chunks`
 * في `retrieve` أعلاه، وهو حيٌّ يُقرأ في كل دور.
 */

// تنسيق سياق RAG لإدراجه في البرومبت مع الإسناد
export function formatRagContext(results: RagResult[]): string {
  if (!results.length) return '';
  const blocks = results
    .map((r, i) => `[${i + 1}] المصدر: ${citationLine(r)}\n${noticeLines(r)}${r.text}`)
    .join('\n\n---\n\n');
  return `<سياق_نظامي>\nالمقاطع التالية مسترجَعة من قاعدة المعرفة النظامية الرسمية. استند إليها وأشِر لأرقامها عند الاقتباس. وما سبقه سطرٌ يبدأ بـ«تنبيه:» فالتنبيه جزءٌ منه لا حاشيةٌ عليه — انقله مع الاستشهاد:\n\n${blocks}\n</سياق_نظامي>`;
}

/**
 * تنبيهات المادة، فوق نصّها مباشرةً.
 *
 * مسارُ التوليد لا يمرّ بشاشة، فلو بقيت التنبيهات في الواجهة وحدها لوصل
 * النصُّ إلى البرومبت مجرَّداً واستُشهد به على أنه الجاري — وهو أخطر خطأ في
 * منتج قانوني. وموضعُها قبل النصّ لا بعده: ما يُقرأ بعد النصّ يُقرأ متأخراً.
 */
function noticeLines(r: RagResult): string {
  const lines: string[] = [];
  if (r.amendmentPending) {
    const by = [r.amendmentInstrument, r.amendedOn].filter(Boolean).join(' — ');
    lines.push(`تنبيه: ${AMENDMENT_NOTICE}${by ? ` (${by})` : ''}`);
  }
  if (r.effectivePending) {
    lines.push(`تنبيه: ${DEFERRED_NOTICE}${r.effectiveFrom ? ` (${r.effectiveFrom})` : ''}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * سطر الإسناد: اسم النظام، ثم المادة، ثم رقم الأداة، ثم تاريخ الإصدار.
 *
 * التاريخ ميلاديّ يتبعه الهجريّ بين قوسين — تاريخ أداةٍ نظامية يُستشهد به.
 */
function citationLine(r: RagResult): string {
  const parts = [r.title];
  if (r.articleRef) parts.push(r.articleRef);
  if (r.instrumentNo) parts.push(r.instrumentNo);
  if (r.issueDate) parts.push(r.issueDateHijri ? `${r.issueDate} (${r.issueDateHijri})` : r.issueDate);
  else if (r.issueDateHijri) parts.push(r.issueDateHijri);

  /* ونسخةُ النصّ تُقال حين تكون له نسخ.
   *
   * «المادة الخامسة من النظام الأساسي للحكم» تصف موضعاً، و«بصيغتها بعد الأمر
   * أ/256 وتاريخ 26/9/1438هـ» تصف **أيَّ نصٍّ** في ذلك الموضع. ومادةٌ عُدِّلت
   * ثلاث مرّات لها ثلاثة نصوص، والاستشهاد بالرقم وحده يصدق على أيّها. */
  if (r.amendmentApplied) {
    const by = [r.amendmentInstrument, r.amendedOn].filter(Boolean).join(' وتاريخ ');
    if (by) parts.push(`بصيغتها بعد ${by}`);
  }
  return parts.filter(Boolean).join(' — ');
}
