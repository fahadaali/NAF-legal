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
 * التصفية الافتراضية الإلزامية.
 *
 * الشرطان معاً لا أحدهما: من رفع الملف قد يكتب `is_repealed: true` وينسى
 * `status`، أو العكس. وأيّهما قال «منسوخ» كفى لإخراج المادة من النتائج —
 * الاتجاه الآمن، فمادةٌ غائبة أهون من مادة منسوخة يُستشهد بها.
 */
const EFFECTIVE_SQL = `c.is_repealed = 0 AND c.status IN ('active','amended')`;

/**
 * الحجب المشروط: مادةٌ موسومة للمراجعة لا تدخل الاسترجاع الآلي حتى يعتمدها
 * إنسان.
 *
 * وهو غير الاستبعاد التام أعلاه: المنسوخة خرجت من النظام فلا تُستشهد أبداً،
 * وهذه نصٌّ لم يُتحقَّق منه بعد — تبقى في القاعدة وتظهر في شاشة المراجعة
 * والتصفّح، ولا تصل إلى إجابةٍ ولا إلى تقرير.
 *
 * والشرطان مستقلّان: تجاوزُ أحدهما لا يفتح الآخر.
 */
const REVIEWED_SQL = `(c.needs_review = 0 OR c.reviewed_at IS NOT NULL)`;

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
    c.amendment_instrument, c.amended_on, c.amendments_count, c.amend_note,
    c.meta_json`;

/** سقف طول مدخل التضمين. تجاوزُه يقصّ **مدخل المتجه وحده** ولا يقسم المقطع. */
const EMBED_MAX_CHARS = 8000;

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
  /** وقت اعتماد المراجع البشري — `null` يعني أن الحجب ما زال قائماً. */
  reviewedAt: number | null;
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
  amendment_applied: number;
  needs_review: number;
  amendment_instrument: string | null;
  amended_on: string | null;
  amendments_count: number | null;
  amendments_raw: string | null;
  amend_note: string | null;
  embed_text: string;
  text_norm: string;
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
  const docType = str(o.doc_type) || null;
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
    amendment_applied: truthy(o.amendment_applied) ? 1 : 0,
    needs_review: truthy(o.needs_review) ? 1 : 0,
    amendment_instrument: str(o.amendment_instrument) || null,
    amended_on: str(o.amended_on) || null,
    amendments_count: num(o.amendments_count),
    amendments_raw: amendmentsRaw,
    amend_note: str(o.amend_note) || null,
    embed_text: embedText,
    text_norm: normalizeArabic(text),
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
      `SELECT id, article_no, status, is_repealed, instrument_no, issue_date, issue_date_hijri, text, law_id,
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
    has_amendments, amendment_kind, amendment_applied, needs_review,
    amendment_instrument, amended_on, amendments_count, amendments_raw, amend_note,
    embed_text, text_norm, handle_norm, meta_json, embed_hash, embedded_at, imported_at, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)
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
    amendment_applied = excluded.amendment_applied,
    needs_review = excluded.needs_review,
    amendment_instrument = excluded.amendment_instrument,
    amended_on = excluded.amended_on,
    amendments_count = excluded.amendments_count,
    amendments_raw = excluded.amendments_raw,
    amend_note = excluded.amend_note,
    embed_text = excluded.embed_text,
    text_norm = excluded.text_norm,
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
  opts: { importId?: string; correction?: boolean } = {}
): Promise<{ inserted: number; updated: number; archived: number; superseded: number }> {
  if (!rows.length) return { inserted: 0, updated: 0, archived: 0, superseded: 0 };
  const now = Date.now();

  // معرفة الجديد من المستبدَل قبل الكتابة — ليقول التقرير أيّهما وقع.
  // وفي الطريق نفسه تُؤرشَف المواد التي تغيّر نصُّها أو رقمها أو حالتها:
  // الكتابة فوق نصٍّ نظاميّ بلا أثرٍ له تُفقد ما كان معمولاً به وقت الواقعة.
  const existing = await fetchExisting(env, rows.map((r) => r.id));
  const archivedHashes = await fetchArchivedHashes(env, rows.map((r) => r.id));
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
          r.has_amendments, r.amendment_kind, r.amendment_applied, r.needs_review,
          r.amendment_instrument, r.amended_on, r.amendments_count, r.amendments_raw, r.amend_note,
          r.embed_text, r.text_norm, r.handle_norm, r.meta_json, r.embed_hash, now, now
        )
      )
    );
  }

  return { inserted: rows.length - updated, updated, archived, superseded };
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
  origin: 'displaced' | 'superseded';
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
  /** سبب التخطّي إن لم يُنفَّذ التضمين — الفهرس المتجهي غير مهيّأ. */
  skipped?: string;
}

