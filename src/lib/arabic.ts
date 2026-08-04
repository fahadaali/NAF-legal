// التطبيع العربي للبحث اللفظي.
//
// بلا هذا لا تطابق «الاجراءات» «الإجراءات»، ولا «الغرامه» «الغرامة»، ولا
// «المدعي» «المدعى». والمستخدم يكتب بلا همزات وبلا تشكيل، والنصّ الرسمي
// مشكولٌ منقوط، فالمطابقة الحرفية بينهما تفشل في أكثر الاستعلامات شيوعاً.
//
// يُطبَّق على طرفَي المقارنة معاً: على النصّ عند الاستيراد (يُخزَّن في
// `text_norm`) وعلى الاستعلام عند البحث. وتطبيقه على طرف واحد أسوأ من تركه.
//
// ولا يمسّ ما يُعرض: `text` يُخزَّن كما ورد ويُستشهد به كما ورد.

/** حروف التشكيل والعلامات القرآنية — تُحذف. */
const DIACRITICS = /[ً-ْٓ-ٰٕۖ-ۭ]/g;
/** التطويل — زخرفة لا معنى لها في المطابقة. */
const TATWEEL = /ـ/g;
/** الأرقام العربية-الهندية بشكليها → غربية (والعرض غربيٌّ أصلاً). */
const ARABIC_INDIC = /[٠-٩۰-۹]/g;

/**
 * يطبّع نصاً عربياً للمطابقة اللفظية.
 *
 * - توحيد الهمزات: آ أ إ ٱ → ا ، ؤ → و ، ئ → ي
 * - التاء المربوطة: ة → ه
 * - الألف المقصورة: ى → ي
 * - حذف التشكيل والتطويل
 * - الأرقام غربية
 *
 * والهمزة المفردة «ء» تبقى: حذفها يجعل «جزء» و«جز» شيئاً واحداً.
 */
