// عقد استيراد المحتوى النظامي وطبقة استرجاعه.
//
// أربعة التزامات يقوم عليها هذا الملف:
//
// ١) **الاستيراد: سطر واحد = مقطع واحد.** ملف JSONL بترميز UTF-8 بلا BOM،
//    سطرٌ مستقل لكل مادة. والتقطيع التلقائي **معطَّل هنا**: لا `chunkText`
//    ولا ما يشبهه في هذا المسار. من أعدّ الملف عرف حدود المواد، وإعادة
//    تقطيعها تقصّ في منتصفها بلا وعي بها فيضيع ما بُني.
//
// ٢) **الفهرسة: حقلان بدورين.** `embed_text` وحده يُحوَّل إلى متجه،
//    و`text` وحده يُعرض ويُستشهد به. خلطهما يعني إمّا ضعف الاسترجاع (لو
//    حُوِّل `text` المجرّد) أو تلويث الاستشهاد بسياق زائد (لو عُرض
//    `embed_text`). ولذلك لا يظهر `embed_text` في `HIT_COLUMNS` أبداً.
//
// ٣) **البحث هجين مع تطبيع عربي.** دلاليّ على المتجهات + لفظيّ على النصّ،
//    ودمج النتيجتين. اللفظي ضروريّ لأن المستخدم يبحث برقم مادة أو مصطلح
//    حرفي، والدلالي وحده يخذل فيها.
//
// ٤) **التصفية على السريان في طبقة الاسترجاع لا في الواجهة.** الشرط مكتوب
//    في SQL هنا، فأيّ نداء — من محادثة أو تقرير أو أتمتة أو واجهة برمجية —
//    يمرّ به. ولو تُرك للواجهة لتجاوزه أوّل مسار آخر واستشهد بمادة منسوخة.
//
// وأضاف الإصدار الثاني من المواصفة ثلاثةً تجري في الطبقة نفسها للسبب نفسه:
//
// ٥) **الحجب المشروط.** مادةٌ موسومة `needs_review` لا تدخل الاسترجاع الآلي
//    حتى يعتمدها إنسان. تبقى في القاعدة وتُرى في شاشة المراجعة والتصفّح،
//    ولا تصل إلى إجابةٍ ولا تقرير. والتصنيف الآلي يقترح ولا يقرّر.
//
// ٦) **التنبيه الإلزامي.** مادةٌ `has_amendments` ونصُّها غير نافذ
//    (`amendment_applied = 0`) تُعرض ومعها أن المعروض هو النصّ الأصلي.
//    والتنبيه يرافق النتيجة من هنا — لا من الواجهة — فيبلغ سياقَ التوليد
//    كما يبلغ الشاشة.
//
// ٧) **أخوات الرقم الواحد.** استدعاء مادةٍ برقمها يردّ كل من يحمل رقمها
//    مرتّبةً بـ`duplicate_index`، لا الأولى وحدها: المرسوم المعدِّل يُدخل
//    مادةً جديدة برقم مادةٍ قائمة، وردُّ الأولى يُخفي الثانية بلا أثر.
import { normalizeArabic, normalizeArticleNo, extractArticleNo, ftsMatchExpression } from './arabic';
import { toHijri } from './hijri';
import { embed, embedBatch } from './embed';
import { uuid } from './crypto';
import type { Env } from '../types';

// ── ثوابت العقد ──

/** حالات السريان. `amended` نظامٌ عُدِّل وما زال سارياً، فيبقى قابلاً للاستشهاد. */
export const EFFECTIVE_STATUSES = ['active', 'amended'] as const;
const VALID_STATUSES = new Set(['active', 'amended', 'repealed']);

/**
 * ألفاظ الحالة العربية ومقابلها المسجَّل.
 *
 * الملفات المُعدَّة من المصادر الرسمية تكتب الحالة بالعربية، والمعاني هي
 * الثلاثة نفسها لا رابع لها — فهذه ترجمةٌ محصورة لا توسيعٌ للعقد: لا تُضيف
 * حالةً رابعة ولا تُغيّر ما تعنيه واحدةٌ من الثلاث.
 *
 * وتُطبَّع قبل المطابقة، فـ«سارٍ» و«سارية» و«ساري» شيء واحد.
 */
const STATUS_ALIASES = new Map<string, string>(
  (
    [
      ['ساري', 'active'],
      // الصيغة المنقوصة: «سارٍ» تُطبَّع إلى «سار» — تنوينُها يسقط مع التشكيل
      // وياؤها ساقطةٌ في الرسم أصلاً، فلا تلتقي بـ«ساري» ولو طُبّعت.
      ['سار', 'active'],
      ['سارية', 'active'],
      ['نافذ', 'active'],
      ['نافذة', 'active'],
      ['معمول به', 'active'],
      ['مُعدَّل', 'amended'],
      ['مُعدَّلة', 'amended'],
      ['ملغي', 'repealed'],
      ['ملغ', 'repealed'],
      ['ملغى', 'repealed'],
      ['ملغاة', 'repealed'],
      ['منسوخ', 'repealed'],
      ['منسوخة', 'repealed'],
    ] as [string, string][]
  ).map(([k, v]) => [normalizeArabic(k), v] as [string, string])
);

/**
 * أنواع الأدوات النظامية ومقابلها العربي.
 *
 * الملفات تكتب النوع عربياً، والمخزَّن إنجليزيٌّ واحد — كما تُخزَّن الحالة.
 * لغتان في حقلٍ واحد تعني قيمتين لمعنىً واحد في مرشّح النوع، وهو انحرافٌ لا
 * يظهر إلا بعد دفعتين.
 *
 * و«تنظيم» قيمةٌ رابعة مسجَّلة لا تُردّ إلى «لائحة»: التنظيم أداةٌ قائمة
 * بذاتها في الصياغة السعودية، وردُّه إليها يخلط أداتين.
 */
export const DOC_TYPES: Record<string, string> = {
  law: 'نظام',
  regulation: 'لائحة',
  arrangement: 'تنظيم',
  decision: 'قرار',
  circular: 'تعميم',
};

const DOC_TYPE_ALIASES = new Map<string, string>(
  (
    [
      ['نظام', 'law'],
      ['أنظمة', 'law'],
      ['لائحة', 'regulation'],
      ['اللائحة التنفيذية', 'regulation'],
      ['لوائح', 'regulation'],
      ['تنظيم', 'arrangement'],
      ['ترتيب', 'arrangement'],
      ['قرار', 'decision'],
      ['تعميم', 'circular'],
    ] as [string, string][]
  ).map(([k, v]) => [normalizeArabic(k), v] as [string, string])
);

/**
 * حالُ الاسترجاع — الحقل الذي يُبنى عليه القرار وحده.
 *
 * ثلاثٌ لا رابع لها: `effective` نافذ · `effective_warning` نافذ بتحذير
 * (نصُّه أصليٌّ وعليه تعديل تعذّر دمجه) · `repealed` ملغى.
 */
export const RETRIEVAL_EFFECTIVE = 'effective';
export const RETRIEVAL_WARNING = 'effective_warning';
export const RETRIEVAL_REPEALED = 'repealed';
const VALID_RETRIEVAL = new Set([RETRIEVAL_EFFECTIVE, RETRIEVAL_WARNING, RETRIEVAL_REPEALED]);

export const RETRIEVAL_LABELS: Record<string, string> = {
  [RETRIEVAL_EFFECTIVE]: 'نافذ',
  [RETRIEVAL_WARNING]: 'نافذ بتحذير',
  [RETRIEVAL_REPEALED]: 'ملغى',
};

const RETRIEVAL_ALIASES = new Map<string, string>(
  (
    [
      ['نافذ', RETRIEVAL_EFFECTIVE],
      ['نافذة', RETRIEVAL_EFFECTIVE],
      ['ساري', RETRIEVAL_EFFECTIVE],
      ['نافذ_بتحذير', RETRIEVAL_WARNING],
      ['نافذ بتحذير', RETRIEVAL_WARNING],
      ['نافذ-بتحذير', RETRIEVAL_WARNING],
      ['ملغى', RETRIEVAL_REPEALED],
      ['ملغاة', RETRIEVAL_REPEALED],
      ['ملغي', RETRIEVAL_REPEALED],
      ['منسوخ', RETRIEVAL_REPEALED],
    ] as [string, string][]
  ).map(([k, v]) => [normalizeArabic(k), v] as [string, string])
);

/**
 * التصفية الافتراضية الإلزامية.
 *
 * ثلاثة شروطٍ لا شرط: `retrieval_status` هو حقل المواصفة، ويرافقه الحقلان
 * القديمان لأن دفعةً لم تحمله بعدُ قد تكون في القاعدة — وأيُّها قال «منسوخ»
 * كفى لإخراج المادة. الاتجاه الآمن: مادةٌ غائبة أهون من مادة منسوخة
 * يُستشهد بها.
 */
const EFFECTIVE_SQL = `c.retrieval_status <> '${RETRIEVAL_REPEALED}'
                       AND c.is_repealed = 0 AND c.status IN ('active','amended')`;

/**
 * الحالات التي تُدخل المادة الاسترجاع.
 *
 * اثنتان لا خمس: المعتمدة والمحرَّرة. والمستبعدة والمؤجَّلة تخرجان من الطابور
 * ولا تدخلان الاسترجاع — الأولى بقرارٍ نهائي والثانية بأجلٍ لم يُضرَب له موعد.
 */
export const REVIEW_CLEARED = ['approved', 'edited'] as const;

/** الحالة التي تُبقي المادة في الطابور. */
const REVIEW_PENDING = 'pending';

/**
 * الحجب المشروط — على العطب وحده لا على وسم المراجعة كلِّه.
 *
 * **وهذا تغيّرٌ عن سابقه، وله سبب.** كان كلُّ ما وُسِم `needs_review` محجوباً
 * حتى يعتمده إنسان، فكانت مادةٌ عليها تعديلٌ تعذّر دمجه تغيب عن البحث. ووثيقة
 * الاستيراد تردّ ذلك: حجبُها يجعل المستخدم يظنّ أن لا نصّ في الموضوع أصلاً،
 * وهو أسوأ من نصٍّ مصحوب بتحذير — والصمت في المنتج القانوني ليس حياداً.
 *
 * والحجّة تصدق على التحذير ولا تصدق على العطب: مادةٌ تسرّبت إلى متنها واجهةُ
 * البوابة، أو رقمٌ مكرّر لم يُبتّ فيه، أو نصٌّ مشبوه الاقتطاع — عرضُها ليس
 * كسراً للصمت، بل عرضُ ما لا يُقرأ. فتبقى محجوبةً حتى يبتّ فيها إنسان.
 *
 * والاستبعاد التام أعلاه شيءٌ آخر: المنسوخة خرجت من النظام فلا تُستشهد أبداً،
 * وهذه نصٌّ لم يُتحقَّق منه بعد. والشرطان مستقلّان: تجاوزُ أحدهما لا يفتح الآخر.
 */
const SOUND_SQL = `(c.has_defect = 0 OR c.review_status IN (${REVIEW_CLEARED.map((s) => `'${s}'`).join(',')}))`;

/**
 * أعمدة النتيجة.
 *
 * **لا `embed_text` هنا ولا في أي مسار عرض.** هو مدخل المتجه وحده، ولا
 * يقرؤه إلا `embedPending` أدناه. ومثله `amendments_raw` و`text_superseded`:
 * الأول نافذةُ تعديلٍ خام قد تبلغ آلاف الأحرف، والثاني نصٌّ نُسخ — وحملُهما
 * في كل نتيجة بحثٍ ثمنٌ بلا مقابل، وعرضُهما مكان النصّ النافذ خطأ. يُقرآن
 * بطلبٍ صريح في `getChunkAmendment`.
 */
const HIT_COLUMNS = `c.seq, c.id, c.law_id, c.parent_law_id, c.doc_type, c.article_no,
    c.article_no_norm, c.article_label, c.article_title, c.book, c.chapter, c.section,
    c.instrument, c.instrument_no, c.authority, c.status, c.is_repealed, c.law_title,
    c.issue_date, c.issue_date_hijri, c.effective_from, c.effective_from_hijri, c.effective_to,
    c.source_url, c.text, c.part, c.parts_total,
    c.is_duplicate, c.duplicate_of, c.duplicate_index,
    c.has_amendments, c.amendment_kind, c.amendment_applied, c.needs_review, c.reviewed_at,
    c.retrieval_status, c.retrieval_warning, c.has_defect, c.defect_kind,
    c.review_status, c.review_note, c.text_original_import IS NOT NULL AS was_edited,
    c.amendment_instrument, c.amended_on, c.amendments_count, c.amend_note,
    c.meta_json`;

/** سقف طول مدخل التضمين. تجاوزُه يقصّ **مدخل المتجه وحده** ولا يقسم المقطع. */
const EMBED_MAX_CHARS = 8000;

/**
 * نصوصُ نداء التضمين الواحد.
 *
 * عشرةٌ لا عشرون: النداء يحمل حتى `AI_BATCH × EMBED_MAX_CHARS` حرفاً —
 * بثمانين ألفاً عند عشرة ومئةٍ وستين ألفاً عند عشرين — وكِبَرُ الحمولة هو ما
 * يستدعي المهلة وحدَّ المعدّل من Workers AI. والدفعة الصغيرة تخسر أقلّ حين
 * تتعثّر: عشرةُ مقاطع تُعاد لا عشرون.
 */
const AI_BATCH = 10;

/**
 * تنبيه المادة المعدَّلة التي لم يُطبَّق تعديلها.
 *
 * نصُّه مسجَّل في `naf-terms.md` تحت «تنبيهات المادة»، ويرافق النتيجة من طبقة
 * الاسترجاع لا من الواجهة: مسارُ التوليد لا يمرّ بشاشة، ونصٌّ أصليّ يصل
 * البرومبت بلا تنبيهه يُستشهد به على أنه الجاري.
 */
export const AMENDMENT_NOTICE = 'هذه المادة عُدّلت، والنص المعروض هو الأصلي — راجع نص التعديل';

/**
 * تنبيه النفاذ المؤجَّل.
 *
 * نصُّه مسجَّل في `naf-terms.md` كسابقه. ومادةٌ تاريخُ نفاذها لم يحلّ نصُّها
 * سابقٌ لأوانه: الاستشهاد به اليوم استشهادٌ بما ليس معمولاً به بعد — وهو من
 * جنس الخطأ الأول، فيرافق النتيجةَ حيث رافقه.
 */
export const DEFERRED_NOTICE = 'هذه المادة نافذة من تاريخٍ لم يحل بعد — راجع تاريخ النفاذ قبل الاستشهاد';

/** ثابت دمج الرتب (RRF). القيمة المعتادة، تُهدّئ أثر الرتب الأولى. */
const RRF_K = 60;

/** إسهام مطابقة رقم المادة — بقدر إسهام الرتبة الأولى في قائمةٍ واحدة. */
const ARTICLE_BOOST = 1 / RRF_K;

// ── الأنواع ──

export interface LegalHit {
  seq: number;
  id: string;
  lawId: string | null;
  parentLawId: string | null;
  docType: string | null;
  articleNo: string | null;
  /** «المادة الخامسة والأربعون» — كما تُكتب في النظام. */
  articleLabel: string | null;
  /** عنوان المادة إن وُجد: «التعريفات». */
  articleTitle: string | null;
  book: string | null;
  chapter: string | null;
  section: string | null;
  /** نوع أداة الإصدار: مرسوم ملكي، قرار مجلس الوزراء… */
  instrument: string | null;
  instrumentNo: string | null;
  authority: string | null;
  lawTitle: string | null;
  status: string;
  isRepealed: boolean;
  issueDate: string | null;
  issueDateHijri: string | null;
  effectiveFrom: string | null;
  effectiveFromHijri: string | null;
  /** نفاذٌ مؤجَّل: تاريخ النفاذ لم يحلّ بعد، فالنصّ سابقٌ لأوانه. */
  effectivePending: boolean;
  effectiveTo: string | null;
  sourceUrl: string | null;
  /** النصّ كما ورد — هو ما يُعرض ويُستشهد به. */
  text: string;
  /** جزء المادة المقسّمة: `a` · `b`. أجزاءُ مادةٍ واحدة لا موادّ. */
  part: string | null;
  partsTotal: number | null;
  /** مادةٌ أخرى تحمل رقم مادةٍ قائمة — مستقلّة لا نسخة. */
  isDuplicate: boolean;
  /** المعرّف المشترك بين المواد التي تحمل الرقم نفسه. */
  duplicateOf: string | null;
  duplicateIndex: number | null;
  hasAmendments: boolean;
  amendmentKind: string | null;
  /** هل `text` نافذ؟ إن كان `false` فالنصّ أصليّ رغم وجود تعديل. */
  amendmentApplied: boolean;
  needsReview: boolean;
  /** حالُ الاسترجاع كما يقرؤه القارئ: نافذ · نافذ بتحذير · ملغى. */
  retrievalStatus: string;
  /** نصّ التحذير جاهزاً للعرض — يرافق النتيجة من طبقة الاسترجاع لا من الشاشة. */
  retrievalWarning: string | null;
  /** عطبٌ يمنع القراءة — يحجب حتى يبتّ فيه إنسان. */
  hasDefect: boolean;
  defectKind: string | null;
  /** وقت قرار المراجع البشري. */
  reviewedAt: number | null;
  /** `pending` · `approved` · `edited` · `rejected` · `deferred`. */
  reviewStatus: string;
  reviewNote: string | null;
  /** حُرِّر نصُّها، فأصلُ الاستيراد محفوظ ويمكن الرجوع إليه. */
  wasEdited: boolean;
  amendmentInstrument: string | null;
  amendedOn: string | null;
  amendmentsCount: number | null;
  amendNote: string | null;
  meta: Record<string, unknown> | null;
  score: number;
  /** الإشارات التي رشّحت هذه النتيجة: دلالي، لفظي، مطابقة رقم مادة. */
  signals: string[];
}

export interface PreparedChunk {
  id: string;
  law_id: string | null;
  parent_law_id: string | null;
  doc_type: string | null;
  article_no: string | null;
  article_no_norm: string | null;
  article_label: string | null;
  article_title: string | null;
  book: string | null;
  chapter: string | null;
  section: string | null;
  status: string;
  is_repealed: number;
  law_title: string | null;
  instrument: string | null;
  instrument_no: string | null;
  authority: string | null;
  captured_at: string | null;
  issue_date: string | null;
  issue_date_hijri: string | null;
  effective_from: string | null;
  effective_from_hijri: string | null;
  effective_to: string | null;
  source_url: string | null;
  text: string;
  /** النصّ السابق قبل التعديل — للأرشيف لا للعرض. */
  text_superseded: string | null;
  part: string | null;
  parts_total: number | null;
  is_duplicate: number;
  duplicate_of: string | null;
  duplicate_index: number | null;
  has_amendments: number;
  amendment_kind: string | null;
  /** نوع التعديل مطبَّعاً — عليه تقوم طوابير التصنيف. */
  amendment_kind_norm: string | null;
  amendment_applied: number;
  needs_review: number;
  amendment_instrument: string | null;
  amended_on: string | null;
  amendments_count: number | null;
  amendments_raw: string | null;
  amend_note: string | null;
  /** حالُ الاسترجاع — الحقل الذي يُبنى عليه قرار الحجب وحده. */
  retrieval_status: string;
  retrieval_warning: string | null;
  /** الخطّ الزمني نصّاً — نسخٌ تاريخية لا تُفهرَس ولا تُصفّى. */
  text_versions: string;
  /** سجلّ التعديلات مفكَّكاً، نصّاً. `null` إن لم يرد. */
  amendment_events: string | null;
  /** عطبٌ يمنع القراءة — يحجب حتى يبتّ فيه إنسان. */
  has_defect: number;
  defect_kind: string | null;
  embed_text: string;
  text_norm: string;
  /** الباب مطبَّعاً — للترشيح به. */
  book_norm: string | null;
  handle_norm: string;
  meta_json: string | null;
  embed_hash: string;
  /** بُني `embed_text` هنا لأنه غاب عن السطر وطُلب بناؤه صراحةً. */
  built_embed_text: boolean;
}