/**
 * يحوّل `embed_text` للمقاطع التي تنتظر، دفعةً بعد دفعة.
 *
 * ولا يمسّ `text`: هو للعرض والاستشهاد ولا يدخل نموذج التضمين.
 */
export async function embedPending(env: Env, limit = 200): Promise<EmbedResult> {
  const pendingCount = async () => {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM legal_chunks WHERE embedded_at IS NULL')
      .first<{ n: number }>();
    return row?.n ?? 0;
  };

  if (!env.VECTORIZE) {
    // بلا فهرس متجهي يبقى البحث اللفظي عاملاً وحده — استرجاعٌ أضعف، لا معطَّل.
    return { embedded: 0, remaining: await pendingCount(), skipped: 'الفهرس المتجهي غير مهيّأ' };
  }

  const rows = await env.DB.prepare(
    `SELECT seq, embed_text, law_id, doc_type, status, is_repealed, article_no_norm
     FROM legal_chunks WHERE embedded_at IS NULL ORDER BY seq LIMIT ?`
  )
    .bind(limit)
    .all<{
      seq: number; embed_text: string; law_id: string | null; doc_type: string | null;
      status: string; is_repealed: number; article_no_norm: string | null;
    }>();

  const pending = rows.results ?? [];
  let embedded = 0;
  const AI_BATCH = 20;

  for (let i = 0; i < pending.length; i += AI_BATCH) {
    const slice = pending.slice(i, i + AI_BATCH);
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
    const now = Date.now();
    await env.DB.batch(
      slice.map((r) => env.DB.prepare('UPDATE legal_chunks SET embedded_at = ? WHERE seq = ?').bind(now, r.seq))
    );
    embedded += slice.length;
  }

  return { embedded, remaining: await pendingCount() };
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
   * تجاوز الحجب المشروط: إظهار ما ينتظر المراجعة البشرية.
   *
   * لشاشة المراجعة وتصفّح النظام وحدهما. والاسترجاع الآلي — محادثةً كان أو
   * تقريراً أو أتمتة — لا يمرّره أبداً: التصنيف الآلي يقترح ولا يقرّر، وما
   * لم يعتمده إنسان لا يُستشهد به.
   */
  includeNeedsReview?: boolean;
}