export function normalizeArabic(input: string): string {
  return (input ?? '')
    .normalize('NFKC')
    .replace(DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(/[آأإٱ]/g, 'ا') // آ أ إ ٱ → ا
    .replace(/ؤ/g, 'و') // ؤ → و
    .replace(/ئ/g, 'ي') // ئ → ي
    .replace(/ة/g, 'ه') // ة → ه
    .replace(/ى/g, 'ي') // ى → ي
    .replace(ARABIC_INDIC, (d) => String(d.codePointAt(0)! & 0x0f))
    .replace(/\s+/g, ' ')
    .trim();
}

/** كلمات وظيفية تُسقَط من الاستعلام: وجودها في كل مادة يجعلها بلا قيمة تمييزية. */
const STOPWORDS = new Set(
  [
    'من', 'في', 'على', 'عن', 'إلى', 'الى', 'أن', 'ان', 'إن', 'ما', 'هذا', 'هذه',
    'ذلك', 'التي', 'الذي', 'مع', 'أو', 'او', 'ثم', 'قد', 'كل', 'بين', 'عند',
    'حتى', 'لا', 'هو', 'هي', 'به', 'بها', 'له', 'لها', 'إذا', 'اذا', 'كما',
    'وفق', 'وفقا', 'بشأن', 'هل', 'ماذا', 'كيف', 'أي', 'اي',
  ].map(normalizeArabic)
);

/** يقسّم النصّ المطبَّع إلى كلمات — كل ما ليس حرفاً ولا رقماً فاصل. */
export function tokenize(input: string): string[] {
  const normalized = normalizeArabic(input);
  if (!normalized) return [];
  return normalized.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
}

/**
 * صيغتا الكلمة: بأل التعريف وبدونها.
 *
 * النصّ الرسمي يقول «الإجراءات» والمستخدم يكتب «إجراءات»، والعكس. فتُولَّد
 * الصيغتان من طرف الاستعلام وحده — أرخص من فهرسة الصيغتين لكل كلمة في النصّ.
 * والشرط على الطول يمنع «الله» → «له» و«التي» → «تي».
 */
function articleVariants(token: string): string[] {
  if (token.startsWith('ال') && token.length >= 5) return [token, token.slice(2)];
  if (!token.startsWith('ال') && token.length >= 3 && /^\p{L}/u.test(token)) return [token, `ال${token}`];
  return [token];
}

/** يقتبس كلمة لتعبير MATCH — التقطيع لا يُبقي علامات اقتباس، والمضاعفة احتياط. */
function quote(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * يبني تعبير `MATCH` لـ FTS5 من استعلام المستخدم.
 *
 * الدمج بـ OR لا AND: استعلام المحامي جملةٌ لا مجموعة شروط، وطلب حضور كل
 * كلماته يعيد صفراً في أكثر الحالات. والترتيب يتكفّل به bm25 فيقدّم ما طابق
 * أكثر كلمات وأندرها.
 *
 * ويعيد `null` إن لم يبقَ من الاستعلام ما يُبحث به — فلا يُستدعى SQL أصلاً.
 */
export function ftsMatchExpression(query: string): string | null {
  const tokens = tokenize(query);
  if (!tokens.length) return null;
  const meaningful = tokens.filter((t) => !STOPWORDS.has(t));
  const chosen = meaningful.length ? meaningful : tokens;
  const groups = chosen.map((t) => {
    const variants = articleVariants(t).map(quote);
    return variants.length > 1 ? `(${variants.join(' OR ')})` : variants[0];
  });
  return groups.join(' OR ');
}

/**
 * يستخرج رقم المادة من استعلام مثل «ما نصّ المادة (74) من نظام العمل؟».
 *
 * يُطبَّع الاستعلام أولاً فتصير «المادة ٧٤» رقماً غربياً قابلاً للمطابقة.
 */
export function extractArticleNo(query: string): string | null {
  const normalized = normalizeArabic(query);
  const m = normalized.match(/(?:الماده|ماده)\s*(?:رقم\s*)?\(?\s*(\d{1,4})\s*\)?/);
  return m ? m[1] : null;
}

/**
 * يطبّع رقم المادة للتخزين والمطابقة.
 *
 * ما فيه أرقام يُختزل إلى أرقامه («المادة (74)» و«٧٤» و«74» شيء واحد)، وما
 * لا رقم فيه («الرابعة والسبعون») يُطبَّع نصّاً.
 */
export function normalizeArticleNo(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const normalized = normalizeArabic(String(raw));
  if (!normalized) return null;
  const digits = normalized.match(/\d+/g);
  if (digits?.length) return digits.join('/');
  return normalized;
}

/**
 * صيغ الحرف العربي الواحد كما تُكتب فعلاً.
 *
 * المفتاح هو الحرف بعد التطبيع، والقيمة صنفُ ما يقابله في نصٍّ لم يُطبَّع.
 */
const LETTER_CLASSES: Record<string, string> = {
  ا: 'اأإآٱ',
  ه: 'هة',
  ي: 'يى',
  و: 'وؤ',
};

/** يُهرَّب ما له معنى في GLOB: النجمة وعلامة الاستفهام والقوس. */
function globEscape(ch: string): string {
  return '*?['.includes(ch) ? `[${ch}]` : ch;
}

/**
 * يبني نمط `GLOB` يطابق الكلمة بكل صور همزاتها.
 *
 * جداول المحادثات والمخرجات نصوصٌ خام لا عمود مطبَّع فيها — بخلاف المحتوى
 * النظامي المفهرس لفظياً. فبدل تطبيع الطرفين يُوسَّع طرفُ الاستعلام: تُكتب
 * كل ألفٍ صنفاً يقبل «أ إ آ ٱ»، وكل هاءٍ يقبل التاء المربوطة، وهكذا.
 *
 * و`GLOB` لا `LIKE`: الأخير لا يعرف أصناف الحروف، وكلاهما يمسح الجدول
 * فلا فرق في الكلفة.
 */
export function arabicGlobPattern(token: string): string {
  const body = Array.from(normalizeArabic(token))
    .map((ch) => {
      const klass = LETTER_CLASSES[ch];
      return klass ? `[${klass}]` : globEscape(ch);
    })
    .join('');
  return `*${body}*`;
}

/** أنماط `GLOB` لكلمات الاستعلام كلِّها — تُطابَق مجتمعةً لا متفرّقة. */
export function arabicGlobPatterns(query: string, max = 6): string[] {
  return tokenize(query).slice(0, max).map(arabicGlobPattern);
}