/** خيارات الاستيراد — كلُّها معطَّلة افتراضياً، ولا يُفعِّلها إلا طلبٌ صريح. */
export interface ImportOptions {
  /**
   * يبني `embed_text` من اسم النظام ورقم المادة ونصّها حين يغيب عن السطر.
   *
   * لملفٍّ أُعِدّ للعرض لا للاسترجاع: فيه النصّ ولا نصَّ تضمينٍ فيه. والبناء
   * يركّب ما يطلبه العقد ولا يُحوّل `text` مجرَّداً، ويُعَدّ ويُقال في التقرير
   * فلا يقع شيء صامتاً.
   */
  buildEmbedText?: boolean;
}

export interface LineError {
  line: number;
  /** رمزٌ ثابت للسبب — عليه يقوم التجميع، لا على نصّ الرسالة. */
  code: string;
  error: string;
  id?: string;
  /** الحقول التي حملها السطر فعلاً — بها يُعرَف الناقص بلا تخمين. */
  keys?: string[];
}

/**
 * سببٌ واحد مجموعاً عبر الملف كلّه.
 *
 * ملفٌّ مولَّد بقالبٍ واحد تفشل أسطرُه بالسبب نفسه: مئةُ رسالة متطابقة لا
 * تقول أكثر مما تقوله واحدة، والعدد المخفيّ بعد سقف العرض يُخفي الحقيقة
 * كلَّها. فيُجمع السبب مرّة، ويُعدّ، وتُذكر أمثلةٌ من أسطره.
 */
export interface ErrorGroup {
  code: string;
  error: string;
  count: number;
  /** أمثلة من أرقام الأسطر — لا كلّها. */
  lines: number[];
  /** الحقول التي وردت في هذه الأسطر — لتظهر أيّها ناقص. */
  keys?: string[];
}

export interface ParsedJsonl {
  /** عدد الأسطر غير الفارغة التي وصلت. */
  total: number;
  rows: PreparedChunk[];
  errors: LineError[];
  warnings: string[];
  /** أسطر تجاوز `embed_text` فيها سقف المتجه فقُصَّ مدخله (ولم يُقسَّم المقطع). */
  longEmbedText: number;
  /** أسطر بُني `embed_text` لها لغيابه — بطلبٍ صريح، وتُعَدّ لتُقال. */
  builtEmbedText: number;
  /** موادّ ستُحجب عن الاسترجاع حتى تُراجَع بشرياً. */
  needsReview: number;
  /** موادّ عُدِّلت ونصُّها المعروض أصليّ — تُعرض مع تنبيهها. */
  amendmentPending: number;
  /** موادّ حملت نصّاً سابقاً يدخل سجلّ التحديث بتاريخ تعديله. */
  superseded: number;
}

/** خطأ تحقّقٍ برمزه. الرمز ثابت والرسالة قد تُصاغ من جديد. */
class ChunkError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const SAMPLE_LINES = 5;
/**
 * سقف الحقول المذكورة في التشخيص.
 *
 * كان أربعة عشر فقطع قائمةَ حقولٍ عدّتها أربعة عشر تماماً، فخفي ما بعدها —
 * وهو بالضبط ما يبحث عنه القارئ: أفيه `text` و`embed_text` أم لا. والسقف
 * على عددٍ لا يبلغه سطرٌ حقيقي أنفعُ من سقفٍ يقصّ أوّل ملفٍ يُجرَّب.
 */
const SAMPLE_KEYS = 40;

/** يجمع أخطاء الأسطر بأسبابها. لا سقف على العدّ — السقف على العرض وحده. */
export function summarizeErrors(errors: LineError[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  for (const e of errors) {
    const existing = groups.get(e.code);
    if (existing) {
      existing.count++;
      if (existing.lines.length < SAMPLE_LINES) existing.lines.push(e.line);
      if (e.keys?.length) {
        const merged = new Set([...(existing.keys ?? []), ...e.keys]);
        existing.keys = Array.from(merged).slice(0, SAMPLE_KEYS);
      }
    } else {
      groups.set(e.code, {
        code: e.code,
        error: e.error,
        count: 1,
        lines: [e.line],
        keys: e.keys?.length ? e.keys.slice(0, SAMPLE_KEYS) : undefined,
      });
    }
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count);
}

// ── ١) الاستيراد ──

/**
 * يقرأ ملف JSONL ويحوّله إلى صفوف جاهزة للكتابة.
 *
 * سطرٌ = مقطع. لا يُقسَّم سطر ولا يُدمج سطران مهما طالا أو قصرا.
 */
export function parseJsonl(input: ArrayBuffer | Uint8Array | string, opts: ImportOptions = {}): ParsedJsonl {
  const warnings: string[] = [];
  let content: string;

  if (typeof input === 'string') {
    content = input;
  } else {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    // BOM: العقد يشترط UTF-8 بلا BOM. نُسقطه ونقولها في التقرير بدل أن
    // نفشل الملف كلّه — وبدل أن نسكت فيصير أوّل `id` مسبوقاً بحرف خفيّ
    // لا يُرى، فيُنشئ نسخة ثانية من المادة عند كل استيراد.
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      warnings.push('الملف يبدأ بعلامة BOM — أُسقطت. العقد يشترط UTF-8 بلا BOM.');
    }
    content = new TextDecoder('utf-8').decode(bytes);
  }
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

  const rows: PreparedChunk[] = [];
  const errors: LineError[] = [];
  const seen = new Map<string, number>();
  let total = 0;
  let longEmbedText = 0;
  let builtEmbedText = 0;
  let needsReview = 0;
  let amendmentPending = 0;
  let superseded = 0;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, '').trim();
    if (!raw) continue;
    total++;
    const lineNo = i + 1;

    if (total === 1 && raw.startsWith('[')) {
      errors.push({
        line: lineNo,
        code: 'json_array',
        error: 'الملف مصفوفة JSON لا JSONL — المطلوب سطر مستقل لكل مادة',
      });
      break;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e: any) {
      errors.push({ line: lineNo, code: 'bad_json', error: `سطر غير صالح كـJSON: ${String(e?.message ?? e)}` });
      continue;
    }

    try {
      const row = prepareChunk(parsed, opts);
      const previous = seen.get(row.id);
      if (previous) {
        // مكرّر داخل الملف نفسه: الـ upsert سيُبقي الأخير ويُسقط الأول بصمت،
        // وهو غالباً خطأ في التوليد لا قصداً — فيُقال.
        errors.push({
          line: lineNo,
          code: 'duplicate_id',
          error: `المعرّف مكرّر في الملف نفسه (وردَ في السطر ${previous})`,
          id: row.id,
        });
        continue;
      }
      seen.set(row.id, lineNo);
      if (row.embed_text.length > EMBED_MAX_CHARS) longEmbedText++;
      if (row.built_embed_text) builtEmbedText++;
      // يُعَدّ ما سيُحجب وما سيُعرض بتنبيه: ملفٌّ نصفُ مواده محجوب يبدو
      // مستورَداً تامّاً في العمود، ثم لا يجد المحامي أثرَه في البحث.
      if (row.needs_review) needsReview++;
      if (row.has_amendments && !row.amendment_applied) amendmentPending++;
      if (row.text_superseded) superseded++;
      rows.push(row);
    } catch (e: any) {
      // حقول السطر تُرافق الخطأ: ملفٌّ مولَّد بقالب واحد تفشل أسطره كلّها
      // بالسبب نفسه، ورؤية ما حمله السطر فعلاً تُري الناقصَ بلا تخمين.
      errors.push({
        line: lineNo,
        code: e instanceof ChunkError ? e.code : 'invalid_line',
        error: String(e?.message ?? e),
        keys: topLevelKeys(parsed),
      });
    }
  }

  return { total, rows, errors, warnings, longEmbedText, builtEmbedText, needsReview, amendmentPending, superseded };
}

const MAX_ID_LEN = 200;
const MAX_TEXT_LEN = 200_000;

/** يتحقّق من سطر واحد ويحسب حقوله المشتقّة. يرمي رسالةً عربية عند الخطأ. */
export function prepareChunk(raw: unknown, opts: ImportOptions = {}): PreparedChunk {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ChunkError('not_object', 'السطر ليس كائن JSON');
  }
  const o = raw as Record<string, unknown>;

  const id = str(o.id);
  if (!id) throw new ChunkError('missing_id', '`id` مطلوب — وهو المفتاح الأساسي الذي يقوم عليه الاستبدال');
  if (id.length > MAX_ID_LEN) throw new ChunkError('long_id', `\`id\` أطول من ${MAX_ID_LEN} حرفاً`);

  const text = str(o.text);
  if (!text) throw new ChunkError('missing_text', '`text` مطلوب — وهو ما يُعرض ويُستشهد به');
  if (text.length > MAX_TEXT_LEN) throw new ChunkError('long_text', '`text` أطول من الحدّ المسموح');

  const articleNo = str(o.article_no) || null;
  const lawTitle = str(o.law_title) || str(o.law_name) || str(o.title) || null;

  let embedText = str(o.embed_text);
  let builtEmbedText = false;
  if (!embedText) {
    // لا رجوع صامتاً إلى `text`: ذاك هو الخلط الذي يمنعه العقد، ونتيجته
    // استرجاعٌ ضعيف لا يظهر أثره إلا في جودة الإجابات.
    //
    // والبناء الصريح شيء آخر: يركّب نصَّ التضمين الذي يطلبه العقد — اسم
    // النظام ورقم المادة ثم النصّ — ولا يُحوّل `text` مجرَّداً. ولا يقع إلا
    // بطلبٍ صريح، ويُعَدّ ويُقال في التقرير.
    if (!opts.buildEmbedText) {
      throw new ChunkError('missing_embed_text', '`embed_text` مطلوب — وهو وحده ما يُحوَّل إلى متجه');
    }
    const head = [lawTitle, articleNo ? `المادة ${articleNo}` : ''].filter(Boolean).join(' — ');
    embedText = head ? `${head}\n${text}` : text;
    builtEmbedText = true;
  }
  if (embedText.length > MAX_TEXT_LEN) throw new ChunkError('long_embed_text', '`embed_text` أطول من الحدّ المسموح');

  const rawStatus = str(o.status);
  const status = !rawStatus
    ? 'active'
    : VALID_STATUSES.has(rawStatus)
      ? rawStatus
      : (STATUS_ALIASES.get(normalizeArabic(rawStatus)) ?? '');
  if (!status) {
    throw new ChunkError('bad_status', `\`status\` غير معروف: ${rawStatus} — المسموح: active | amended | repealed`);
  }

  // منسوخٌ إن قال أيُّهما ذلك. لا يُصحَّح أحدهما بالآخر: التصفية تأخذ
  // بالاثنين، وتغيير قيمة وردت في الملف اختلاقٌ لبيانات لم تُرسَل.
  const isRepealed = status === 'repealed' || truthy(o.is_repealed) ? 1 : 0;

  const lawId = str(o.law_id) || null;
  const rawDocType = str(o.doc_type);
  // النوع يُقابَل كما تُقابَل الحالة: «نظام» و`law` معنىً واحد، وتركُهما
  // لغتين في عمودٍ واحد يجعل مرشّح النوع يعرض قيمتين له.
  const docType = rawDocType ? (canonicalDocType(rawDocType) ?? rawDocType) : null;
  const instrumentNo = str(o.instrument_no) || null;

  const issue = parseDate(o.issue_date ?? o.issue_date_g ?? o.date_gregorian, 'issue_date');
  // النفاذ المؤجَّل يأتي هجرياً كما يأتي تاريخ التعديل، فيُحفظ هجرياً ولا
  // يُرمى: حقلٌ يُقرأ عند العرض ليُعلم أن النصّ المطبَّق سابقٌ لأوانه.
  const effective = parseDate(o.effective_from, 'effective_from');
  const effectiveTo = parseDate(o.effective_to, 'effective_to').gregorian;
  // الهجريّ الصريح أولاً، ثم ما تبيّن أنه هجريّ في حقل الميلادي.
  const issueDateHijri = str(o.issue_date_hijri) || str(o.issue_date_h) || str(o.date_hijri) || issue.hijri || null;

  const articleLabel = str(o.article_label) || null;
  const articleTitle = str(o.article_title) || null;

  // ── حقول التعديل ──
  // تُقرأ كما وردت ولا يُستنبط بعضها من بعض: التصنيف الآلي يقترح ولا يقرّر،
  // واستنباطُنا فوقه طبقةُ ظنٍّ ثانية لا يعرف قارئ التقرير أنها وقعت.
  // والافتراض في `amendment_applied` صفرٌ — أي «النصّ أصليّ» — وهو الاتجاه
  // الآمن: الامتناع عند الشكّ أسلم من تطبيقٍ خاطئ يبدو صحيحاً.
  const amendmentsRaw = str(o.amendments_raw) || null;
  const hasAmendments = truthy(o.has_amendments) ? 1 : 0;
  const amendmentApplied = truthy(o.amendment_applied) ? 1 : 0;
  const needsReview = truthy(o.needs_review) ? 1 : 0;

  // ── الخطّ الزمني وسجلّ التعديلات ──
  const textVersions = parseTextVersions(o.text_versions, text);
  const amendmentEvents = parseAmendmentEvents(o.amendment_events);

  // ── حالُ الاسترجاع ──
  // يُقرأ من الملف، فهو حقل المواصفة. وإن غاب اشتُقّ من الحقول المنطقية
  // بالقاعدة نفسها التي اشتُقّ بها هناك — وذاك سدُّ فجوةِ حقلٍ إلزاميّ غاب،
  // لا طبقةُ ظنٍّ فوق تصنيفٍ ورد.
  const rawRetrieval = str(o.retrieval_status);
  let retrievalStatus: string;
  if (!rawRetrieval) {
    retrievalStatus = isRepealed
      ? RETRIEVAL_REPEALED
      : hasAmendments && !amendmentApplied
        ? RETRIEVAL_WARNING
        : RETRIEVAL_EFFECTIVE;
  } else {
    retrievalStatus = VALID_RETRIEVAL.has(rawRetrieval)
      ? rawRetrieval
      : (RETRIEVAL_ALIASES.get(normalizeArabic(rawRetrieval)) ?? '');
    if (!retrievalStatus) {
      throw new ChunkError(
        'bad_retrieval_status',
        `\`retrieval_status\` غير معروف: ${rawRetrieval} — المسموح: نافذ | نافذ_بتحذير | ملغى`
      );
    }
  }
  // وقولُ الحقلين القديمين «منسوخ» يغلب: التصفية تأخذ بالثلاثة، وحالٌ تقول
  // «نافذ» على مادةٍ `is_repealed` تناقضٌ يُحسم في الاتجاه الآمن.
  if (isRepealed) retrievalStatus = RETRIEVAL_REPEALED;

  const retrievalWarning =
    str(o.retrieval_warning) || (retrievalStatus === RETRIEVAL_WARNING ? AMENDMENT_NOTICE : '') || null;

  // ── العطب ──
  // ثلاثةٌ تُحسب هنا لا في كل استعلام، وهي وحدها ما يحجب المادة عن البحث حتى
  // يبتّ فيها إنسان. والتحذير لا يحجب — انظر `SOUND_SQL`.
  const defect = detectDefect({
    text,
    textNorm: normalizeArabic(text),
    textSuperseded: str(o.text_superseded),
    isDuplicate: truthy(o.is_duplicate),
    needsReview: !!needsReview,
  });

  const known = new Set([
    'id', 'law_id', 'parent_law_id', 'doc_type', 'article_no', 'status', 'is_repealed',
    'law_title', 'law_name', 'title', 'instrument', 'instrument_no', 'authority',
    'captured_at', 'issue_date', 'issue_date_g',
    'date_gregorian', 'issue_date_hijri', 'issue_date_h', 'date_hijri',
    'effective_from', 'effective_to', 'source_url', 'text', 'embed_text',
    'article_label', 'article_title', 'book', 'chapter', 'section',
    'text_superseded', 'part', 'parts_total',
    'is_duplicate', 'duplicate_of', 'duplicate_index',
    'has_amendments', 'amendment_kind', 'amendment_applied', 'needs_review',
    'amendment_instrument', 'amended_on', 'amendments_count', 'amendments_raw', 'amend_note',
    'retrieval_status', 'retrieval_warning', 'text_versions', 'amendment_events',
  ]);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!known.has(k)) extra[k] = v;

  // مقبض المادة: ما يكتبه من يبحث عنها بعينها — اسم النظام ورقمها ورقم أداتها.
  // يُفهرس لفظياً لأن رقم المادة قد لا يرد داخل نصّها أصلاً.
  //
  // ومعها لفظُ الرقم وعنوانُ المادة: «المادة الخامسة والأربعون» هو ما يكتبه
  // من يقرأ النظام في مصدره، و«التعريفات» عنوانٌ يُبحث به ولا يرد في المتن.
  const handle = [
    lawTitle, lawId, docType, articleNo ? `المادة ${articleNo}` : '', articleLabel, articleTitle, instrumentNo,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    id,
    law_id: lawId,
    parent_law_id: str(o.parent_law_id) || null,
    doc_type: docType,
    article_no: articleNo,
    article_no_norm: normalizeArticleNo(articleNo),
    article_label: articleLabel,
    article_title: articleTitle,
    book: str(o.book) || null,
    chapter: str(o.chapter) || null,
    section: str(o.section) || null,
    status,
    is_repealed: isRepealed,
    law_title: lawTitle,
    instrument: str(o.instrument) || null,
    instrument_no: instrumentNo,
    authority: str(o.authority) || null,
    captured_at: str(o.captured_at) || null,
    issue_date: issue.gregorian,
    issue_date_hijri: issueDateHijri,
    effective_from: effective.gregorian,
    effective_from_hijri: effective.hijri,
    effective_to: effectiveTo,
    source_url: str(o.source_url) || null,
    text,
    text_superseded: str(o.text_superseded) || null,
    part: str(o.part) || null,
    parts_total: num(o.parts_total),
    is_duplicate: truthy(o.is_duplicate) ? 1 : 0,
    duplicate_of: str(o.duplicate_of) || null,
    duplicate_index: num(o.duplicate_index),
    has_amendments: hasAmendments,
    amendment_kind: str(o.amendment_kind) || null,
    amendment_kind_norm: normalizeArabic(str(o.amendment_kind)) || null,
    amendment_applied: amendmentApplied,
    needs_review: needsReview,
    amendment_instrument: str(o.amendment_instrument) || null,
    amended_on: str(o.amended_on) || null,
    amendments_count: num(o.amendments_count),
    amendments_raw: amendmentsRaw,
    amend_note: str(o.amend_note) || null,
    retrieval_status: retrievalStatus,
    retrieval_warning: retrievalWarning,
    // المصفوفتان تُخزَّنان نصّاً: قراءتُهما عند فتح المادة وحدها، ولا يُصفَّى
    // بهما ولا يُرتَّب — فجدولٌ مستقلّ لكلٍّ ثمنٌ بلا مقابل.
    text_versions: JSON.stringify(textVersions),
    amendment_events: amendmentEvents.length ? JSON.stringify(amendmentEvents) : null,
    has_defect: defect.has,
    defect_kind: defect.kind,
    embed_text: embedText,
    text_norm: normalizeArabic(text),
    book_norm: normalizeArabic(str(o.book)) || null,
    handle_norm: normalizeArabic(handle),
    meta_json: Object.keys(extra).length ? JSON.stringify(extra) : null,
    embed_hash: hashText(embedText),
    built_embed_text: builtEmbedText,
  };
}