function buildFilters(f: LegalFilters): { sql: string; binds: unknown[] } {
  const clauses: string[] = [];
  const binds: unknown[] = [];

  if (!f.includeRepealed) clauses.push(EFFECTIVE_SQL);
  if (!f.includeNeedsReview) clauses.push(REVIEWED_SQL);

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
    clauses.push('c.doc_type = ?');
    binds.push(f.docType);
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
    reviewedAt: r.reviewed_at,
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
    includeNeedsReview?: boolean;
    docType?: string | null;
  }
): Promise<LegalHit[]> {
  const scope: LegalFilters = {
    lawId: opts.lawId,
    docType: opts.docType ?? null,
    withRegulations: false,
    includeRepealed: opts.includeRepealed,
    includeNeedsReview: opts.includeNeedsReview,
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
  includeNeedsReview = false
): Promise<LegalHit | null> {
  const filters = buildFilters({ includeRepealed, includeNeedsReview });
  const row = await env.DB.prepare(
    `SELECT ${HIT_COLUMNS} FROM legal_chunks c WHERE c.id = ?${filters.sql} LIMIT 1`
  )
    .bind(id, ...filters.binds)
    .first<HitRow>();
  return row ? toHit(row) : null;
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
}

export async function getChunkAmendment(env: Env, id: string): Promise<ChunkAmendment | null> {
  return env.DB.prepare(
    `SELECT id, amendment_kind, amendment_applied, amendment_instrument, amended_on,
            amendments_count, amendments_raw, amend_note, text_superseded
     FROM legal_chunks WHERE id = ? LIMIT 1`
  )
    .bind(id)
    .first<ChunkAmendment>();
}

// ── المراجعة البشرية ──

/**
 * ما ينتظر المراجعة: المحجوب عن الاسترجاع حتى يعتمده إنسان.
 *
 * وهي الشاشة الوحيدة التي تراه. أمّا البحث والمحادثة والتقارير فلا يصلها،
 * لأن `needs_review` تُصفّى في SQL لا في الواجهة.
 */
export async function listReviewQueue(
  env: Env,
  opts: { lawId?: string | null; offset?: number; limit?: number } = {}
): Promise<{ articles: LegalHit[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where = ['c.needs_review = 1', 'c.reviewed_at IS NULL'];
  const binds: unknown[] = [];
  if (opts.lawId) {
    where.push('c.law_id = ?');
    binds.push(opts.lawId);
  }
  const sql = where.join(' AND ');

  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM legal_chunks c WHERE ${sql}`)
    .bind(...binds)
    .first<{ n: number }>();

  const rows = await env.DB.prepare(
    `SELECT ${HIT_COLUMNS} FROM legal_chunks c WHERE ${sql} ORDER BY c.law_id, c.seq LIMIT ? OFFSET ?`
  )
    .bind(...binds, limit, offset)
    .all<HitRow>();

  return { articles: (rows.results ?? []).map(toHit), total: total?.n ?? 0 };
}

/**
 * اعتمادُ مادةٍ أو ردُّها إلى الحجب.
 *
 * الاعتماد يرفع الحجب عن هذه المادة وحدها — لا عن نظامها ولا عن نوعها. ولا
 * يمسّ `needs_review` نفسه: ذاك ما قاله الملف، وتغييرُه اختلاقٌ لبيانات لم
 * تُرسَل، ويجعل إعادة الرفع تُعيد الحجب كأن المراجعة لم تقع.
 */
export async function setChunkReviewed(
  env: Env,
  id: string,
  reviewed: boolean,
  actorId: string
): Promise<boolean> {
  const found = await env.DB.prepare('SELECT 1 AS found FROM legal_chunks WHERE id = ?').bind(id).first();
  if (!found) return false;
  const now = Date.now();
  await env.DB.prepare('UPDATE legal_chunks SET reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ?')
    .bind(reviewed ? now : null, reviewed ? actorId : null, now, id)
    .run();
  return true;
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
    includeNeedsReview: true,
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
}

export async function legalStats(env: Env): Promise<LegalStats> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS chunks,
            SUM(CASE WHEN ${EFFECTIVE_SQL} THEN 1 ELSE 0 END) AS effective,
            SUM(CASE WHEN c.is_repealed = 1 OR c.status = 'repealed' THEN 1 ELSE 0 END) AS repealed,
            COUNT(DISTINCT c.law_id) AS laws,
            SUM(CASE WHEN c.embedded_at IS NULL THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN c.needs_review = 1 AND c.reviewed_at IS NULL THEN 1 ELSE 0 END) AS needs_review,
            SUM(CASE WHEN c.has_amendments = 1 AND c.amendment_applied = 0 THEN 1 ELSE 0 END) AS amendment_pending
     FROM legal_chunks c`
  ).first<{
    chunks: number; effective: number; repealed: number; laws: number; pending: number;
    needs_review: number; amendment_pending: number;
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
  };
}
