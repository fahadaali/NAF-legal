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
import {
  searchLegal,
  articleBaseId,
  AMENDMENT_NOTICE,
  DEFERRED_NOTICE,
  RETRIEVAL_WARNING,
  type LegalHit,
} from './legal';
import { embed } from './embed';
import type { RetrievalTrace } from './research/trace';
import { searchDocuments } from './research/documents';
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
  /** المفتاح الداخلي لأوّل أجزاء المادة — به تُستعاد في الدور التالي بنصّها الجاري. */
  seq?: number;
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
  /**
   * نصُّ تحذيرها جاهزاً حين تكون حالُها «نافذ بتحذير» — من طبقة الاسترجاع لا
   * مُركَّباً هنا: قد يكون تعديلاً لم يُدمج، وقد يكون نظاماً لم يبدأ العمل به
   * بتاريخ نفاذه والنافذ قبله (§5-5).
   */
  retrievalWarning?: string;
  /** صفحاتُ السجل في ملف الجهة — للائحة من خارج البوابة (§3-13). */
  sourcePages?: [number, number];
  /** نسخةُ الجهة كما في ملفها. */
  sourceVersion?: string;
}

/** ثابت دمج الرتب — كما في `lib/legal.ts`. */
const RRF_K = 60;

/**
 * البحث في المصدرين وإعادة أوثق المقاطع مع الإسناد.
 *
 * `topK` ما يُطلب لكل استعلام، و`total` سقفُ ما يعود بعد الدمج (افتراضاً مثله).
 *
 * الدمج بالرتب لا بالدرجات: درجة bm25 ودرجة التشابه الجيبي ورتب مصدرين
 * مختلفين لا تُجمع على مقياس واحد.
 */