function str(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  return '';
}

/** نوع الأداة كما يُخزَّن، أو `null` إن لم يُعرف اللفظ. */
export function canonicalDocType(v: string): string | null {
  const raw = v.trim();
  if (!raw) return null;
  if (DOC_TYPES[raw]) return raw;
  return DOC_TYPE_ALIASES.get(normalizeArabic(raw)) ?? null;
}

/** نسخةٌ في الخطّ الزمني كما وردت في الملف. */
export interface TextVersion {
  seq: number;
  text: string;
  label: string | null;
  from_instrument: string | null;
  from_date: string | null;
  current: boolean;
}

/**
 * الخطّ الزمني — بقيوده الملزمة.
 *
 * قيدان تقولهما المواصفة نصّاً، ويُفحصان هنا لا يُفترضان: العنصر `current`
 * واحدٌ لا غير، ونصُّه **مطابقٌ حرفياً** لحقل `text`. وخرقُ أيّهما يُسقط
 * السطر برمزه — لأنّ خطّاً زمنياً يقول إن النافذ غير المعروض يجعل نافذة
 * التاريخ تكذّب البطاقة، وهي أسوأ من غياب النافذة أصلاً.
 *
 * والغياب مقبول: من لا تعديل له تُبنى له نسخةٌ واحدة من نصّه.
 */
function parseTextVersions(v: unknown, text: string): TextVersion[] {
  if (v == null || v === '') {
    return [{ seq: 0, text, label: null, from_instrument: null, from_date: null, current: true }];
  }
  if (!Array.isArray(v)) throw new ChunkError('bad_text_versions', '`text_versions` ليست مصفوفة');
  if (!v.length) {
    return [{ seq: 0, text, label: null, from_instrument: null, from_date: null, current: true }];
  }

  const out: TextVersion[] = v.map((raw, i) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const vText = str(o.text);
    if (!vText) throw new ChunkError('bad_text_versions', `نسخةٌ بلا نصّ في \`text_versions\` (${i})`);
    return {
      seq: num(o.seq) ?? i,
      text: vText,
      label: str(o.label) || null,
      from_instrument: str(o.from_instrument) || null,
      from_date: str(o.from_date) || null,
      current: truthy(o.current),
    };
  });

  const current = out.filter((x) => x.current);
  if (current.length !== 1) {
    throw new ChunkError(
      'bad_text_versions',
      `\`text_versions\` بها ${current.length} نسخة معتمدة — والمطلوب واحدة`
    );
  }
  if (current[0].text.trim() !== text.trim()) {
    throw new ChunkError(
      'bad_text_versions',
      'النسخة المعتمدة في `text_versions` تخالف `text` — ولا يصحّ خطٌّ زمنيّ يكذّب النصّ المعروض'
    );
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** حدثُ تعديلٍ مفكَّك كما ورد في الملف. */
export interface AmendmentEvent {
  seq: number;
  scope: string | null;
  op: string | null;
  targets: string[];
  instrument: string | null;
  instrument_no: string | null;
  date_hijri: string | null;
  effective_from: string | null;
  new_text: string | null;
  applied: boolean;
  text_after: string | null;
  result: string | null;
  reason: string | null;
  raw: string | null;
}

/**
 * سجلّ التعديلات مفكَّكاً.
 *
 * يُقرأ كما ورد ولا يُصحَّح: ما تخطّاه المحرّك يبقى موسوماً `applied: false`
 * بسببه، وهو بالضبط ما يحتاج المراجع أن يراه. وحقولُه كلُّها اختيارية —
 * حدثٌ ناقصُ الوصف خيرٌ من سطرٍ مرفوض لأجله.
 */
function parseAmendmentEvents(v: unknown): AmendmentEvent[] {
  if (v == null || v === '') return [];
  if (!Array.isArray(v)) throw new ChunkError('bad_amendment_events', '`amendment_events` ليست مصفوفة');

  return v
    .map((raw, i) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      const targets = Array.isArray(o.targets) ? o.targets.map((t) => str(t)).filter(Boolean) : [];
      return {
        seq: num(o.seq) ?? i,
        scope: str(o.scope) || null,
        op: str(o.op) || null,
        targets,
        instrument: str(o.instrument) || null,
        instrument_no: str(o.instrument_no) || null,
        date_hijri: str(o.date_hijri) || null,
        effective_from: str(o.effective_from) || null,
        new_text: str(o.new_text) || null,
        applied: truthy(o.applied),
        text_after: str(o.text_after) || null,
        result: str(o.result) || null,
        reason: str(o.reason) || null,
        raw: str(o.raw) || null,
      };
    })
    .sort((a, b) => a.seq - b.seq);
}

/** علاماتُ تسرّب ديباجة البوابة إلى متن المادة. */
const PREAMBLE_MARKS = ['بموجب المرسوم', 'لتكون بالنص'].map((s) => normalizeArabic(s));

/**
 * العطب: ما يمنع قراءة المادة، لا ما ينقصها من دمج.
 *
 * ثلاثةٌ محصورة، وكلُّها في مادةٍ وسمها الملفُّ للمراجعة أصلاً — فلا نحجب
 * بحكمٍ من عندنا على مادةٍ قال مُعِدُّها إنها سليمة:
 *
 * - **رقمٌ مكرّر:** مادّتان بالرقم نفسه، وأيُّهما المقصودة قرارُ مراجع.
 * - **اقتطاع:** النصّ أقصر من نصف سابقه — تعديلٌ لا يُنقص المادة إلى النصف.
 * - **ديباجة:** صياغة أداة الإصدار تسرّبت إلى المتن، فالمعروض ليس المادة.
 */
function detectDefect(x: {
  text: string;
  textNorm: string;
  textSuperseded: string;
  isDuplicate: boolean;
  needsReview: boolean;
}): { has: 0 | 1; kind: string | null } {
  if (!x.needsReview) return { has: 0, kind: null };
  if (x.isDuplicate) return { has: 1, kind: 'رقم مكرّر' };
  if (x.textSuperseded && x.text.length * 2 < x.textSuperseded.length) {
    return { has: 1, kind: 'مشبوه الاقتطاع' };
  }
  if (PREAMBLE_MARKS.some((m) => x.textNorm.includes(m))) return { has: 1, kind: 'تسرّب ديباجة' };
  return { has: 0, kind: null };
}

function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return ['true', '1', 'yes', 'نعم'].includes(v.trim().toLowerCase());
  return false;
}

/**
 * عددٌ للعدّ والترتيب — `parts_total` و`duplicate_index` و`amendments_count`.
 *
 * وما ليس عدداً يُردّ `null` ولا يُرفض السطر لأجله: هذه حقول ترتيبٍ وعدّ،
 * وإسقاطُ نظامٍ كامل لأجل خانةٍ فيها خطأ مطبعيّ ضررٌ أكبر من غيابها.
 */
function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(normalizeArabic(String(v)));
  return Number.isFinite(n) ? n : null;
}

/**
 * سنةٌ دونها هجرية.
 *
 * لا نظام سعودي صدر قبل الألف والخمسمئة ميلادية، والسنة الهجرية اليوم دون
 * الخمسمئة والألف. فرقمٌ في هذا المدى في حقلٍ ميلاديّ خطأُ تعبئةٍ لا تاريخٌ
 * ميلاديّ — والرفض لأجله يُسقط ملفاً كاملاً على خانةٍ واحدة.
 */
const HIJRI_YEAR_CEILING = 1500;

/** تاريخٌ مقروءاً: ميلاديّ مطبَّع، أو هجريّ إن تبيّن أنه كذلك. */
interface ParsedDate {
  gregorian: string | null;
  hijri: string | null;
}

const DATE_PARTS = /^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})$/;

/**
 * علامة التقويم في آخر التاريخ: «هـ» للهجري و«م» للميلادي.
 *
 * تُكتب في المصادر الرسمية لصيقةً بالتاريخ (`1446/05/12هـ`)، والتطويل يسقط
 * بالتطبيع فتبقى «ه». وبلا هذا يُرفض التاريخ كلُّه لأجل حرفٍ واحد، فيسقط
 * السطر ومعه المادة.
 */
const CALENDAR_MARK = /\s*(هـ|ه|م)\.?$/;

/**
 * يقرأ تاريخاً كما يكتبه الناس، ويردّه بالصيغة الواحدة.
 *
 * الملفات تأتي من مصادر شتّى: `2005-09-27` و`2005/9/27` و`27/09/2005`
 * و`2005-09-27T00:00:00Z` و`٢٠٠٥-٠٩-٢٧`. وكلُّها تاريخٌ واحد، ورفضُ ملفٍ
 * لأجل شرطةٍ مكان مائلة إتعابٌ بلا مقابل: الصيغة تُقرأ ثم تُوحَّد.
 *
 * وما التبس ترتيبه (`03/04/2005`) يُقرأ يوماً فشهراً — العرف المحلي.
 */
function parseDate(v: unknown, field: string): ParsedDate {
  const raw = normalizeArabic(str(v));
  if (!raw) return { gregorian: null, hijri: null };

  // `2005-09-27T00:00:00Z` وما شابهه: التاريخ أوّله، والوقت لا يعني شيئاً هنا.
  // وعلامةُ التقويم تُقتطع وتُحفظ: «1446/05/12هـ» هجريٌّ بنصّ صاحبه لا بحدسنا
  // من سنته، و«1500م» ميلاديٌّ كذلك.
  const marked = CALENDAR_MARK.exec(raw);
  const s = raw.replace(CALENDAR_MARK, '').split(/[T\s]/)[0];
  const markedHijri = marked ? marked[1] !== 'م' : false;
  const markedGregorian = marked ? marked[1] === 'م' : false;

  const m = DATE_PARTS.exec(s);
  if (!m) {
    throw new ChunkError(
      `bad_date:${field}`,
      `\`${field}\` تاريخٌ غير مقروء: ${raw} — المقبول YYYY-MM-DD أو DD/MM/YYYY`
    );
  }

  const [, first, middle, last] = m;
  let year: number;
  let month: number;
  let day: number;
  if (first.length === 4) {
    [year, month, day] = [Number(first), Number(middle), Number(last)];
  } else if (last.length === 4) {
    [day, month, year] = [Number(first), Number(middle), Number(last)];
  } else {
    throw new ChunkError(`bad_date:${field}`, `\`${field}\` سنةٌ غير واضحة: ${raw} — اكتبها بأربعة أرقام`);
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ChunkError(`bad_date:${field}`, `\`${field}\` يومٌ أو شهرٌ خارج المدى: ${raw}`);
  }

  const pad = (n: number) => String(n).padStart(2, '0');
  if (markedHijri || (year < HIJRI_YEAR_CEILING && !markedGregorian)) {
    // هجريٌّ في حقلٍ ميلاديّ. يُحفظ هجرياً ولا يُرمى: قيمةٌ صحيحة أُسيء
    // وضعها، وإسقاطها يُفقد تاريخ الأداة النظامية كلَّه.
    return { gregorian: null, hijri: `${year}/${pad(month)}/${pad(day)}` };
  }
  return { gregorian: `${year}-${pad(month)}-${pad(day)}`, hijri: null };
}

/** أسماء حقول السطر كما وردت — مقصوصةً، فهي للتشخيص لا للتخزين. */
function topLevelKeys(parsed: unknown): string[] | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  return Object.keys(parsed as Record<string, unknown>).slice(0, SAMPLE_KEYS);
}

/** بصمة نصّ التضمين: طوله ثم FNV-1a. تكفي لمعرفة «هل تغيّر؟» ولا تُستعمل لغيرها. */
function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}-${h.toString(16)}`;
}

// ── المقارنة قبل الكتابة ──

/**
 * الحقول التي تُقارَن. غيرها بياناتُ عرضٍ لا تُنشئ نسخةً في السجلّ.
 *
 * و`amendment_applied` منها: مادةٌ كان نصُّها أصلياً فصار نافذاً تغيّر ما
 * يُستشهد به منها، وإن لم يتغيّر حرفٌ في `text` — وهو بالضبط ما يجب أن يظهر
 * في سجلّ التحديث.
 */
const COMPARED_FIELDS = [
  'text', 'article_no', 'status', 'is_repealed', 'instrument_no', 'issue_date', 'amendment_applied',
] as const;

/** صفٌّ قائم كما تحتاجه المقارنة — بلا `embed_text` كعادة كل مسار عرض. */
interface ExistingRow {
  seq: number;
  id: string;
  article_no: string | null;
  status: string;
  is_repealed: number;
  instrument_no: string | null;
  issue_date: string | null;
  issue_date_hijri: string | null;
  text: string;
  law_id: string | null;
  amendment_applied: number;
}

export interface ChunkChange {
  id: string;
  /** ما تغيّر: `text` · `article_no` · `status` … */
  fields: string[];
  old_article_no: string | null;
  new_article_no: string | null;
  old_status: string;
  new_status: string;
  old_text: string;
  new_text: string;
}

export interface ImportDiff {
  /** مواد لا وجود لها في القاعدة. */
  added: number;
  /** مواد قائمة تغيّر فيها شيء. */
  changed: number;
  /** مواد قائمة لم يتغيّر فيها شيء — لا تُؤرشَف ولا تُعاد فهرستها. */
  unchanged: number;
  /**
   * مواد قائمة في القاعدة لهذه الأنظمة ولا وجود لها في الملف.
   *
   * **تُحصى ولا تُحذف.** ملفٌّ جزئيّ يجعل كل ما سواه «غائباً»، والحذف على
   * هذا الظنّ يمحو نظاماً كاملاً. الحذف قرارُ إنسانٍ لا نتيجةُ استيراد.
   */
  missing: number;
  missing_ids: string[];
  changes: ChunkChange[];
  changes_truncated: number;
  law_ids: string[];
}

/** سقف ما يُفصَّل من التغييرات في التقرير — والعدّ فوقه كامل. */
const MAX_REPORTED_CHANGES = 100;
const MAX_REPORTED_MISSING = 50;

function differingFields(existing: ExistingRow, incoming: PreparedChunk): string[] {
  const fields: string[] = [];
  for (const f of COMPARED_FIELDS) {
    if ((existing as any)[f] !== (incoming as any)[f]) fields.push(f);
  }
  return fields;
}

async function fetchExisting(env: Env, ids: string[]): Promise<Map<string, ExistingRow>> {
  const found = new Map<string, ExistingRow>();
  for (let i = 0; i < ids.length; i += DB_BATCH) {
    const slice = ids.slice(i, i + DB_BATCH);
    const marks = slice.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT seq, id, article_no, status, is_repealed, instrument_no, issue_date, issue_date_hijri, text, law_id,
              amendment_applied
       FROM legal_chunks WHERE id IN (${marks})`
    )
      .bind(...slice)
      .all<ExistingRow>();
    for (const r of rows.results ?? []) found.set(r.id, r);
  }
  return found;
}

/**
 * يقارن ملفاً بما في القاعدة قبل أن يُكتب منه شيء.
 *
 * هذا ما يجعل إعادة رفع نظامٍ قراراً مقروءاً لا كتابةً عمياء: يُعرف كم مادة
 * ستُضاف، وكم ستتغيّر وبأيّ حقل، وكم لم تتغيّر — ثم يُعتمد أو يُترك.
 */
export async function diffChunks(env: Env, rows: PreparedChunk[]): Promise<ImportDiff> {
  const existing = await fetchExisting(env, rows.map((r) => r.id));
  const changes: ChunkChange[] = [];
  let added = 0;
  let changed = 0;
  let unchanged = 0;

  for (const row of rows) {
    const old = existing.get(row.id);
    if (!old) {
      added++;
      continue;
    }
    const fields = differingFields(old, row);
    if (!fields.length) {
      unchanged++;
      continue;
    }
    changed++;
    if (changes.length < MAX_REPORTED_CHANGES) {
      changes.push({
        id: row.id,
        fields,
        old_article_no: old.article_no,
        new_article_no: row.article_no,
        old_status: old.status,
        new_status: row.status,
        old_text: old.text,
        new_text: row.text,
      });
    }
  }

  // الغائب عن الملف: يُحسب على مستوى النظام لا الدفعة — ولذلك تُقارَن
  // الملفات كاملةً لا مقطّعة، وإلا عُدَّ سائرُ النظام غائباً.
  const lawIds = Array.from(new Set(rows.map((r) => r.law_id).filter((l): l is string => !!l)));
  const incoming = new Set(rows.map((r) => r.id));
  const missingIds: string[] = [];
  for (const lawId of lawIds) {
    const rowsOfLaw = await env.DB.prepare('SELECT id FROM legal_chunks WHERE law_id = ?')
      .bind(lawId)
      .all<{ id: string }>();
    for (const r of rowsOfLaw.results ?? []) if (!incoming.has(r.id)) missingIds.push(r.id);
  }

  return {
    added,
    changed,
    unchanged,
    missing: missingIds.length,
    missing_ids: missingIds.slice(0, MAX_REPORTED_MISSING),
    changes,
    changes_truncated: Math.max(0, changed - changes.length),
    law_ids: lawIds,
  };
}

/** ما يُبقي اعتماد المراجع قائماً: النصّ نفسه ونافذةُ تعديله نفسها. */
const REVIEW_UNCHANGED = `legal_chunks.text = excluded.text
                          AND legal_chunks.amendments_raw IS excluded.amendments_raw`;

const UPSERT_SQL = `
  INSERT INTO legal_chunks (
    id, law_id, parent_law_id, doc_type, article_no, article_no_norm,
    article_label, article_title, book, chapter, section,
    status, is_repealed, law_title, instrument, instrument_no, authority, captured_at,
    issue_date, issue_date_hijri, effective_from, effective_from_hijri, effective_to,
    source_url, text, text_superseded, part, parts_total,
    is_duplicate, duplicate_of, duplicate_index,
    has_amendments, amendment_kind, amendment_kind_norm, amendment_applied, needs_review,
    amendment_instrument, amended_on, amendments_count, amendments_raw, amend_note,
    retrieval_status, retrieval_warning, text_versions, amendment_events, has_defect, defect_kind,
    embed_text, text_norm, book_norm, handle_norm, meta_json, embed_hash, embedded_at, imported_at, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)
  ON CONFLICT(id) DO UPDATE SET
    law_id = excluded.law_id,
    parent_law_id = excluded.parent_law_id,
    doc_type = excluded.doc_type,
    article_no = excluded.article_no,
    article_no_norm = excluded.article_no_norm,
    article_label = excluded.article_label,
    article_title = excluded.article_title,
    book = excluded.book,
    chapter = excluded.chapter,
    section = excluded.section,
    status = excluded.status,
    is_repealed = excluded.is_repealed,
    law_title = excluded.law_title,
    instrument = excluded.instrument,
    instrument_no = excluded.instrument_no,
    authority = excluded.authority,
    captured_at = excluded.captured_at,
    issue_date = excluded.issue_date,
    issue_date_hijri = excluded.issue_date_hijri,
    effective_from = excluded.effective_from,
    effective_from_hijri = excluded.effective_from_hijri,
    effective_to = excluded.effective_to,
    source_url = excluded.source_url,
    text = excluded.text,
    text_superseded = excluded.text_superseded,
    part = excluded.part,
    parts_total = excluded.parts_total,
    is_duplicate = excluded.is_duplicate,
    duplicate_of = excluded.duplicate_of,
    duplicate_index = excluded.duplicate_index,
    has_amendments = excluded.has_amendments,
    amendment_kind = excluded.amendment_kind,
    amendment_kind_norm = excluded.amendment_kind_norm,
    amendment_applied = excluded.amendment_applied,
    needs_review = excluded.needs_review,
    amendment_instrument = excluded.amendment_instrument,
    amended_on = excluded.amended_on,
    amendments_count = excluded.amendments_count,
    amendments_raw = excluded.amendments_raw,
    amend_note = excluded.amend_note,
    -- حالُ الاسترجاع من الملف تغلب ما صعّده المراجع: الدفعة الجديدة أحدثُ
    -- علماً بالمصدر، والتصعيد كان على نصٍّ قد لا يكون هو هذا. وما لم يتغيّر
    -- فيه شيء يحتفظ بتصعيده — بشرط بقاء المراجعة نفسه المستعمَل أدناه.
    retrieval_status = CASE WHEN ${REVIEW_UNCHANGED} AND legal_chunks.review_status IN ('approved','edited')
                            THEN legal_chunks.retrieval_status ELSE excluded.retrieval_status END,
    retrieval_warning = CASE WHEN ${REVIEW_UNCHANGED} AND legal_chunks.review_status IN ('approved','edited')
                             THEN legal_chunks.retrieval_warning ELSE excluded.retrieval_warning END,
    text_versions = excluded.text_versions,
    amendment_events = excluded.amendment_events,
    has_defect = excluded.has_defect,
    defect_kind = excluded.defect_kind,
    embed_text = excluded.embed_text,
    text_norm = excluded.text_norm,
    book_norm = excluded.book_norm,
    handle_norm = excluded.handle_norm,
    meta_json = excluded.meta_json,
    embedded_at = CASE WHEN legal_chunks.embed_hash = excluded.embed_hash
                       THEN legal_chunks.embedded_at ELSE NULL END,
    embed_hash = excluded.embed_hash,
    -- اعتمادُ نصٍّ لم يعد هو النصّ ليس اعتماداً: يسقط بتغيّر المتن أو بتغيّر
    -- نافذة التعديلات التي قُرئت عند الاعتماد، وتعود المادة محجوبةً حتى
    -- تُراجَع من جديد.
    reviewed_at = CASE WHEN ${REVIEW_UNCHANGED} THEN legal_chunks.reviewed_at ELSE NULL END,
    reviewed_by = CASE WHEN ${REVIEW_UNCHANGED} THEN legal_chunks.reviewed_by ELSE NULL END,
    review_status = CASE WHEN ${REVIEW_UNCHANGED} THEN legal_chunks.review_status ELSE '${REVIEW_PENDING}' END,
    review_note = CASE WHEN ${REVIEW_UNCHANGED} THEN legal_chunks.review_note ELSE NULL END,
    -- أصلُ الاستيراد يسقط مع النصّ الذي كان أصلاً له: نصٌّ جديد وصل من
    -- المصدر، فالأصل هو هو لا ما حُرِّر قبله.
    text_original_import = CASE WHEN ${REVIEW_UNCHANGED} THEN legal_chunks.text_original_import ELSE NULL END,
    updated_at = excluded.updated_at`;

/** حجم دفعة الكتابة إلى D1 — دون سقف العبارات والمعاملات المربوطة بمراحل. */
const DB_BATCH = 25;

/**
 * يكتب المقاطع: **استبدال لا إضافة**.
 *
 * المفتاح `id`، فإعادة رفع نظام محدَّث تستبدل مواده. بلا هذا يصير لكل مادة
 * نسختان تتنافسان في نتائج البحث، ولا يظهر الخلل إلا كإجابةٍ تستشهد بنصّ
 * قديم بلا سبب ظاهر.
 */
export async function upsertLegalChunks(
  env: Env,
  rows: PreparedChunk[],
  opts: { importId?: string; correction?: boolean; batchId?: string } = {}
): Promise<{ inserted: number; updated: number; archived: number; superseded: number }> {
  if (!rows.length) return { inserted: 0, updated: 0, archived: 0, superseded: 0 };
  const now = Date.now();

  // معرفة الجديد من المستبدَل قبل الكتابة — ليقول التقرير أيّهما وقع.
  // وفي الطريق نفسه تُؤرشَف المواد التي تغيّر نصُّها أو رقمها أو حالتها:
  // الكتابة فوق نصٍّ نظاميّ بلا أثرٍ له تُفقد ما كان معمولاً به وقت الواقعة.
  const existing = await fetchExisting(env, rows.map((r) => r.id));
  const archivedHashes = await fetchArchivedHashes(env, rows.map((r) => r.id));

  // الصورة قبل الكتابة لا بعدها — وهي كلُّ ما يجعل التراجع ممكناً.
  if (opts.batchId) await snapshotBatch(env, opts.batchId, rows.map((r) => r.id));
  let archived = 0;
  let superseded = 0;
  const archiveStatements = [];
  for (const row of rows) {
    const old = existing.get(row.id);
    if (old) {
      const fields = differingFields(old, row);
      if (fields.length) {
        archived++;
        // بصمةُ ما أُزيح تدخل المعروف في الحال: الملف الجديد يحمل غالباً
        // النصَّ المُزاح نفسه في `text_superseded`، فبلا هذا يُكتب مرّتين —
        // مرّةً لأنه أُزيح ومرّةً لأنه ورد سابقاً.
        archivedHashes.get(row.id)?.add(hashText(old.text));
        archiveStatements.push(
          archiveVersion(env, {
            chunkId: old.id,
            lawId: old.law_id,
            articleNo: old.article_no,
            status: old.status,
            isRepealed: old.is_repealed,
            instrumentNo: old.instrument_no,
            issueDate: old.issue_date,
            issueDateHijri: old.issue_date_hijri,
            text: old.text,
            changedFields: fields.join(','),
            // التاريخ من `amended_on` لا من وقت الاستيراد، والنسبة إلى أداة
            // التعديل: المادة عُدِّلت بمرسومها في تاريخه، وإنما استوردناه
            // اليوم. ووسمُ «تصحيح بيانات» يغلب حين يقول رافعُ الملف إن الفرق
            // خطأُ سحبٍ سابق لا تعديلٌ نظاميّ وقع.
            amendedOn: row.amended_on,
            amendmentInstrument: row.amendment_instrument,
            changeKind: opts.correction
              ? 'correction'
              : row.amended_on || row.amendment_instrument
                ? 'amendment'
                : null,
            origin: 'displaced',
            importId: opts.importId ?? null,
            at: now,
          })
        );
      }
    }

    // النصّ السابق الوارد في الملف نفسه.
    //
    // بعد مسح القاعدة وإعادة الرفع أساساً جديداً لا يبقى في القاعدة نصٌّ قديم
    // يُزيحه الاستيراد، فيصير سجلّ التحديث فارغاً بينما تاريخ التعديل في
    // الملف كاملاً. فيُبذر منه: نسخةٌ واحدة لكل نصٍّ سابق، تُعرف ببصمته فلا
    // تتكرّر مهما أُعيد رفع الملف.
    if (row.text_superseded) {
      const hash = hashText(row.text_superseded);
      const seen = archivedHashes.get(row.id) ?? new Set<string>();
      archivedHashes.set(row.id, seen);
      if (!seen.has(hash)) {
        superseded++;
        seen.add(hash);
        archiveStatements.push(
          archiveVersion(env, {
            chunkId: row.id,
            lawId: row.law_id,
            articleNo: row.article_no,
            status: row.status,
            isRepealed: row.is_repealed,
            instrumentNo: row.instrument_no,
            issueDate: row.issue_date,
            issueDateHijri: row.issue_date_hijri,
            text: row.text_superseded,
            changedFields: 'text',
            amendedOn: row.amended_on,
            amendmentInstrument: row.amendment_instrument,
            // نصٌّ سابق في الملف تعديلٌ نظاميّ وقع بمرسومه، ولو جاء في دفعة
            // موسومة «تصحيح بيانات»: الوسم يصف سبب تغيّر نسختنا، لا ما جرى
            // على النظام.
            changeKind: 'amendment',
            origin: 'superseded',
            importId: opts.importId ?? null,
            at: now,
          })
        );
      }
    }
  }
  for (let i = 0; i < archiveStatements.length; i += DB_BATCH) {
    await env.DB.batch(archiveStatements.slice(i, i + DB_BATCH));
  }
  const updated = rows.filter((r) => existing.has(r.id)).length;

  for (let i = 0; i < rows.length; i += DB_BATCH) {
    const slice = rows.slice(i, i + DB_BATCH);
    await env.DB.batch(
      slice.map((r) =>
        env.DB.prepare(UPSERT_SQL).bind(
          r.id, r.law_id, r.parent_law_id, r.doc_type, r.article_no, r.article_no_norm,
          r.article_label, r.article_title, r.book, r.chapter, r.section,
          r.status, r.is_repealed, r.law_title, r.instrument, r.instrument_no, r.authority, r.captured_at,
          r.issue_date, r.issue_date_hijri, r.effective_from, r.effective_from_hijri, r.effective_to,
          r.source_url, r.text, r.text_superseded, r.part, r.parts_total,
          r.is_duplicate, r.duplicate_of, r.duplicate_index,
          r.has_amendments, r.amendment_kind, r.amendment_kind_norm, r.amendment_applied, r.needs_review,
          r.amendment_instrument, r.amended_on, r.amendments_count, r.amendments_raw, r.amend_note,
          r.retrieval_status, r.retrieval_warning, r.text_versions, r.amendment_events,
          r.has_defect, r.defect_kind,
          r.embed_text, r.text_norm, r.book_norm, r.handle_norm, r.meta_json, r.embed_hash, now, now
        )
      )
    );
  }

  // معرّفات الدفعة تُقيَّد جزءاً بعد جزء. الملف يُرفع مقسَّماً، فبلا هذا لا
  // تُعرف الدفعة التامّة عند الختام — ويصير حذف اليتيم حذفَ ما خرج عن نافذة
  // الخمسمئة سطر الأخيرة، وهو محوُ نظامٍ لا تنظيفُ أثر.
  if (opts.batchId) {
    const at = Date.now();
    for (let i = 0; i < rows.length; i += DB_BATCH) {
      await env.DB.batch(
        rows.slice(i, i + DB_BATCH).map((r) =>
          env.DB.prepare(
            `INSERT INTO legal_batch_ids (batch_id, chunk_id, law_id, at) VALUES (?,?,?,?)
             ON CONFLICT(batch_id, chunk_id) DO NOTHING`
          ).bind(opts.batchId, r.id, r.law_id, at)
        )
      );
    }
  }

  return { inserted: rows.length - updated, updated, archived, superseded };
}

/**
 * كم دفعةً تُحفظ صورُها.
 *
 * ثلاثٌ لا أكثر: تخزينٌ بلا حدٍّ ثمنٌ بلا مقابل، ومن أراد ما هو أقدم فمصدرُه
 * النسخة الاحتياطية. والثلاث تكفي لما تُبنى له الاستعادة أصلاً — دفعةٌ رُفعت
 * وتبيّن عطبُها قبل أن تليها دفعتان.
 */
export const SNAPSHOT_KEEP = 3;

/**
 * صورةُ الصفوف قبل أن تكتب الدفعة فوقها.
 *
 * الصفُّ كاملاً نصّاً واحداً — لا أعمدةً مفكَّكة: عمودٌ لكل حقل يعني هجرةً
 * جديدة مع كل حقلٍ يُضاف إلى المخطط، وهذا ما يجعل الاستعادة تشيخ صامتةً
 * فتردّ مادةً ناقصةَ الحقول التي وُلدت بعدها.
 *
 * وما لا صورة له في الدفعة مادةٌ **أدرجتها** الدفعة — تُعرف بغياب صفِّها،
 * ولا تحتاج علامةً ثانية.
 */
async function snapshotBatch(env: Env, batchId: string, ids: string[]): Promise<number> {
  const at = Date.now();
  let taken = 0;
  for (let i = 0; i < ids.length; i += DB_BATCH) {
    const slice = ids.slice(i, i + DB_BATCH);
    const marks = slice.map(() => '?').join(',');
    const rows = await env.DB.prepare(`SELECT * FROM legal_chunks WHERE id IN (${marks})`)
      .bind(...slice)
      .all<Record<string, unknown>>();
    const found = rows.results ?? [];
    if (!found.length) continue;
    await env.DB.batch(
      found.map((r) =>
        env.DB.prepare(
          `INSERT INTO legal_snapshots (batch_id, chunk_id, law_id, row_json, at) VALUES (?,?,?,?,?)
           ON CONFLICT(batch_id, chunk_id) DO NOTHING`
        ).bind(batchId, String(r.id), (r.law_id as string) ?? null, JSON.stringify(r), at)
      )
    );
    taken += found.length;
  }
  await pruneSnapshots(env);
  return taken;
}

/**
 * يُبقي صور أحدث الدفعات ويُسقط ما قبلها.
 *
 * والترتيب بالوقت ثم بترتيب الكتابة: دفعتان في المللي ثانية نفسها — وذلك يقع
 * في الفحص وفي رفعٍ آليّ متتابع — تتساويان في `at`، فلولا `rowid` لَسقطت
 * إحداهما بالقرعة. والأحدثُ كتابةً هي الأحدث وقوعاً.
 */