export async function retrieve(
  env: Env,
  queries: string[],
  topK = 5,
  total = topK,
  trace?: RetrievalTrace
): Promise<RagResult[]> {
  const lists: RagResult[][] = [];

  for (const q of queries) {
    if (!q?.trim()) continue;
    trace?.add({ stage: 'query', query: q });
    // تضمينٌ واحد للاستعلام يخدم المصدرين: هو استدعاء شبكة، وحسابه مرّتين
    // يضيف زمناً على كل دور محادثة بلا مقابل.
    let queryVector: number[] | undefined;
    if (env.VECTORIZE) {
      try {
        queryVector = await embed(env, q);
      } catch (e) {
        // نموذج التضمين غير متاح — يبقى البحث اللفظي في المقاطع المستوردة.
        trace?.fail('embed', e, q);
      }
    }
    // المقاطع المستوردة — بحث هجين، والتصفية على السريان داخله.
    try {
      const legal = await searchLegal(env, q, {
        limit: topK,
        queryVector,
        onSignal: trace ? (sig) => trace.add({ ...sig, query: q }) : undefined,
      });
      if (legal.length) lists.push(joinArticleParts(legal).map(fromLegalHit));
    } catch (e) {
      // جدول المقاطع غير مهيّأ بعد (هجرة لم تُطبَّق) — نتابع بالوثائق وحدها.
      trace?.fail('legal', e, q);
    }
    // الوثائق المرفوعة — هجينٌ كذلك (`research/documents.ts`).
    const docs = await searchDocuments(env, q, {
      limit: topK,
      queryVector,
      onSignal: trace ? (sig) => trace.add({ ...sig, query: q }) : undefined,
    });
    trace?.add({ stage: 'documents', query: q, count: docs.length });
    if (docs.length) lists.push(docs);
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
    // `topK` لكل استعلام و`total` للمجموع. وكانا واحداً، فاستعلاماتٌ ثمانية لكلٍّ
    // منها أربعٌ تنتهي إلى أربعٍ لا إلى اثنتين وثلاثين.
    .slice(0, total);
}

/**
 * أجزاءُ المادة المقسّمة مقطعٌ واحد في السياق (§5-8).
 *
 * طبقةُ الاسترجاع تردّها متتابعةً مرتّبة، وتركُها نتائجَ مستقلّة يجعل الدمجَ
 * بالرتب والسقفَ بعده يقطعان المادة بين جزأيها — فيصل إلى المساعد نصفُ حكمٍ
 * على أنه الحكم. فتُجمع هنا نصّاً واحداً بأسطرها، ويبقى المعرّفُ معرّفَ أوّل
 * جزء: استدعاؤه يفتح المادة بأجزائها كلِّها.
 */
export function joinArticleParts(hits: LegalHit[]): LegalHit[] {
  const out: LegalHit[] = [];
  for (const h of hits) {
    const last = out[out.length - 1];
    if (last && h.part && last.part && h.id.includes('#') && articleBaseId(last.id) === articleBaseId(h.id)) {
      // وتحذيرُ أيِّ جزءٍ تحذيرٌ للمادة: جزءٌ عليه تعديلٌ لم يُدمج لا يصل
      // سياقَ المساعد بلا تنبيهه لأن جزءاً قبله سليم.
      const warned = last.retrievalStatus !== RETRIEVAL_WARNING && h.retrievalStatus === RETRIEVAL_WARNING;
      out[out.length - 1] = {
        ...last,
        ...(warned
          ? {
              retrievalStatus: h.retrievalStatus,
              retrievalWarning: h.retrievalWarning,
              hasAmendments: h.hasAmendments,
              amendmentApplied: h.amendmentApplied,
              amendmentInstrument: h.amendmentInstrument,
              amendedOn: h.amendedOn,
            }
          : {}),
        text: `${last.text}\n${h.text}`,
        // وصفحاتُ المادة من أوّل جزءٍ إلى آخره: الاستشهاد بها لا بصفحة جزئها الأوّل.
        sourcePages:
          last.sourcePages && h.sourcePages
            ? [Math.min(last.sourcePages[0], h.sourcePages[0]), Math.max(last.sourcePages[1], h.sourcePages[1])]
            : (last.sourcePages ?? h.sourcePages),
      };
    } else {
      out.push(h);
    }
  }
  return out;
}

export function fromLegalHit(h: LegalHit): RagResult {
  return {
    // `text` وحده. ولو وُضع `embed_text` هنا لتلوّث الاستشهاد بسياق زائد.
    text: h.text,
    score: h.score,
    documentId: h.id,
    title: h.lawTitle || h.lawId || 'نظام',
    articleRef: articleRefOf(h),
    // بمعرّف المادة لا الجزء: المادة الواحدة لا تُعدّ في الدمج مرّتين.
    key: `legal:${articleBaseId(h.id)}`,
    seq: h.seq,
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
    retrievalWarning:
      h.retrievalStatus === RETRIEVAL_WARNING ? (h.retrievalWarning ?? AMENDMENT_NOTICE) : undefined,
    sourcePages: h.sourcePages ?? undefined,
    sourceVersion: h.sourceVersion ?? undefined,
  };
}

/**
 * ما يُستشهد به من موضع المادة.
 *
 * الملحق بعنوانه لا برقمه: رقمُه اصطلاحيّ (`1001`) للترتيب وحده، ولا مادةَ بهذا
 * الرقم في أي نظام (§3-12) — والاستشهاد به يُحيل القاضي إلى ما لا وجود له.
 * والمرفق بعنوانه كذلك («مرفق المادة 14»)، ومادة «مكرر» بعنوانها لا برقم أصلها
 * فلا تُقرأ المادةَ الأصل.
 */
function articleRefOf(h: LegalHit): string | undefined {
  if (h.isAnnex || h.isAttachment || h.isMukarrar) return h.articleLabel ?? undefined;
  return h.articleNo ? `المادة ${h.articleNo}` : undefined;
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
/** مقطعٌ واحد في السياق: رقمُه وسطرُ مصدره وتنبيهاتُه ثم نصُّه. */
export function formatRagBlock(r: RagResult, n: number): string {
  return `[${n}] المصدر: ${citationLine(r)}\n${noticeLines(r)}${r.text}`;
}

export function formatRagContext(results: RagResult[]): string {
  if (!results.length) return '';
  const blocks = results.map((r, i) => formatRagBlock(r, i + 1)).join('\n\n---\n\n');
  return wrapRagContext(blocks);
}

/** الوسم وتعليماته حول المقاطع — موضعٌ واحد لنصّ التعليمات. */
/** تعليماتُ السياق النظاميّ — نصٌّ واحد للصيغتين: النصّية وكتل `search_result`. */
export const RAG_CONTEXT_INSTRUCTIONS = `المقاطع التالية مسترجَعة من قاعدة المعرفة النظامية الرسمية. استند إليها، واستشهد بها في المتن باسم النظام ورقم المادة وحدهما. وما في سطر مصدره من أداةٍ وتاريخ و«بصيغتها بعد …» وصفحةٍ ونسخة فلا يُنقل إلى المتن إلا ما يطلبه توجيه المهمة نصّاً؛ ونسخةُ المادة المعدَّلة تُذكر في «ملاحظات للمحامي» كما وردت. وما سبقه سطرٌ يبدأ بـ«تنبيه:» فالتنبيه جزءٌ منه لا يُفصل عنه، وهو للمحامي لا لمن يُوجَّه إليه المستند: اعمل بمقتضاه فلا تعرض النصّ على أنه الجاري، وانقله بنصّه مع الاستشهاد في قسم «ملاحظات للمحامي» لا في متن المستند. وما نبّه التنبيه أن نصَّه أصليٌّ لم يُدمج تعديلُه فلا تصغ نصَّه النافذ من عندك: اترك مكانه في المتن خانةً بين معقوفين تسمّيه، وقل في «ملاحظات للمحامي» إن النصّ النافذ غير متاح في قاعدة المعرفة، وأحِل إلى سجل التعديلات.`;

export function wrapRagContext(blocks: string): string {
  return `<سياق_نظامي>\n${RAG_CONTEXT_INSTRUCTIONS}\n\n${blocks}\n</سياق_نظامي>`;
}

/**
 * تنبيهات المادة، فوق نصّها مباشرةً.
 *
 * مسارُ التوليد لا يمرّ بشاشة، فلو بقيت التنبيهات في الواجهة وحدها لوصل
 * النصُّ إلى البرومبت مجرَّداً واستُشهد به على أنه الجاري — وهو أخطر خطأ في
 * منتج قانوني. وموضعُها قبل النصّ لا بعده: ما يُقرأ بعد النصّ يُقرأ متأخراً.
 */
export function noticeLines(r: RagResult): string {
  const lines: string[] = [];
  // تحذيرُ الحال بنصّه كما جاء من طبقة الاسترجاع (§6-4): هو الذي يعرف سببه —
  // تعديلٌ لم يُدمج أو نظامٌ لم يبدأ العمل به — ويذكر تاريخه والنافذ قبله.
  // وكان التنبيه يُركَّب هنا من التعديل وحده، فتصل مادةُ نظامٍ لم يبدأ العمل به
  // إلى البرومبت بلا تحذيرها وتُقرأ نافذة.
  if (r.retrievalWarning) {
    const by = r.amendmentPending ? [r.amendmentInstrument, r.amendedOn].filter(Boolean).join(' — ') : '';
    lines.push(`تنبيه: ${r.retrievalWarning}${by ? ` (${by})` : ''}`);
  }
  // ولا تحذيرَ يُشتقّ هنا من الحقول المنطقية (§3-4): مادةٌ صعّد مراجعٌ حالها
  // بعد أن قرأ ألواحها كان الاشتقاق يعيد تحذيرها، فلا يبقى للاعتماد أثر. وما
  // سبق عمودَ الحال اشتُقّت حالُه مرّةً في الهجرة 0030.
  if (r.effectivePending && r.retrievalWarning !== DEFERRED_NOTICE) {
    lines.push(`تنبيه: ${DEFERRED_NOTICE}${r.effectiveFrom ? ` (${r.effectiveFrom})` : ''}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * سطر الإسناد: اسم النظام، ثم المادة، ثم صفحتها ونسخة الجهة إن جاءت من ملفّ
 * جهة، ثم رقم الأداة، ثم تاريخ الإصدار.
 *
 * التاريخ ميلاديّ يتبعه الهجريّ بين قوسين — تاريخ أداةٍ نظامية يُستشهد به.
 */
export function citationLine(r: RagResult): string {
  const parts = [r.title];
  if (r.articleRef) parts.push(r.articleRef);
  /* واللائحةُ من خارج البوابة يُستشهد بصفحتها في ملف الجهة ونسختها (§6-4):
   * «المادة 12، ص 14، نسخة 2025-04». النسخةُ تقول أيَّ ملفٍّ، والصفحةُ أين فيه. */
  if (r.sourcePages) {
    const [from, to] = r.sourcePages;
    parts.push(from === to ? `ص ${from}` : `ص ${from}–${to}`);
  }
  if (r.sourceVersion) parts.push(`نسخة ${r.sourceVersion}`);
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