async function pruneSnapshots(env: Env, keep = SNAPSHOT_KEEP): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM legal_snapshots WHERE batch_id NOT IN (
       SELECT batch_id FROM legal_snapshots
       GROUP BY batch_id ORDER BY MAX(at) DESC, MAX(rowid) DESC LIMIT ?
     )`
  )
    .bind(keep)
    .run();
}

/** دفعةٌ يمكن التراجع عنها، وما تمسّه من أنظمة. */
export interface RevertableBatch {
  batch_id: string;
  filename: string | null;
  file_sha256: string | null;
  created_at: number;
  reverted_at: number | null;
  laws: { law_id: string | null; law_title: string | null; updated: number; inserted: number }[];
}

/**
 * الدفعات التي بقيت صورُها — وما مسّته كلٌّ من أنظمة.
 *
 * والعدّان مفصولان لأن أثرهما في التراجع مختلف: المحدَّث يُردّ إلى صورته،
 * والمُدرَج يُحذف. ومن يرى «٣٠٠ محدَّثة و٤ مُدرَجة» يعرف ما سيقع قبل أن يقع.
 */
export async function listRevertableBatches(env: Env): Promise<RevertableBatch[]> {
  const batches = await env.DB.prepare(
    `SELECT s.batch_id,
            MAX(i.filename) AS filename, MAX(i.file_sha256) AS file_sha256,
            MIN(s.at) AS created_at, MAX(i.reverted_at) AS reverted_at
     FROM legal_snapshots s LEFT JOIN legal_imports i ON i.batch_id = s.batch_id
     GROUP BY s.batch_id ORDER BY created_at DESC, MIN(s.rowid) DESC`
  ).all<{
    batch_id: string; filename: string | null; file_sha256: string | null;
    created_at: number; reverted_at: number | null;
  }>();

  const out: RevertableBatch[] = [];
  for (const b of batches.results ?? []) {
    const laws = await env.DB.prepare(
      `SELECT b.law_id,
              MAX(c.law_title) AS law_title,
              SUM(CASE WHEN s.chunk_id IS NOT NULL THEN 1 ELSE 0 END) AS updated,
              SUM(CASE WHEN s.chunk_id IS NULL THEN 1 ELSE 0 END) AS inserted
       FROM legal_batch_ids b
       LEFT JOIN legal_snapshots s ON s.batch_id = b.batch_id AND s.chunk_id = b.chunk_id
       LEFT JOIN legal_chunks c ON c.id = b.chunk_id
       WHERE b.batch_id = ?
       GROUP BY b.law_id ORDER BY b.law_id`
    )
      .bind(b.batch_id)
      .all<{ law_id: string | null; law_title: string | null; updated: number; inserted: number }>();
    out.push({ ...b, laws: laws.results ?? [] });
  }
  return out;
}

export interface RevertPlan {
  batch_id: string;
  law_id: string;
  /** يُردّ إلى صورته قبل الدفعة. */
  restore: string[];
  /** أدرجته الدفعة، فيُحذف بردّها. */
  remove: string[];
  /** قرارُ مراجعةٍ وقع بعد الدفعة على مادةٍ ستُردّ — يسقط معها. */
  review_lost: { id: string; review_status: string; reviewed_at: number | null }[];
}

/**
 * ما سيقع لو رُدَّت الدفعة في نطاق نظام — يُعرض قبل أن يقع.
 *
 * **والنطاق نظامٌ واحد لا الدفعة كلَّها.** «أعِد نظام العمل إلى ما كان» جملةٌ
 * تُقرأ وتُفهم ويُقدَّر أثرها، و«أعِد الدفعة» تمسّ ما لا يعلمه صاحب القرار.
 *
 * و`review_lost` يُحصى ويُعرض لأنه أخطر ما في الباب: الصورة تحمل حالَ المراجعة
 * كما كانت قبل الدفعة، فردُّها يردّ معها قراراتٍ وقعت بعدها. وذلك صحيحٌ
 * منطقاً — الصفُّ يعود إلى لحظةٍ بعينها — وخطيرٌ إن وقع صامتاً: عملُ مراجعٍ
 * يُمحى ولا يعلم أنه مُحي.
 */
export async function planRevert(env: Env, batchId: string, lawId: string): Promise<RevertPlan> {
  const rows = await env.DB.prepare(
    `SELECT b.chunk_id, s.chunk_id IS NOT NULL AS has_snapshot,
            c.review_status, c.reviewed_at
     FROM legal_batch_ids b
     LEFT JOIN legal_snapshots s ON s.batch_id = b.batch_id AND s.chunk_id = b.chunk_id
     LEFT JOIN legal_chunks c ON c.id = b.chunk_id
     WHERE b.batch_id = ? AND b.law_id = ?
     ORDER BY b.chunk_id`
  )
    .bind(batchId, lawId)
    .all<{ chunk_id: string; has_snapshot: number; review_status: string | null; reviewed_at: number | null }>();

  const batchAt = await env.DB.prepare('SELECT MIN(at) AS at FROM legal_snapshots WHERE batch_id = ?')
    .bind(batchId)
    .first<{ at: number | null }>();

  const restore: string[] = [];
  const remove: string[] = [];
  const review_lost: RevertPlan['review_lost'] = [];
  for (const r of rows.results ?? []) {
    if (r.has_snapshot) {
      restore.push(r.chunk_id);
      // قرارٌ وقع بعد الدفعة: وقتُه بعد وقت أخذ الصورة.
      if (r.reviewed_at && batchAt?.at && r.reviewed_at >= batchAt.at) {
        review_lost.push({ id: r.chunk_id, review_status: r.review_status ?? '', reviewed_at: r.reviewed_at });
      }
    } else {
      remove.push(r.chunk_id);
    }
  }
  return { batch_id: batchId, law_id: lawId, restore, remove, review_lost };
}

/**
 * يردّ نظاماً إلى ما كان عليه قبل دفعة.
 *
 * والصورة تُكتب صفّاً كاملاً لا حقولاً مختارة: كتابةُ بعض الحقول تترك مادةً
 * نصفُها من قبل الدفعة ونصفُها من بعدها — وهي حالٌ لم تقع قطّ، ولا يعرف
 * قارئُها أنها مركَّبة.
 *
 * وما أدرجته الدفعة يُحذف بنصِّه محفوظاً في سجلّ التحديث، كما يُحذف اليتيم.
 */
export async function revertLaw(
  env: Env,
  batchId: string,
  lawId: string,
  opts: { actorId?: string } = {}
): Promise<{ restored: number; removed: number }> {
  const plan = await planRevert(env, batchId, lawId);

  let restored = 0;
  for (let i = 0; i < plan.restore.length; i += DB_BATCH) {
    const slice = plan.restore.slice(i, i + DB_BATCH);
    const marks = slice.map(() => '?').join(',');
    const snaps = await env.DB.prepare(
      `SELECT chunk_id, row_json FROM legal_snapshots WHERE batch_id = ? AND chunk_id IN (${marks})`
    )
      .bind(batchId, ...slice)
      .all<{ chunk_id: string; row_json: string }>();

    const statements = [];
    for (const s of snaps.results ?? []) {
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(s.row_json);
      } catch {
        continue; // صورةٌ لا تُقرأ لا تُردّ نصفَ مادة
      }
      // `seq` يبقى كما هو: عليه يقوم الفهرس اللفظي ومعرّف المتجه، وتغييرُه
      // يقطع الفهرس عن صاحبه. و`embedded_at` يُصفَّر ليُعاد بناء المتجه على
      // النصّ المستعاد — نصٌّ عاد ومتجهٌ لم يعد يطابقه أسوأ من غيابهما.
      const cols = Object.keys(row).filter((k) => k !== 'seq' && k !== 'embedded_at');
      const sets = [...cols.map((c) => `${c} = ?`), 'embedded_at = NULL'].join(', ');
      statements.push(
        env.DB.prepare(`UPDATE legal_chunks SET ${sets} WHERE id = ?`).bind(
          ...cols.map((c) => row[c] ?? null),
          s.chunk_id
        )
      );
      restored++;
    }
    if (statements.length) await env.DB.batch(statements);
  }

  // والمُدرَج يُحذف كما يُحذف اليتيم: نصُّه إلى سجلّ التحديث، ثم متجهُه معه.
  const removed = await deleteOrphans(env, plan.remove, { actorId: opts.actorId });

  // ويُقيَّد في سجلّ الدفعات أنّ هذه الدفعة رُدَّ منها شيء، فلا تُقرأ لاحقاً
  // كأنها قائمةٌ بأثرها كلِّه. والقيد على الدفعة لا على النظام — والتفصيل
  // (أيُّ نظامٍ ومتى وبأيّ يد) في سجلّ التدقيق.
  //
  // وليس قفلاً: الدفعة تحمل أنظمةً، وردُّ أحدها لا يمنع ردَّ الآخر، وصورُها
  // باقيةٌ حتى يُقلّمها ما بعدها.
  if (restored || removed) {
    await env.DB.prepare('UPDATE legal_imports SET reverted_at = ?, reverted_by = ? WHERE batch_id = ?')
      .bind(Date.now(), opts.actorId ?? null, batchId)
      .run();
  }

  return { restored, removed };
}

/** مادةٌ في القاعدة غابت عن دفعةٍ تامّة تحمل نظامها. */
export interface OrphanChunk {
  id: string;
  law_id: string | null;
  article_no: string | null;
  law_title: string | null;
  review_status: string;
  was_edited: boolean;
}

/**
 * أيتام الدفعة: ما بقي في القاعدة من أنظمةٍ حملتها الدفعة ولم ترد فيها.
 *
 * **والحصر على أنظمة الدفعة وحدها.** `upsert` تُحدّث وتُضيف ولا تحذف ما اختفى،
 * فمادةٌ أُسقطت من المصدر تبقى في النتائج إلى الأبد. لكنّ القياس يكون على ما
 * وردت الدفعة به: نظامٌ لم تحمله لا يُقاس عليه شيء، وإلا محا رفعُ نظامٍ واحد
 * كلَّ ما عداه.
 */
export async function listBatchOrphans(env: Env, batchId: string): Promise<OrphanChunk[]> {
  const rows = await env.DB.prepare(
    `SELECT c.id, c.law_id, c.article_no, c.law_title, c.review_status,
            c.text_original_import IS NOT NULL AS was_edited
     FROM legal_chunks c
     WHERE c.law_id IN (SELECT DISTINCT law_id FROM legal_batch_ids WHERE batch_id = ? AND law_id IS NOT NULL)
       AND c.id NOT IN (SELECT chunk_id FROM legal_batch_ids WHERE batch_id = ?)
     ORDER BY c.law_id, c.seq`
  )
    .bind(batchId, batchId)
    .all<{
      id: string; law_id: string | null; article_no: string | null;
      law_title: string | null; review_status: string; was_edited: number;
    }>();

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    law_id: r.law_id,
    article_no: r.article_no,
    law_title: r.law_title,
    review_status: r.review_status,
    was_edited: r.was_edited === 1,
  }));
}

/**
 * يحذف أيتام الدفعة — السجلّ ومتجهه معاً.
 *
 * ولا يُمحى نصُّها: يدخل `legal_chunk_versions` بوسم «حُذفت من المصدر» قبل
 * الحذف. فمن استشهد بها أمسِ يجد أثرها اليوم، ومن أراد ردَّها وجد نصَّها.
 */
export async function deleteOrphans(
  env: Env,
  ids: string[],
  opts: { importId?: string; actorId?: string } = {}
): Promise<number> {
  if (!ids.length) return 0;
  const existing = await fetchExisting(env, ids);
  const now = Date.now();
  let deleted = 0;

  for (let i = 0; i < ids.length; i += DB_BATCH) {
    const slice = ids.slice(i, i + DB_BATCH);
    const statements = [];
    for (const id of slice) {
      const old = existing.get(id);
      if (!old) continue;
      statements.push(
        archiveVersion(env, {
          chunkId: old.id,
          lawId: old.law_id,
          articleNo: old.article_no,
          status: old.status,
          isRepealed: old.is_repealed,
          instrumentNo: old.instrument_no,
          issueDate: old.issue_date,
          issueDateHijri: old.issue_date_hijri,
          text: old.text,
          changedFields: 'deleted',
          importId: opts.importId ?? null,
          amendedOn: null,
          amendmentInstrument: null,
          changeKind: 'deleted',
          origin: 'deleted',
          at: now,
        })
      );
      statements.push(env.DB.prepare('DELETE FROM legal_chunks WHERE id = ?').bind(id));
      deleted++;
    }
    if (statements.length) await env.DB.batch(statements);
    // ومتجهاتها معها: سجلٌّ حُذف ومتجهُه باقٍ يُرجع نتيجةً لا صفَّ لها.
    if (env.VECTORIZE) {
      const seqs = slice.map((id) => existing.get(id)?.seq).filter((n): n is number => typeof n === 'number');
      if (seqs.length) await env.VECTORIZE.deleteByIds(seqs.map(vectorId)).catch(() => {});
    }
  }
  return deleted;
}

/** بصمات ما أُرشِف لهذه المواد — بها لا يتكرّر النصّ السابق عند إعادة الرفع. */
async function fetchArchivedHashes(env: Env, ids: string[]): Promise<Map<string, Set<string>>> {
  const found = new Map<string, Set<string>>();
  for (const id of ids) found.set(id, new Set());
  for (let i = 0; i < ids.length; i += DB_BATCH) {
    const slice = ids.slice(i, i + DB_BATCH);
    const marks = slice.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT chunk_id, text_hash FROM legal_chunk_versions
       WHERE chunk_id IN (${marks}) AND text_hash IS NOT NULL`
    )
      .bind(...slice)
      .all<{ chunk_id: string; text_hash: string }>();
    for (const r of rows.results ?? []) found.get(r.chunk_id)?.add(r.text_hash);
  }
  return found;
}

interface ArchivedVersion {
  chunkId: string;
  lawId: string | null;
  articleNo: string | null;
  status: string;
  isRepealed: number;
  instrumentNo: string | null;
  issueDate: string | null;
  issueDateHijri: string | null;
  text: string;
  changedFields: string;
  amendedOn: string | null;
  amendmentInstrument: string | null;
  changeKind: string | null;
  /**
   * من أين جاء النصّ المؤرشَف:
   * `displaced` أزاحته دفعةٌ جديدة · `superseded` ورد في `text_superseded`
   * · `deleted` حُذفت مادتُه من المصدر فحُفظ نصُّها قبل ذهابها.
   */
  origin: 'displaced' | 'superseded' | 'deleted';
  importId: string | null;
  at: number;
}

function archiveVersion(env: Env, v: ArchivedVersion) {
  return env.DB.prepare(
    `INSERT INTO legal_chunk_versions
     (id, chunk_id, law_id, article_no, status, is_repealed, instrument_no, issue_date, issue_date_hijri,
      text, changed_fields, import_id, archived_at, amended_on, amendment_instrument, change_kind, origin, text_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    uuid(),
    v.chunkId,
    v.lawId,
    v.articleNo,
    v.status,
    v.isRepealed,
    v.instrumentNo,
    v.issueDate,
    v.issueDateHijri,
    v.text,
    v.changedFields,
    v.importId,
    v.at,
    v.amendedOn,
    v.amendmentInstrument,
    v.changeKind,
    v.origin,
    hashText(v.text)
  );
}

// ── سجلّ تحديث النظام ──

export interface ChunkVersion {
  id: string;
  chunk_id: string;
  article_no: string | null;
  status: string;
  text: string;
  changed_fields: string;
  archived_at: number;
  /** تاريخ التعديل الهجري كما ورد — لا وقتُ اكتشافنا له. */
  amended_on: string | null;
  amendment_instrument: string | null;
  /** `amendment` تعديلٌ نظاميّ · `correction` تصحيحُ خطأٍ في سحبٍ سابق. */
  change_kind: string | null;
  /** `displaced` أزاحه استيراد · `superseded` نصٌّ سابق ورد في الملف. */
  origin: string | null;
  /** النصّ الجاري اليوم — به تُقرأ النسخة المؤرشفة مقارنةً لا مفردة. */
  current_text: string | null;
  current_article_no: string | null;
}

/**
 * ما أُزيح من مواد نظامٍ بعينه، أحدثه أولاً.
 *
 * الترتيب بوقت الأرشفة لا بتاريخ التعديل: التواريخ الهجرية تصل بصيغٍ شتّى
 * وبعضها غائب، وترتيبُ نصوصٍ متفاوتة الصيغة يُنتج قائمةً تبدو مرتّبة وليست
 * كذلك. والمعروض في كل سطر تاريخُ تعديله — وهو المقصود من §٦.
 */
export async function listLawChanges(
  env: Env,
  lawId: string,
  opts: { offset?: number; limit?: number } = {}
): Promise<{ changes: ChunkVersion[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);

  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM legal_chunk_versions WHERE law_id = ?')
    .bind(lawId)
    .first<{ n: number }>();

  const rows = await env.DB.prepare(
    `SELECT v.id, v.chunk_id, v.article_no, v.status, v.text, v.changed_fields, v.archived_at,
            v.amended_on, v.amendment_instrument, v.change_kind, v.origin,
            c.text AS current_text, c.article_no AS current_article_no
     FROM legal_chunk_versions v
     LEFT JOIN legal_chunks c ON c.id = v.chunk_id
     WHERE v.law_id = ?
     ORDER BY v.archived_at DESC, v.rowid DESC
     LIMIT ? OFFSET ?`
  )
    .bind(lawId, limit, offset)
    .all<ChunkVersion>();

  return { changes: rows.results ?? [], total: total?.n ?? 0 };
}

// ── ٢) الفهرسة: `embed_text` وحده يصير متجهاً ──

/** معرّف المتجه من المفتاح الداخلي — قصير وثابت مهما طال `id` في الملف. */
function vectorId(seq: number): string {
  return `legal:${seq}`;
}

/** يستخرج المفتاح الداخلي من معرّف متجه، أو null إن لم يكن متجه مقطع نظامي. */
export function seqFromVectorId(id: string): number | null {
  const m = /^legal:(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

export interface EmbedResult {
  embedded: number;
  remaining: number;
  /** متجهاتٌ حُذفت لأن مادتها صارت ملغاة. */
  purged?: number;
  /** سبب التخطّي إن لم يُنفَّذ التضمين — الفهرس المتجهي غير مهيّأ. */
  skipped?: string;
  /** مقاطعُ تعثّرت دفعتُها فبقيت بلا متجه — تُعاد في الشوط التالي. */
  failed?: number;
  /** سببُ أوّل دفعةٍ تعثّرت. يُقال ولا يُخمَّن. */
  error?: string;
}

/**
 * ما يستحقّ متجهاً: كلُّ مادة غير ملغاة.
 *
 * والملغاة لا تُفهرَس أصلاً — لا تُفهرَس ثم تُصفّى. فهرستُها تُنفق حصّة
 * التضمين على ما لا يُسترجَع، وتُبقي متجهاً يطابق نصّاً خرج من النظام.
 */
const EMBEDDABLE_SQL = `retrieval_status <> '${RETRIEVAL_REPEALED}' AND is_repealed = 0`;

/** الشرط نفسه مؤهَّلاً باسم الجدول — لاستعلامٍ يجمع أعمدةً من `c`. */
const EMBEDDABLE_SQL_C = `c.retrieval_status <> '${RETRIEVAL_REPEALED}' AND c.is_repealed = 0`;

/**
 * يحوّل `embed_text` للمقاطع التي تنتظر، دفعةً بعد دفعة.
 *
 * ولا يمسّ `text`: هو للعرض والاستشهاد ولا يدخل نموذج التضمين.
 *
 * **ويبدأ بالتنظيف قبل البناء.** مادةٌ انقلبت حالها إلى «ملغى» في دفعةٍ لاحقة
 * يبقى متجهُها يطابق نصّها في البحث الدلاليّ، وتحديثُ الحال وحده لا يكفي:
 * التصفية في SQL تُسقط الصفّ بعد استرجاعه، فتضيع خانةٌ من `topK` على مادةٍ
 * لا تُعرض — وكلَّما كثرت الملغاة ضعف البحث بلا سبب ظاهر.
 */
export async function embedPending(env: Env, limit = 200): Promise<EmbedResult> {
  const pendingCount = async () => {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM legal_chunks WHERE embedded_at IS NULL AND ${EMBEDDABLE_SQL}`
    ).first<{ n: number }>();
    return row?.n ?? 0;
  };

  if (!env.VECTORIZE) {
    // بلا فهرس متجهي يبقى البحث اللفظي عاملاً وحده — استرجاعٌ أضعف، لا معطَّل.
    return { embedded: 0, remaining: await pendingCount(), skipped: 'الفهرس المتجهي غير مهيّأ' };
  }

  const purged = await purgeRepealedVectors(env, limit);

  const rows = await env.DB.prepare(
    `SELECT seq, embed_text, law_id, doc_type, status, is_repealed, article_no_norm
     FROM legal_chunks WHERE embedded_at IS NULL AND ${EMBEDDABLE_SQL} ORDER BY seq LIMIT ?`
  )
    .bind(limit)
    .all<{
      seq: number; embed_text: string; law_id: string | null; doc_type: string | null;
      status: string; is_repealed: number; article_no_norm: string | null;
    }>();

  const pending = rows.results ?? [];
  let embedded = 0;
  let failed = 0;
  let firstError: string | undefined;

  for (let i = 0; i < pending.length; i += AI_BATCH) {
    const slice = pending.slice(i, i + AI_BATCH);
    /* الدفعة معزولة: تعثّرها يُحصى ولا يُسقط ما بعدها.

       وكانت الحلقة بلا حرس، فرميةٌ واحدة — حدُّ معدّل من Workers AI، أو نصٌّ
       يرفضه النموذج — تخرج من `embedPending` كلِّها. فيقف الـCron وتقف
       «تضمين الآن» عند أوّل عثرة، ويبقى الباقي معلَّقاً بلا سبب ظاهر. */
    try {
      // القصّ هنا يمسّ **مدخل المتجه وحده** — المقطع يبقى مقطعاً واحداً،
      // ونصّه المعروض كاملاً كما ورد. ويُحصى في تقرير الاستيراد ليُرى.
      const vectors = await embedBatch(env, slice.map((r) => r.embed_text.slice(0, EMBED_MAX_CHARS)));
      await env.VECTORIZE.upsert(
        slice.map((r, j) => ({
          id: vectorId(r.seq),
          values: vectors[j],
          // بيانات وصفية للاطّلاع ولتصفيةٍ مستقبلية على مستوى الفهرس. وصحّة
          // التصفية لا تعتمد عليها: الشرط يُطبَّق في SQL بعد الاسترجاع.
          metadata: {
            kind: 'legal',
            law_id: r.law_id ?? '',
            doc_type: r.doc_type ?? '',
            status: r.status,
            is_repealed: r.is_repealed,
            article_no: r.article_no_norm ?? '',
          },
        }))
      );
      /* الوسم **بعد** نجاح الرفع لا قبله ولا بمعزلٍ عنه.

         وكان يقع في كل حال: تُرفع الدفعة أو تفشل، ثم تُوسم صفوفُها
         `embedded_at` على أي حال. فمقطعٌ بلا متجه — أو بمتجهٍ `undefined`
         مرّره العقدُ القديم بلا فحص — يخرج من عدّ المنتظر ولا يعود إليه
         أبداً. عطبٌ صامت لا يُصلحه إلا إعادة تضمينٍ يدوية لا يعرف أحد
         أنها لازمة. */
      const now = Date.now();
      await env.DB.batch(
        slice.map((r) => env.DB.prepare('UPDATE legal_chunks SET embedded_at = ? WHERE seq = ?').bind(now, r.seq))
      );
      embedded += slice.length;
    } catch (e: any) {
      // بلا وسم: الصفوف تبقى منتظرة فيلتقطها الشوط التالي أو الـCron.
      failed += slice.length;
      firstError ??= String(e?.message ?? e);
    }
  }

  return { embedded, remaining: await pendingCount(), purged, failed, error: firstError };
}

/**
 * يحذف متجهات ما صار ملغىً.
 *
 * والعلامة أن الصفّ يحمل `embedded_at` وحالُه «ملغى»: كان له متجه ولم يعد
 * يستحقّه. ويُصفَّر الطابع بعد الحذف فيخرج من عدّ المنتظر أيضاً — شرطُ
 * `EMBEDDABLE_SQL` يمنع عودته إلى الطابور، فلا يدور بين حذفٍ وبناء.
 */
async function purgeRepealedVectors(env: Env, limit: number): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT seq FROM legal_chunks
     WHERE embedded_at IS NOT NULL AND NOT (${EMBEDDABLE_SQL}) ORDER BY seq LIMIT ?`
  )
    .bind(limit)
    .all<{ seq: number }>();

  const stale = rows.results ?? [];
  if (!stale.length) return 0;

  // الحذف أوّلاً ثم التصفير: لو انقطع الشوط بينهما بقي الصفّ موسوماً
  // بمتجهٍ حُذف، فيُعاد الحذف في الشوط التالي بلا ضرر. والعكس يترك متجهاً
  // لا يعرف أحدٌ أنه بقي.
  await env.VECTORIZE!.deleteByIds(stale.map((r) => vectorId(r.seq))).catch(() => {});
  await env.DB.batch(
    stale.map((r) => env.DB.prepare('UPDATE legal_chunks SET embedded_at = NULL WHERE seq = ?').bind(r.seq))
  );
  return stale.length;
}

// ── ٤) البيانات الوصفية: تصفية قبل البحث ──

export interface LegalFilters {
  /** حصر البحث في نظام — ويشمل لوائحه افتراضياً عبر `parent_law_id`. */
  lawId?: string | null;
  docType?: string | null;
  articleNo?: string | null;
  /** جلب اللائحة مع نظامها. الافتراضي: نعم. */
  withRegulations?: boolean;
  /**
   * تجاوز التصفية على السريان.
   *
   * للأرشيف والمقارنة التاريخية وحدهما، ولا يُمرَّر من مسار استشهاد. الافتراضي
   * `false` دائماً — وهو ما يجعل التصفية إلزامية بحقّ.
   */
  includeRepealed?: boolean;
  /**
   * تجاوز الحجب المشروط: إظهار المعطوب الذي لم يُبتّ فيه.
   *
   * لشاشة المراجعة وتصفّح النظام وحدهما. والاسترجاع الآلي — محادثةً كان أو
   * تقريراً أو أتمتة — لا يمرّره أبداً: نصٌّ تسرّبت إليه واجهةُ البوابة أو
   * اقتُطع نصفُه لا يُستشهد به قبل أن يراه إنسان.
   */
  includeDefective?: boolean;

  /** حصر البحث في بابٍ من النظام — `book` كما ورد في الملف. */
  book?: string | null;
}

function buildFilters(f: LegalFilters): { sql: string; binds: unknown[] } {
  const clauses: string[] = [];
  const binds: unknown[] = [];

  if (!f.includeRepealed) clauses.push(EFFECTIVE_SQL);
  if (!f.includeDefective) clauses.push(SOUND_SQL);

  if (f.lawId) {
    if (f.withRegulations === false) {
      clauses.push('c.law_id = ?');
      binds.push(f.lawId);
    } else {
      clauses.push('(c.law_id = ? OR c.parent_law_id = ?)');
      binds.push(f.lawId, f.lawId);
    }
  }
  if (f.docType) {
    // النوع يُقابَل كما يُقابَل عند الاستيراد، فمن رشّح بـ«نظام» أصاب ما
    // خُزِّن `law`: لغةُ المرشِّح ليست لغة المخزَّن، ولا يُطالَب بمعرفتها.
    clauses.push('c.doc_type = ?');
    binds.push(canonicalDocType(f.docType) ?? f.docType);
  }
  if (f.book) {
    // الباب يُطابَق مطبَّعاً: «الباب الثالث» و«الباب الثّالث» بابٌ واحد.
    clauses.push('c.book_norm = ?');
    binds.push(normalizeArabic(f.book));
  }
  if (f.articleNo) {
    clauses.push('c.article_no_norm = ?');
    binds.push(normalizeArticleNo(f.articleNo));
  }

  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', binds };
}

interface HitRow {
  seq: number; id: string; law_id: string | null; parent_law_id: string | null;
  doc_type: string | null; article_no: string | null; article_no_norm: string | null;
  article_label: string | null; article_title: string | null;
  book: string | null; chapter: string | null; section: string | null;
  instrument: string | null; instrument_no: string | null; authority: string | null;
  status: string; is_repealed: number; law_title: string | null;
  issue_date: string | null; issue_date_hijri: string | null; effective_from: string | null;
  effective_from_hijri: string | null; effective_to: string | null; source_url: string | null;
  text: string; part: string | null; parts_total: number | null;
  is_duplicate: number; duplicate_of: string | null; duplicate_index: number | null;
  has_amendments: number; amendment_kind: string | null; amendment_applied: number;
  needs_review: number; reviewed_at: number | null;
  retrieval_status: string; retrieval_warning: string | null;
  has_defect: number; defect_kind: string | null;
  review_status: string; review_note: string | null; was_edited: number;
  amendment_instrument: string | null; amended_on: string | null;
  amendments_count: number | null; amend_note: string | null;
  meta_json: string | null;
}

function toHit(r: HitRow): LegalHit {
  let meta: Record<string, unknown> | null = null;
  if (r.meta_json) {
    try {
      meta = JSON.parse(r.meta_json);
    } catch {
      meta = null;
    }
  }
  return {
    seq: r.seq,
    id: r.id,
    lawId: r.law_id,
    parentLawId: r.parent_law_id,
    docType: r.doc_type,
    articleNo: r.article_no,
    articleLabel: r.article_label,
    articleTitle: r.article_title,
    book: r.book,
    chapter: r.chapter,
    section: r.section,
    instrument: r.instrument,
    instrumentNo: r.instrument_no,
    authority: r.authority,
    lawTitle: r.law_title,
    status: r.status,
    isRepealed: r.is_repealed === 1,
    issueDate: r.issue_date,
    issueDateHijri: r.issue_date_hijri,
    effectiveFrom: r.effective_from,
    effectiveFromHijri: r.effective_from_hijri,
    effectivePending: isEffectivePending(r.effective_from, r.effective_from_hijri),
    effectiveTo: r.effective_to,
    sourceUrl: r.source_url,
    text: r.text,
    part: r.part,
    partsTotal: r.parts_total,
    isDuplicate: r.is_duplicate === 1,
    duplicateOf: r.duplicate_of,
    duplicateIndex: r.duplicate_index,
    hasAmendments: r.has_amendments === 1,
    amendmentKind: r.amendment_kind,
    amendmentApplied: r.amendment_applied === 1,
    needsReview: r.needs_review === 1,
    retrievalStatus: r.retrieval_status,
    retrievalWarning: r.retrieval_warning,
    hasDefect: r.has_defect === 1,
    defectKind: r.defect_kind,
    reviewedAt: r.reviewed_at,
    reviewStatus: r.review_status,
    reviewNote: r.review_note,
    wasEdited: r.was_edited === 1,
    amendmentInstrument: r.amendment_instrument,
    amendedOn: r.amended_on,
    amendmentsCount: r.amendments_count,
    amendNote: r.amend_note,
    meta,
    score: 0,
    signals: [],
  };
}

/**
 * يضمّ إلى النتائج أخواتِ كل مادةٍ تحمل رقمها.
 *
 * المرسوم المعدِّل يُدخل مادةً جديدة برقم مادةٍ قائمة، فيصير في النظام موضعان
 * بالرقم نفسه ونصّاهما مختلفان. واستدعاءُ الرقم لا يجوز أن يردّ أوّلهما وحده:
 * المادة المضافة تختفي حينئذٍ من النتائج ولا شيء يدلّ على غيابها.
 *
 * والتصفية نفسها تسري على المضموم — منسوخٌ أو محجوبٌ للمراجعة لا يدخل من هنا.
 */
async function expandDuplicates(env: Env, hits: LegalHit[], filters: LegalFilters): Promise<LegalHit[]> {
  const groups = Array.from(new Set(hits.map((h) => h.duplicateOf).filter((g): g is string => !!g)));
  if (!groups.length) return hits;

  const built = buildFilters(filters);
  const marks = groups.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT ${HIT_COLUMNS} FROM legal_chunks c
     WHERE c.duplicate_of IN (${marks})${built.sql}
     ORDER BY c.duplicate_of, c.duplicate_index, c.seq`
  )
    .bind(...groups, ...built.binds)
    .all<HitRow>();

  const merged = new Map(hits.map((h) => [h.id, h]));
  for (const r of rows.results ?? []) if (!merged.has(r.id)) merged.set(r.id, toHit(r));
  return Array.from(merged.values()).sort(byDuplicateOrder);
}

/**
 * هل تاريخ نفاذ المادة لم يحلّ بعد؟
 *
 * يُقارَن كلُّ تقويم بنظيره: الميلاديّ بالميلاديّ نصّاً (`YYYY-MM-DD` يترتّب
 * نصّياً كما يترتّب زمنياً)، والهجريّ بهجريّ اليوم. والتحويل بين التقويمين
 * لكل مادة أثقل من أن يُحتمل، ولا حاجة إليه: المقارنة داخل التقويم الواحد.
 *
 * ويُحسب هجريُّ اليوم مرّةً في اليوم لا مرّةً لكل صفّ.
 */
let todayHijriCache: { on: string; value: string } | null = null;

function hijriToday(now: Date): string {
  const on = now.toISOString().slice(0, 10);
  if (todayHijriCache?.on !== on) todayHijriCache = { on, value: toHijri(now) };
  return todayHijriCache.value;
}

/** أرقام تاريخٍ هجريّ للمقارنة: «1448/01/01هـ» ⇦ 14480101. */
function hijriKey(value: string | null): number | null {
  if (!value) return null;
  const m = /(\d{3,4})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,2})/.exec(normalizeArabic(value));
  if (!m) return null;
  return Number(m[1]) * 10_000 + Number(m[2]) * 100 + Number(m[3]);
}

function isEffectivePending(gregorian: string | null, hijri: string | null, now = new Date()): boolean {
  if (gregorian) return gregorian > now.toISOString().slice(0, 10);
  const from = hijriKey(hijri);
  const today = hijriKey(hijriToday(now));
  return from !== null && today !== null && from > today;
}

/** ترتيب أخوات الرقم الواحد: `duplicate_index` ثم ترتيب الملف. */
function byDuplicateOrder(a: LegalHit, b: LegalHit): number {
  if (a.duplicateOf && a.duplicateOf === b.duplicateOf) {
    const ai = a.duplicateIndex ?? Number.MAX_SAFE_INTEGER;
    const bi = b.duplicateIndex ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
  }
  return a.seq - b.seq;
}

// ── ٣) البحث الهجين ──

export interface LegalSearchOptions extends LegalFilters {
  limit?: number;
  /**
   * بحثٌ لفظيّ وحده — بلا تضمينٍ ولا نداءِ نموذج.
   *
   * لشاشات البحث المباشر: يبحث المستخدم بكلماته في محتوىً مفهرس، ولا حاجة
   * فيه إلى نموذج ولا كلفةَ نداءٍ ولا تأخيرَه. والاسترجاع للمحادثة يبقى
   * هجيناً كما هو.
   */
  lexicalOnly?: boolean;
  /**
   * متجه الاستعلام محسوباً سلفاً.
   *
   * للنداء الذي يبحث في المصدرين بالاستعلام نفسه (`retrieve`): تضمينه مرّة
   * وتمريره أرخص من حسابه في كل مسار — وهو استدعاء شبكة لا حساب محلي.
   */
  queryVector?: number[];
}

/**
 * بحث هجين: دلاليّ على المتجهات + لفظيّ على النصّ المطبَّع، ثم دمج الرتب.
 *
 * الدمج بـRRF لا بجمع الدرجات: درجة التشابه الجيبي ودرجة bm25 مقياسان
 * مختلفان لا يُجمعان، وتطبيعهما يدوياً يتغيّر بتغيّر التوزيع. أما الرتب
 * فمقارنتها صحيحة دائماً.
 *
 * وكل مسار من المسارين يحمل شرط السريان في SQL نفسه — لا بعده.
 */
export async function searchLegal(env: Env, query: string, opts: LegalSearchOptions = {}): Promise<LegalHit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const filters = buildFilters(opts);
  const candidates = Math.min(limit * 4, 50);

  const lists: { name: string; hits: LegalHit[] }[] = [];

  // استعلامٌ بلا نصّ: تصفّحٌ بالبيانات الوصفية وحدها (مادة بعينها، نظام بعينه).
  if (!query.trim()) {
    if (!opts.lawId && !opts.articleNo && !opts.docType) return [];
    const rows = await env.DB.prepare(
      `SELECT ${HIT_COLUMNS} FROM legal_chunks c WHERE 1 = 1${filters.sql}
       ORDER BY c.law_id, c.seq LIMIT ?`
    )
      .bind(...filters.binds, limit)
      .all<HitRow>();
    return (rows.results ?? []).map((r, i) => ({ ...toHit(r), score: 1 / (RRF_K + i), signals: ['metadata'] }));
  }

  const articleInQuery = opts.articleNo ? normalizeArticleNo(opts.articleNo) : extractArticleNo(query);

  // ── المسار اللفظي ──
  const match = ftsMatchExpression(query);
  if (match) {
    try {
      const rows = await env.DB.prepare(
        `SELECT ${HIT_COLUMNS}, bm25(legal_fts) AS lex
         FROM legal_fts JOIN legal_chunks c ON c.seq = legal_fts.rowid
         WHERE legal_fts MATCH ?${filters.sql}
         ORDER BY lex ASC LIMIT ?`
      )
        .bind(match, ...filters.binds, candidates)
        .all<HitRow>();
      lists.push({ name: 'lexical', hits: (rows.results ?? []).map(toHit) });
    } catch {
      // فهرس لفظي غير مهيّأ (هجرة لم تُطبَّق بعد) — يبقى الدلاليّ وحده.
    }
  }

  // ── المسار الدلالي ──
  if (env.VECTORIZE && !opts.lexicalOnly) {
    try {
      // الاستعلام يُضمَّن كما كتبه صاحبه لا مطبَّعاً: النموذج يفهم الصرف
      // العربي، والتطبيع يمحو منه ما يستفيد منه. التطبيع للفظيّ وحده.
      const vector = opts.queryVector ?? (await embed(env, query));
      const res = await env.VECTORIZE.query(vector, { topK: candidates, returnMetadata: 'none' });
      const seqs: number[] = [];
      for (const m of res.matches ?? []) {
        const seq = seqFromVectorId(m.id);
        if (seq !== null) seqs.push(seq);
      }
      if (seqs.length) {
        const marks = seqs.map(() => '?').join(',');
        const rows = await env.DB.prepare(
          `SELECT ${HIT_COLUMNS} FROM legal_chunks c WHERE c.seq IN (${marks})${filters.sql}`
        )
          .bind(...seqs, ...filters.binds)
          .all<HitRow>();
        // الترتيب من الفهرس المتجهي، والتصفية من SQL: ما سقط بالشرط لا يعود.
        const bySeq = new Map((rows.results ?? []).map((r) => [r.seq, toHit(r)]));
        const ordered: LegalHit[] = [];
        for (const seq of seqs) {
          const hit = bySeq.get(seq);
          if (hit) ordered.push(hit);
        }
        lists.push({ name: 'semantic', hits: ordered });
      }
    } catch {
      // الفهرس المتجهي أو نموذج التضمين غير متاح — يبقى اللفظيّ وحده.
    }
  }

  // ── استدعاء مادة بعينها ──
  // «المادة 74 من نظام العمل» مع حصر النظام: المطلوب معروف بلا ترجيح.
  if (articleInQuery && opts.lawId) {
    const exact = await env.DB.prepare(
      `SELECT ${HIT_COLUMNS} FROM legal_chunks c WHERE c.article_no_norm = ?${filters.sql} LIMIT 5`
    )
      .bind(articleInQuery, ...filters.binds)
      .all<HitRow>();
    if (exact.results?.length) {
      // استدعاءُ رقمٍ يردّ كل من يحمله: أخواتُ المادة تُضمّ هنا لا في الواجهة،
      // وإلا اختفت المادة المضافة بمرسومٍ معدِّل من نتائج كل مسار آخر.
      //
      // والضمّ بنطاق النظام لا بنطاق الرقم: أختُ المادة قد تُكتب «233 مكرر»
      // فلا تطابق الرقم، وإنما يجمعها `duplicate_of` وحده.
      const hits = await expandDuplicates(env, exact.results.map(toHit), { ...opts, articleNo: null });
      lists.push({ name: 'article', hits });
    }
  }

  return fuse(lists, articleInQuery, limit);
}

/** دمج القوائم المرتّبة بـRRF، مع ترجيح مطابقة رقم المادة. */
function fuse(lists: { name: string; hits: LegalHit[] }[], articleNo: string | null, limit: number): LegalHit[] {
  const merged = new Map<number, LegalHit>();

  for (const list of lists) {
    list.hits.forEach((hit, rank) => {
      const existing = merged.get(hit.seq);
      const target = existing ?? hit;
      if (!existing) merged.set(hit.seq, target);
      target.score += 1 / (RRF_K + rank);
      target.signals.push(list.name);
    });
  }

  if (articleNo) {
    for (const hit of merged.values()) {
      if (normalizeArticleNo(hit.articleNo) === articleNo) {
        hit.score += ARTICLE_BOOST;
        if (!hit.signals.includes('article')) hit.signals.push('article');
      }
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── استدعاءات مباشرة بالبيانات الوصفية ──

/**
 * مادة بعينها في نظام بعينه — **وكلُّ من يحمل رقمها**.
 *
 * المواد المضافة بمراسيم معدِّلة تحمل أرقام موادّ قائمة، فيصير في النظام
 * موضعان بالرقم نفسه. وردُّ الأول وحده يُخفي الثاني بلا أثر — وهو مادةٌ
 * نظامية سارية لا تكرارٌ يُهمَل.
 */
export async function getArticle(
  env: Env,
  opts: {
    lawId: string;
    articleNo: string;
    includeRepealed?: boolean;
    includeDefective?: boolean;
    docType?: string | null;
  }
): Promise<LegalHit[]> {
  const scope: LegalFilters = {
    lawId: opts.lawId,
    docType: opts.docType ?? null,
    withRegulations: false,
    includeRepealed: opts.includeRepealed,
    includeDefective: opts.includeDefective,
  };
  const filters = buildFilters({ ...scope, articleNo: opts.articleNo });
  const rows = await env.DB.prepare(
    `SELECT ${HIT_COLUMNS} FROM legal_chunks c WHERE 1 = 1${filters.sql} ORDER BY c.seq LIMIT 10`
  )
    .bind(...filters.binds)
    .all<HitRow>();
  // الضمّ بنطاق النظام لا بنطاق الرقم: أخوات المادة قد تحمل أرقاماً مختلفة
  // في `article_no` وتجمعها `duplicate_of` وحدها.
  return expandDuplicates(env, (rows.results ?? []).map(toHit), scope);
}

/** مقطع بمعرّفه. التصفية سارية هنا أيضاً — الاستشهاد لا يستثنى من الشرط. */
export async function getChunkById(
  env: Env,
  id: string,
  includeRepealed = false,
  includeDefective = false
): Promise<LegalHit | null> {
  const filters = buildFilters({ includeRepealed, includeDefective });
  const row = await env.DB.prepare(
    `SELECT ${HIT_COLUMNS} FROM legal_chunks c WHERE c.id = ?${filters.sql} LIMIT 1`
  )
    .bind(id, ...filters.binds)
    .first<HitRow>();
  return row ? toHit(row) : null;
}

/**
 * معرّف النظام من عنوانه — لاستشهادٍ لا يحمل إلا العنوان.
 *
 * استشهادات المحادثات القديمة حُفظت بعنوان النظام ورقم المادة وحدهما، بلا
 * معرّف يفتح المادة. وهذا يردّ المعرّف من العنوان **بمطابقةٍ تامّة لا
 * تقريبية**: نظامان يتشابه عنوانهما ولا يتطابق مادتان مختلفتان، وفتحُ
 * الأقرب شكلاً استشهادٌ بغير ما استُند إليه — وهو أسوأ من ألّا يُفتح شيء.
 */
export async function resolveLawIdByTitle(env: Env, title: string): Promise<string | null> {
  const clean = title.trim();
  if (!clean) return null;
  const row = await env.DB.prepare(
    'SELECT law_id FROM legal_chunks WHERE law_title = ? AND law_id IS NOT NULL LIMIT 1'
  )
    .bind(clean)
    .first<{ law_id: string }>();
  return row?.law_id ?? null;
}

/**
 * نافذة التعديلات ونصُّ المادة السابق — بطلبٍ صريح وحده.
 *
 * التصنيف الآلي يقترح ولا يقرّر، وهذا ما يرجع إليه المراجع البشري: النصّ
 * الخام كما ورد في المصدر بلا إعادة سحب. وهو خارج نتائج البحث عمداً — حملُه
 * في كل نتيجة ثمنٌ بلا مقابل، وعرضُه مكان النصّ النافذ خطأ.
 */
export interface ChunkAmendment {
  id: string;
  amendment_kind: string | null;
  amendment_applied: number;
  amendment_instrument: string | null;
  amended_on: string | null;
  amendments_count: number | null;
  amendments_raw: string | null;
  amend_note: string | null;
  text_superseded: string | null;
  source_url: string | null;
  /** الخطّ الزمني: نسخُ النصّ مرتَّبةً، وآخرها المعتمد. */
  versions: TextVersion[];
  /** سجلّ التعديلات مفكَّكاً: عمليةٌ لكل حدث بما طُبِّق وما تُخطّي وسببه. */
  events: AmendmentEvent[];
}

export async function getChunkAmendment(env: Env, id: string): Promise<ChunkAmendment | null> {
  const row = await env.DB.prepare(
    `SELECT id, amendment_kind, amendment_applied, amendment_instrument, amended_on,
            amendments_count, amendments_raw, amend_note, text_superseded, source_url,
            text_versions, amendment_events
     FROM legal_chunks WHERE id = ? LIMIT 1`
  )
    .bind(id)
    .first<
      Omit<ChunkAmendment, 'versions' | 'events'> & {
        text_versions: string | null;
        amendment_events: string | null;
      }
    >();
  if (!row) return null;

  // نصٌّ محفوظٌ لا يُفكّ إلا هنا: المصفوفتان تُقرآن عند فتح المادة وحدها،
  // ولا تُصفّى بهما ولا تُرتَّب. وما تعذّر فكُّه يعود فارغاً لا يُسقط النافذة:
  // بطاقةٌ بلا خطٍّ زمنيّ خيرٌ من مادةٍ لا تُفتح.
  const parse = <T>(raw: string | null): T[] => {
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? (v as T[]) : [];
    } catch {
      return [];
    }
  };

  const { text_versions, amendment_events, ...rest } = row;
  return {
    ...rest,
    versions: parse<TextVersion>(text_versions),
    events: parse<AmendmentEvent>(amendment_events),
  };
}

// ── وحدة المراجعة ──
//
// **الفصل التام.** المواد الجاهزة تدخل الاسترجاع فور الاستيراد، والموسومة
// تنتظر هنا. والمراجعة لا توقف شيئاً: خمسة آلاف مادة تعمل بينما الطابور
// ممتلئ، وهو جوهر هذه الوحدة لا أثرٌ جانبيّ لها.

/**
 * الطوابير — كلٌّ يُعرَّف بشرطه على الحقول لا بقائمة موادّ ثابتة.
 *
 * ولذلك يتوسّع بلا حدّ: نظامٌ يُستورد غداً تدخل مواده الموسومة طوابيرها
 * تلقائياً، وعدّادُ كل طابور استعلامٌ حيّ يُحسب عند فتح الصفحة لا رقمٌ
 * مكتوب. والترتيب هنا هو ترتيب الأولوية: ما يُفسد الاسترجاع أوّلاً.
 *
 * والطوابير غير متنافية: مادةٌ مكرّرة الرقم قد تكون «غير مصنَّفة» أيضاً،
 * فتظهر في الطابورين وتخرج منهما معاً بأوّل قرار. وحصرُها في طابورٍ واحد
 * يُخفي عن المراجع أحدَ سببَي إحالتها.
 */
export const REVIEW_QUEUES = [
  { key: 'duplicate', sql: 'c.is_duplicate = 1' },
  {
    key: 'truncated',
    // نصٌّ أقصر من نصف سابقه: اقتطاعٌ في السحب غالباً لا اختصارٌ بمرسوم.
    sql: 'c.text_superseded IS NOT NULL AND LENGTH(c.text) * 2 < LENGTH(c.text_superseded)',
  },
  {
    key: 'preamble',
    // ديباجةُ المرسوم تسرّبت إلى متن المادة. تُطابَق على النصّ المطبَّع، فما
    // كُتب مشكولاً يُطابَق كما يُطابَق المجرَّد.
    sql: `(c.text_norm LIKE '%بموجب المرسوم%' OR c.text_norm LIKE '%لتكون بالنص%')`,
  },
  { key: 'partial', sql: 'c.amendment_kind_norm = ?', bind: normalizeArabic('تعديل جزئي') },
  { key: 'collective', sql: 'c.amendment_kind_norm = ?', bind: normalizeArabic('تعديل جماعي') },
  { key: 'addition', sql: 'c.amendment_kind_norm = ?', bind: normalizeArabic('إضافة') },
  { key: 'unclassified', sql: 'c.amendment_kind_norm = ?', bind: normalizeArabic('غير مصنَّف') },
] as const;

export type ReviewQueueKey = (typeof REVIEW_QUEUES)[number]['key'];

/**
 * شرط دخول الطابور أصلاً.
 *
 * **والملغاة لا تدخله.** الإلغاء قرارٌ نظاميّ موثَّق في نافذة التعديلات لا
 * اجتهادٌ يُراجَع، وإدخالُ مئةٍ وخمسٍ وسبعين مادةً ملغاة يُغرق المراجع بما
 * لا فائدة في مراجعته — ويُخفي تحته ما يستحقّها.
 */
const IN_QUEUE_SQL = `c.needs_review = 1 AND c.review_status = '${REVIEW_PENDING}'
                      AND c.is_repealed = 0 AND c.status <> 'repealed'`;

/** ما خرج من الطابور بقرار: منجَزُ العدّاد. */
const QUEUE_DONE_SQL = `c.needs_review = 1 AND c.review_status <> '${REVIEW_PENDING}'
                        AND c.is_repealed = 0 AND c.status <> 'repealed'`;

export interface ReviewFilters {
  /** حصر المراجعة في نظامٍ واحد — أسرع وأدقّ، فالذهن يبقى في موضوع واحد. */
  lawId?: string | null;
  /** دفعة الاستيراد: مراجعة ما استُورد حديثاً وحده. */
  capturedAt?: string | null;
  docType?: string | null;
}

function reviewFilterSql(f: ReviewFilters): { sql: string; binds: unknown[] } {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (f.lawId) {
    clauses.push('c.law_id = ?');
    binds.push(f.lawId);
  }
  if (f.capturedAt) {
    clauses.push('c.captured_at = ?');
    binds.push(f.capturedAt);
  }
  if (f.docType) {
    clauses.push('c.doc_type = ?');
    binds.push(f.docType);
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', binds };
}

function queueClause(key: ReviewQueueKey): { sql: string; binds: unknown[] } {
  const q = REVIEW_QUEUES.find((x) => x.key === key);
  if (!q) return { sql: '', binds: [] };
  return { sql: ` AND ${q.sql}`, binds: 'bind' in q && q.bind ? [q.bind] : [] };
}

export interface QueueCount {
  key: string;
  pending: number;
  done: number;
}

/** عدّادات الطوابير — استعلامٌ حيّ عند كل فتح، لا رقمٌ محفوظ. */
export async function reviewQueueCounts(env: Env, filters: ReviewFilters = {}): Promise<QueueCount[]> {
  const f = reviewFilterSql(filters);
  const out: QueueCount[] = [];
  for (const q of REVIEW_QUEUES) {
    const binds = 'bind' in q && q.bind ? [q.bind] : [];
    const row = await env.DB.prepare(
      `SELECT SUM(CASE WHEN ${IN_QUEUE_SQL} THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN ${QUEUE_DONE_SQL} THEN 1 ELSE 0 END) AS done
       FROM legal_chunks c WHERE ${q.sql}${f.sql}`
    )
      .bind(...binds, ...f.binds)
      .first<{ pending: number | null; done: number | null }>();
    out.push({ key: q.key, pending: row?.pending ?? 0, done: row?.done ?? 0 });
  }
  return out;
}

/**
 * مواد طابورٍ بعينه، أو الطابور كلَّه إن لم يُسمَّ.
 *
 * وأخوات الرقم الواحد تُجلب معاً: الحكم عليها لا يصحّ إلا مجتمعة — أهي مادةٌ
 * مضافة مشروعة أم خطأ تقطيع؟ لا يُعرف إلا بقراءة الاثنتين.
 */
export async function listReviewQueue(
  env: Env,
  opts: ReviewFilters & { queue?: ReviewQueueKey | null; offset?: number; limit?: number } = {}
): Promise<{ articles: LegalHit[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const f = reviewFilterSql(opts);
  const q = opts.queue ? queueClause(opts.queue) : { sql: '', binds: [] };
  const where = `${IN_QUEUE_SQL}${f.sql}${q.sql}`;
  const binds = [...f.binds, ...q.binds];

  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM legal_chunks c WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>();

  const rows = await env.DB.prepare(
    /* الترتيب بالخطورة قبل الترتيب بالموضع.
     *
     * المعطوب أوّلاً — نصٌّ لا يُقرأ محجوبٌ عن الباحث حتى يُبتّ فيه، فكلُّ
     * يومٍ يبقى فيه يومٌ تغيب فيه المادة. ثم الموسوم بتحذير — نصُّه قائم
     * والباحث يراه، فتأخيرُه أهون. ثم البقيّة بترتيب النظام.
     *
     * ولولا هذا لبقي الطابور مرتَّباً بالمعرّف، فيقضي المراجع جلسته في
     * تعديلاتٍ جماعية بينما مادةٌ تسرّبت إليها ديباجةٌ تنتظر في آخره. */
    `SELECT ${HIT_COLUMNS} FROM legal_chunks c WHERE ${where}
     ORDER BY c.has_defect DESC,
              CASE WHEN c.retrieval_status = '${RETRIEVAL_WARNING}' THEN 0 ELSE 1 END,
              c.law_id, c.seq
     LIMIT ? OFFSET ?`
  )
    .bind(...binds, limit, offset)
    .all<HitRow>();

  // أخوات الرقم تُضمّ بلا تصفية الطابور: أختُ المادة قد تكون معتمَدةً سلفاً،
  // والحكم على أختها لا يصحّ بغيابها.
  const articles = await expandDuplicates(env, (rows.results ?? []).map(toHit), {
    includeRepealed: true,
    includeDefective: true,
  });

  return { articles, total: total?.n ?? 0 };
}

/**
 * سقف ما يُجلب من معرّفات الطابور في نداءٍ واحد.
 *
 * لا لحماية الخادم — المعرّفات صفٌّ واحد لكلٍّ — بل لأن ما فوقه لا يُقرأ عدداً
 * في شاشة: من حدّد عشرة آلاف مادة لم يعد يقرّر، وإنما ضغط زرّاً.
 */
export const QUEUE_IDS_MAX = 5000;

/**
 * معرّفات الطابور كلِّه — لتحديدٍ يشمله لا يشمل صفحته.
 *
 * ويُجلب صريحاً ليعود إلى الخادم صريحاً: القرار يقع على معرّفاتٍ بأعيانها في
 * كل حال، فيبقى كلُّ اعتماد مقيَّداً وحده في سجلّ التدقيق، ويبقى العدد الذي
 * يراه المراجع قبل التأكيد هو العدد الذي يقع عليه القرار.
 *
 * والبديل — أن يقبل المسار «كل ما يطابق الشرط» — يُخفي العدد حتى بعد وقوعه.
 */
export async function listReviewQueueIds(
  env: Env,
  opts: ReviewFilters & { queue?: ReviewQueueKey | null } = {}
): Promise<{ ids: string[]; total: number; truncated: number }> {
  const f = reviewFilterSql(opts);
  const q = opts.queue ? queueClause(opts.queue) : { sql: '', binds: [] };
  const where = `${IN_QUEUE_SQL}${f.sql}${q.sql}`;
  const binds = [...f.binds, ...q.binds];

  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM legal_chunks c WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>();

  const rows = await env.DB.prepare(
    `SELECT c.id FROM legal_chunks c WHERE ${where} ORDER BY c.law_id, c.seq LIMIT ?`
  )
    .bind(...binds, QUEUE_IDS_MAX)
    .all<{ id: string }>();

  const ids = (rows.results ?? []).map((r) => r.id);
  return { ids, total: total?.n ?? 0, truncated: Math.max(0, (total?.n ?? 0) - ids.length) };
}

/**
 * نصّ التضمين المبنيّ من بنية المادة.
 *
 * صيغةٌ واحدة للمستورَد وللمحرَّر: لو بُني المحرَّر بصيغةٍ أخرى لصار جارُه في
 * الفهرس المتجهي مقيساً بمسطرةٍ ثانية، فتتغيّر رتبتُه لسببٍ لا علاقة له بنصّه.
 */
export function buildEmbedText(a: {
  law_title: string | null; instrument: string | null; book: string | null;
  chapter: string | null; article_title: string | null; article_no: string | null; text: string;
}): string {
  const head = [
    a.law_title,
    a.instrument ? `(${a.instrument})` : '',
    a.book,
    a.chapter,
    a.article_title,
    a.article_no ? `المادة ${a.article_no}` : '',
  ]
    .filter(Boolean)
    .join(' — ');
  return head ? `${head}: ${a.text}` : a.text;
}

export type ReviewAction = 'approve' | 'edit' | 'exclude' | 'defer' | 'note' | 'undo';

const ACTION_STATUS: Record<Exclude<ReviewAction, 'note' | 'undo'>, string> = {
  approve: 'approved',
  edit: 'edited',
  exclude: 'rejected',
  defer: 'deferred',
};

/** صفٌّ يحتاجه قرار المراجعة — ببنيته التي يُبنى منها نصّ التضمين. */
interface ReviewRow {
  id: string; law_id: string | null; law_title: string | null; instrument: string | null;
  book: string | null; chapter: string | null; article_title: string | null; article_no: string | null;
  text: string; text_original_import: string | null; review_status: string; review_note: string | null;
  needs_review: number;
  retrieval_status: string; retrieval_warning: string | null;
  has_amendments: number; amendment_applied: number;
}

export interface ReviewResult {
  ok: boolean;
  error?: string;
  status?: string;
  /** أُعيد بناء نصّ التضمين فصار المقطع ينتظر تضميناً جديداً. */
  reembedded?: boolean;
}

/**
 * قرارُ المراجع على مادة.
 *
 * كل تغيير يُقيَّد في سجلّ التدقيق بقيمته قبل وبعد وصاحبه ووقته: في منتجٍ
 * قانوني يُسأل المرء لاحقاً من أين جاء نصّ مادةٍ في استشارة ومن اعتمده.
 *
 * **والتحرير يُعيد بناء نصّ التضمين ومتجهه.** لولا ذلك لطابق البحثُ النصَّ
 * القديم بينما العرض يُظهر الجديد — وهو عيبٌ خبيث لا يظهر إلا في نتائج بحثٍ
 * غريبة يصعب تفسيرها.
 */
export async function reviewChunk(
  env: Env,
  id: string,
  action: ReviewAction,
  actorId: string,
  opts: { text?: string; note?: string; via?: 'single' | 'bulk' } = {}
): Promise<ReviewResult> {
  const row = await env.DB.prepare(
    `SELECT id, law_id, law_title, instrument, book, chapter, article_title, article_no,
            text, text_original_import, review_status, review_note, needs_review,
            retrieval_status, retrieval_warning, has_amendments, amendment_applied
     FROM legal_chunks WHERE id = ?`
  )
    .bind(id)
    .first<ReviewRow>();
  if (!row) return { ok: false, error: 'المادة غير موجودة' };

  const now = Date.now();
  const audit: { field: string; from: string | null; to: string | null }[] = [];
  const sets: string[] = [];
  const binds: unknown[] = [];
  let reembedded = false;

  const setText = (text: string) => {
    const embed = buildEmbedText({ ...row, text });
    sets.push(
      'text = ?', 'text_norm = ?', 'embed_text = ?', 'embed_hash = ?',
      // `embedded_at = NULL` يعيد المقطع إلى طابور التضمين، ويصرّفه النداء
      // الذي يلي الحفظ أو الـCron. وتحديث `text_norm` يُشغّل محفّز الفهرس
      // اللفظي من تلقائه — فالمساران يتجدّدان معاً.
      'embedded_at = NULL'
    );
    binds.push(text, normalizeArabic(text), embed, hashText(embed));
    audit.push({ field: 'text', from: row.text, to: text });
    reembedded = true;
  };

  if (action === 'note') {
    const note = opts.note?.trim() ?? '';
    sets.push('review_note = ?');
    binds.push(note || null);
    audit.push({ field: 'review_note', from: row.review_note, to: note || null });
  } else if (action === 'undo') {
    // التراجع يُرجع نصّ الاستيراد إن كان قد حُرِّر، ويُعيد المادة إلى الطابور.
    if (row.text_original_import && row.text_original_import !== row.text) {
      setText(row.text_original_import);
      sets.push('text_original_import = NULL');
    }
    sets.push('review_status = ?', 'reviewed_at = NULL', 'reviewed_by = NULL');
    binds.push(REVIEW_PENDING);
    audit.push({ field: 'review_status', from: row.review_status, to: REVIEW_PENDING });
    // وما صُعِّد يعود: التراجع عن الاعتماد تراجعٌ عن دعوى أن النصّ نافذ.
    // والحال التي يعود إليها تُشتقّ من الملف كما اشتُقّت عند الاستيراد — لا
    // من عمودٍ ثانٍ يحفظ ما كانت عليه، فمصدرا حقيقةٍ للحال الواحدة يفترقان.
    if (row.retrieval_status === RETRIEVAL_EFFECTIVE && row.has_amendments && !row.amendment_applied) {
      sets.push('retrieval_status = ?', 'retrieval_warning = ?');
      binds.push(RETRIEVAL_WARNING, AMENDMENT_NOTICE);
      audit.push({ field: 'retrieval_status', from: RETRIEVAL_EFFECTIVE, to: RETRIEVAL_WARNING });
    }
  } else {
    if (action === 'edit') {
      const text = opts.text?.trim() ?? '';
      if (!text) return { ok: false, error: 'نصّ المادة مطلوب' };
      if (text.length > MAX_TEXT_LEN) return { ok: false, error: 'نصّ المادة أطول من الحدّ المسموح' };
      if (text !== row.text) {
        // أصلُ الاستيراد يُكتب مرّةً واحدة: تحريرٌ ثانٍ لا يجعل الأصلَ آخرَ ما
        // حُرِّر، وإلا ضاع ما جاء من المصدر عند ثاني تصحيح.
        if (!row.text_original_import) {
          sets.push('text_original_import = ?');
          binds.push(row.text);
        }
        setText(text);
      }
    }
    const status = ACTION_STATUS[action];
    sets.push('review_status = ?', 'reviewed_at = ?', 'reviewed_by = ?');
    binds.push(status, now, actorId);
    audit.push({ field: 'review_status', from: row.review_status, to: status });

    /* **وتصعيدُ الحال لمن فتح المادة وحده.**
     *
     * إسقاط التحذير دعوى أن النصّ المعروض هو النافذ، ولا تصحّ إلا ممّن قرأ
     * ألواحه الثلاثة. والاعتماد جملةً يُخرج المادة من الطابور — وذاك قرارُ
     * ترتيبِ عمل — ولا يُسقط تحذيراً يقرؤه كلُّ محامٍ بعده. وضغطةٌ واحدة على
     * «تحديد الطابور كلَّه» كانت ستمحو مئتي تحذير بلا فتح مادة. */
    if (
      opts.via !== 'bulk' &&
      (status === 'approved' || status === 'edited') &&
      row.retrieval_status === RETRIEVAL_WARNING
    ) {
      sets.push('retrieval_status = ?', 'retrieval_warning = NULL');
      binds.push(RETRIEVAL_EFFECTIVE);
      audit.push({ field: 'retrieval_status', from: RETRIEVAL_WARNING, to: RETRIEVAL_EFFECTIVE });
    }
    // **ولا يُكتب `needs_review = 0`.** أثرُ الاعتماد — دخولُ المادة
    // الاسترجاع — يقع بالحال وحدها، وهي وحدها ما يُصفّى به. وكتابةُ الوسم
    // معها تُنشئ مصدرَ حقيقةٍ ثانياً لا يعرف التراجعُ كيف يردّه: يُعيد الحالَ
    // إلى الطابور ويترك الوسمَ مرفوعاً، فتبقى المادة في الاسترجاع بعد
    // التراجع عن اعتمادها. و`needs_review` يبقى ما قاله الملف، فإعادةُ رفعه
    // لا تناقض قراراً وقع.
    if (opts.note !== undefined) {
      const note = opts.note.trim();
      sets.push('review_note = ?');
      binds.push(note || null);
      if ((row.review_note ?? '') !== note) {
        audit.push({ field: 'review_note', from: row.review_note, to: note || null });
      }
    }
  }

  sets.push('updated_at = ?');
  binds.push(now);
  await env.DB.prepare(`UPDATE legal_chunks SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds, id)
    .run();

  for (let i = 0; i < audit.length; i += DB_BATCH) {
    await env.DB.batch(
      audit.slice(i, i + DB_BATCH).map((a) =>
        env.DB.prepare(
          `INSERT INTO legal_review_audit (id, chunk_id, law_id, field, old_value, new_value, actor_id, at, via)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(uuid(), id, row.law_id, a.field, a.from, a.to, actorId, now, opts.via ?? 'single')
      )
    );
  }

  const status = audit.find((a) => a.field === 'review_status')?.to ?? row.review_status;
  return { ok: true, status: status ?? undefined, reembedded };
}

export interface ReviewAuditEntry {
  id: string;
  chunk_id: string;
  law_id: string | null;
  field: string;
  old_value: string | null;
  new_value: string | null;
  actor_id: string | null;
  at: number;
  /** `single` قرارٌ فُتحت له المادة · `bulk` اعتُمدت ضمن محدَّدٍ جملةً. */
  via: string | null;
}

/**
 * سقفُ ما يُعتمد جملةً في نداءٍ واحد.
 *
 * بقدر صفحة الطابور لا أكثر: «تحديد الكل» تحدّد ما على الشاشة، فالسقف يقابل
 * ما تراه العين. وسقفٌ أوسع يفتح باباً لاعتماد الطابور كلِّه بنداءٍ واحد —
 * وهو ما لا تراه الشاشة ولا يقرأه أحد.
 */
export const BULK_LIMIT = 50;

export interface BulkResult {
  done: number;
  failed: { id: string; error: string }[];
  reembedded: boolean;
}

/**
 * قرارٌ واحد على موادّ محدَّدة بأعيانها.
 *
 * **بمعرّفاتها لا بشرطٍ يُطابقها.** نداءٌ يقبل «كل الطابور» يعتمد ما لم يُعرض
 * على أحد، والمعرّفات تأتي من صفوفٍ رآها المراجع وأشّر عليها بيده. وكلُّ مادة
 * تمرّ بالمسار المفرد نفسه: تُقيَّد وحدها في سجلّ التدقيق، ويُوسَم قيدُها
 * `bulk` فيُعرف لاحقاً أن الاعتماد وقع جملةً.
 *
 * والتحرير خارج هذا الباب: نصٌّ يُحرَّر يُحرَّر مادةً مادة.
 */
export async function reviewChunks(
  env: Env,
  ids: string[],
  action: Exclude<ReviewAction, 'edit'>,
  actorId: string,
  opts: { note?: string } = {}
): Promise<BulkResult> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  // ما زاد عن السقف يُردّ مذكوراً بمعرّفه لا يُقصّ صامتاً: قصٌّ خفيّ يجعل
  // المراجع يرى «تمّ» وقد بقي نصفُ ما حدّده بلا قرار، ولا شيء يدلّه عليه.
  const over = unique.slice(BULK_LIMIT);
  const failed: { id: string; error: string }[] = over.map((id) => ({
    id,
    error: `تجاوز سقف النداء الواحد (${BULK_LIMIT})`,
  }));
  let done = 0;
  let reembedded = false;
  for (const id of unique.slice(0, BULK_LIMIT)) {
    const res = await reviewChunk(env, id, action, actorId, { note: opts.note, via: 'bulk' });
    if (res.ok) {
      done++;
      reembedded ||= !!res.reembedded;
    } else {
      failed.push({ id, error: res.error ?? 'تعذّر القرار' });
    }
  }
  return { done, failed, reembedded };
}

/** سجلّ التدقيق: لمادةٍ بعينها، أو لآخر ما وقع في المنصة كلّها. */
export async function listReviewAudit(
  env: Env,
  opts: { chunkId?: string | null; limit?: number } = {}
): Promise<ReviewAuditEntry[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = opts.chunkId
    ? await env.DB.prepare(
        'SELECT * FROM legal_review_audit WHERE chunk_id = ? ORDER BY at DESC, rowid DESC LIMIT ?'
      )
        .bind(opts.chunkId, limit)
        .all<ReviewAuditEntry>()
    : await env.DB.prepare('SELECT * FROM legal_review_audit ORDER BY at DESC, rowid DESC LIMIT ?')
        .bind(limit)
        .all<ReviewAuditEntry>();
  return rows.results ?? [];
}

export interface ReviewDashboard {
  chunks: number;
  retrievable: number;
  in_queue: number;
  approved: number;
  edited: number;
  rejected: number;
  deferred: number;
  repealed: number;
  last_activity: number | null;
  queues: QueueCount[];
}

/**
 * لوحة الحال: أين وصلت المراجعة، وأيّ طابورٍ يستحقّ الجلسة القادمة.
 *
 * و«الداخلة في الاسترجاع» تُحسب بالشرطين اللذين يُصفّى بهما الاسترجاع نفسه
 * لا بجمعٍ يدويّ — فلو تغيّر أحدهما تغيّر الرقم معه، ولا تقول اللوحة شيئاً
 * لا يقوله البحث.
 */
export async function reviewDashboard(env: Env, filters: ReviewFilters = {}): Promise<ReviewDashboard> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS chunks,
            SUM(CASE WHEN ${EFFECTIVE_SQL} AND ${SOUND_SQL} THEN 1 ELSE 0 END) AS retrievable,
            SUM(CASE WHEN ${IN_QUEUE_SQL} THEN 1 ELSE 0 END) AS in_queue,
            SUM(CASE WHEN c.review_status = 'approved' THEN 1 ELSE 0 END) AS approved,
            SUM(CASE WHEN c.review_status = 'edited' THEN 1 ELSE 0 END) AS edited,
            SUM(CASE WHEN c.review_status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
            SUM(CASE WHEN c.review_status = 'deferred' THEN 1 ELSE 0 END) AS deferred,
            SUM(CASE WHEN c.is_repealed = 1 OR c.status = 'repealed' THEN 1 ELSE 0 END) AS repealed
     FROM legal_chunks c`
  ).first<Omit<ReviewDashboard, 'last_activity' | 'queues'>>();

  const last = await env.DB.prepare('SELECT MAX(at) AS at FROM legal_review_audit').first<{ at: number | null }>();

  return {
    chunks: row?.chunks ?? 0,
    retrievable: row?.retrievable ?? 0,
    in_queue: row?.in_queue ?? 0,
    approved: row?.approved ?? 0,
    edited: row?.edited ?? 0,
    rejected: row?.rejected ?? 0,
    deferred: row?.deferred ?? 0,
    repealed: row?.repealed ?? 0,
    last_activity: last?.at ?? null,
    queues: await reviewQueueCounts(env, filters),
  };
}

/** دفعات الاستيراد المتاحة للترشيح — من `captured_at` كما ورد. */
export async function listCaptureBatches(env: Env): Promise<{ captured_at: string; chunks: number }[]> {
  const rows = await env.DB.prepare(
    `SELECT captured_at, COUNT(*) AS chunks FROM legal_chunks
     WHERE captured_at IS NOT NULL AND captured_at <> ''
     GROUP BY captured_at ORDER BY captured_at DESC LIMIT 50`
  ).all<{ captured_at: string; chunks: number }>();
  return rows.results ?? [];
}

export interface LawSummary {
  law_id: string;
  law_title: string | null;
  parent_law_id: string | null;
  doc_type: string | null;
  /** نوع أداة الإصدار: مرسوم ملكي، قرار مجلس الوزراء… */
  instrument: string | null;
  instrument_no: string | null;
  /** الجهة صاحبة النظام. */
  authority: string | null;
  issue_date: string | null;
  issue_date_hijri: string | null;
  source_url: string | null;
  chunks: number;
  effective: number;
  repealed: number;
}

/**
 * الأنظمة المستوردة وحالُ كلٍّ منها.
 *
 * `MAX` على حقول النظام لا لأنها تتفاوت بين مواده — هي واحدة لكلّها — بل
 * لأن التجميع يفرض دالّة. وأوّل ما يتفاوت منها يظهر خللاً في الملف لا هنا.
 */
export async function listLaws(env: Env): Promise<LawSummary[]> {
  const rows = await env.DB.prepare(
    `SELECT c.law_id AS law_id,
            MAX(c.law_title) AS law_title,
            MAX(c.parent_law_id) AS parent_law_id,
            MAX(c.doc_type) AS doc_type,
            MAX(c.instrument) AS instrument,
            MAX(c.instrument_no) AS instrument_no,
            MAX(c.authority) AS authority,
            MAX(c.issue_date) AS issue_date,
            MAX(c.issue_date_hijri) AS issue_date_hijri,
            MAX(c.source_url) AS source_url,
            COUNT(*) AS chunks,
            SUM(CASE WHEN ${EFFECTIVE_SQL} THEN 1 ELSE 0 END) AS effective,
            SUM(CASE WHEN c.is_repealed = 1 OR c.status = 'repealed' THEN 1 ELSE 0 END) AS repealed
     FROM legal_chunks c
     WHERE c.law_id IS NOT NULL
     GROUP BY c.law_id
     ORDER BY law_title`
  ).all<LawSummary>();
  return rows.results ?? [];
}

/**
 * مواد نظامٍ بعينه، مرتّبةً كما وردت في ملفه.
 *
 * الترتيب بـ`seq` لا برقم المادة: الأرقام نصوصٌ قد تكون «٧٤ مكرر» أو
 * «الأولى»، وترتيبها نصّياً يقلب النظام على قارئه. و`seq` ترتيبُ الاستيراد،
 * وهو ترتيب الملف، وهو ترتيب النظام كما صدر.
 */
export async function listLawArticles(
  env: Env,
  lawId: string,
  opts: { offset?: number; limit?: number; includeRepealed?: boolean } = {}
): Promise<{ articles: LegalHit[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  // المنسوخة والمحجوبة للمراجعة تُعرضان في التصفّح افتراضياً: هذه شاشةُ
  // اطّلاعٍ على النظام كما هو لا مسارُ استشهاد، وإخفاؤهما يجعل ترقيم المواد
  // يقفز بلا تفسير. وشارةُ كلٍّ منهما تقول لماذا لا تصلح للاستشهاد.
  const filters = buildFilters({
    lawId,
    withRegulations: false,
    includeRepealed: opts.includeRepealed !== false,
    includeDefective: true,
  });

  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM legal_chunks c WHERE 1 = 1${filters.sql}`)
    .bind(...filters.binds)
    .first<{ n: number }>();

  const rows = await env.DB.prepare(
    `SELECT ${HIT_COLUMNS} FROM legal_chunks c WHERE 1 = 1${filters.sql} ORDER BY c.seq LIMIT ? OFFSET ?`
  )
    .bind(...filters.binds, limit, offset)
    .all<HitRow>();

  return { articles: (rows.results ?? []).map(toHit), total: total?.n ?? 0 };
}

/** نظامٌ مع لوائحه — العلاقة عبر `parent_law_id`. */
export async function getLawWithRegulations(
  env: Env,
  lawId: string
): Promise<{ law: LawSummary | null; regulations: LawSummary[] }> {
  const laws = await listLaws(env);
  return {
    law: laws.find((l) => l.law_id === lawId) ?? null,
    regulations: laws.filter((l) => l.parent_law_id === lawId),
  };
}

export interface LegalStats {
  chunks: number;
  effective: number;
  repealed: number;
  laws: number;
  pending_embeddings: number;
  vectorize: boolean;
  /** محجوبٌ عن الاسترجاع حتى يعتمده إنسان. */
  needs_review: number;
  /** مادةٌ عُدِّلت ونصُّها المعروض أصليّ — تُعرض مع تنبيهها. */
  amendment_pending: number;
  /** توزيعُ حالِ الاسترجاع — يُقابَل ببيان الدفعة. */
  retrieval: { effective: number; warning: number; repealed: number };
  /** ما يستحقّ متجهاً: كلُّ ما ليس ملغىً. */
  indexed: number;
  /** يستحقّ متجهاً ولم يُضمَّن بعد. */
  missing_vector: number;
  /** ضُمِّن ولم يعد يستحقّ — يجب أن يبقى صفراً. */
  stale_vector: number;
  /** معطوبٌ محجوبٌ ينتظر البتّ. */
  defective: number;
}

/**
 * صحّة القاعدة — استعلامٌ حيّ لا رقمٌ ثابت.
 *
 * يُقارَن ببيان الدفعة الذي طبعه `verify-legal.mjs`: السجلات والأنظمة وتوزيع
 * الحالات وما يُفهرَس. ورقمٌ مكتوبٌ في وثيقة يتقادم مع أوّل دفعة، فيُقارَن به
 * ويُظَنّ الاستيراد ناقصاً — ولذلك يُقرأ من القاعدة في كل فتحة.
 */
export async function legalStats(env: Env): Promise<LegalStats> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS chunks,
            SUM(CASE WHEN ${EFFECTIVE_SQL} THEN 1 ELSE 0 END) AS effective,
            SUM(CASE WHEN c.is_repealed = 1 OR c.status = 'repealed' THEN 1 ELSE 0 END) AS repealed,
            COUNT(DISTINCT c.law_id) AS laws,
            -- ما ينتظر التضمين فعلاً: بالشرط الذي يختار به embedPending لا
            -- بـ embedded_at IS NULL وحده. والفرق ليس تجميلاً:
            --
            -- المادة الملغاة لا تُضمَّن بالتصميم — EMBEDDABLE_SQL يستثنيها،
            -- و purgeRepealedVectors يحذف متجهها إن كان. فعدُّها «تنتظر
            -- التضمين» يعرض على المسؤول عدداً لا يُنقصه شيء: يضغط «تضمين الآن»
            -- فيدور ثم يقف بلا تغيير، ويعيد الضغط ويظنّ التضمين معطَّلاً —
            -- والطابور فارغ من أوّله.
            --
            -- والعددُ المعروض هو ما يعمل عليه الزرّ، وإلا فهو ليس عدّاً بل لغز.
            SUM(CASE WHEN ${EMBEDDABLE_SQL_C} AND c.embedded_at IS NULL THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN ${IN_QUEUE_SQL} THEN 1 ELSE 0 END) AS needs_review,
            SUM(CASE WHEN c.has_amendments = 1 AND c.amendment_applied = 0 THEN 1 ELSE 0 END) AS amendment_pending,
            -- توزيعُ حالِ الاسترجاع: الحقل الذي يُبنى عليه القرار، فتوزيعُه
            -- هو ما يُقابَل ببيان الدفعة لا العدد الإجمالي وحده.
            SUM(CASE WHEN c.retrieval_status = '${RETRIEVAL_EFFECTIVE}' THEN 1 ELSE 0 END) AS r_effective,
            SUM(CASE WHEN c.retrieval_status = '${RETRIEVAL_WARNING}' THEN 1 ELSE 0 END) AS r_warning,
            SUM(CASE WHEN c.retrieval_status = '${RETRIEVAL_REPEALED}' THEN 1 ELSE 0 END) AS r_repealed,
            -- ومقياسا المتجه: ما يستحقّه ولم يُضمَّن بعد، وما ضُمِّن وهو لا
            -- يستحقّه. الثاني صفرٌ دائماً إن عمل التنظيف، وارتفاعُه إنذار.
            SUM(CASE WHEN ${EMBEDDABLE_SQL_C} AND c.embedded_at IS NULL THEN 1 ELSE 0 END) AS missing_vector,
            SUM(CASE WHEN NOT (${EMBEDDABLE_SQL_C}) AND c.embedded_at IS NOT NULL THEN 1 ELSE 0 END) AS stale_vector,
            SUM(CASE WHEN c.has_defect = 1 AND c.review_status = 'pending' THEN 1 ELSE 0 END) AS defective
     FROM legal_chunks c`
  ).first<{
    chunks: number; effective: number; repealed: number; laws: number; pending: number;
    needs_review: number; amendment_pending: number;
    r_effective: number; r_warning: number; r_repealed: number;
    missing_vector: number; stale_vector: number; defective: number;
  }>();

  return {
    chunks: row?.chunks ?? 0,
    effective: row?.effective ?? 0,
    repealed: row?.repealed ?? 0,
    laws: row?.laws ?? 0,
    pending_embeddings: row?.pending ?? 0,
    vectorize: !!env.VECTORIZE,
    needs_review: row?.needs_review ?? 0,
    amendment_pending: row?.amendment_pending ?? 0,
    retrieval: {
      effective: row?.r_effective ?? 0,
      warning: row?.r_warning ?? 0,
      repealed: row?.r_repealed ?? 0,
    },
    indexed: (row?.chunks ?? 0) - (row?.r_repealed ?? 0),
    missing_vector: row?.missing_vector ?? 0,
    stale_vector: row?.stale_vector ?? 0,
    defective: row?.defective ?? 0,
  };
}
