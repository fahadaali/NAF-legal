/**
 * قالب المستند: الخط والأحجام ونطاق الكتابة ورأسية الشركة.
 *
 * موضعٌ واحد يقرأه قالبا Word والطباعة معاً. وكانا يختلفان: Word بخط Arial
 * وهوامش بوصة، والطباعة بـ Segoe UI وحشوٍ بالبكسل ولا رأسية أصلاً — فمستندان
 * من مسودّةٍ واحدة لا يشبه أحدهما الآخر.
 */
import type { Env } from '../types';

export interface DocTemplate {
  /** اسم عائلة الخط كما يُكتب في Word وفي CSS معاً. */
  fontFamily: string;
  /** حجم العنوان الرئيس بالنقاط — وما دونه يُشتقّ منه. */
  headingPt: number;
  /** حجم المتن بالنقاط. */
  bodyPt: number;
  /** نطاق الكتابة: ما يُترك للرأسية أعلى الصفحة وللذيل أسفلها وللجانبين. */
  marginTopMm: number;
  marginBottomMm: number;
  marginSideMm: number;
}

/**
 * الافتراضيات من هوية ناف: العائلة المسجَّلة، وحجما العنوان والمتن من سلّم
 * الخطوط، وهوامش تكفي رأسية A4 معتادة (رأسٌ نحو أربعة سنتيمترات، وذيلٌ نحو
 * ثلاثة). والمنصّة تعمل بها دون أن يضبط المسؤول شيئاً.
 */
export const DOC_TEMPLATE_DEFAULTS: DocTemplate = {
  fontFamily: 'IBM Plex Sans Arabic',
  headingPt: 16,
  bodyPt: 12,
  marginTopMm: 45,
  marginBottomMm: 30,
  marginSideMm: 20,
};

/** مفاتيح `app_settings` — والأسماء هي ما يُرسله نموذج الإعدادات. */
export const DOC_TEMPLATE_KEYS = [
  'doc_font_family',
  'doc_heading_pt',
  'doc_body_pt',
  'doc_margin_top_mm',
  'doc_margin_bottom_mm',
  'doc_margin_side_mm',
] as const;

/**
 * الحدود تُطبَّق هنا لا في الشاشة.
 *
 * قيمةٌ خارجة عن الحدّ تُخرج مستنداً لا يُقرأ — هامشٌ ٩٠٠ ملّيمتر لا يترك سطراً،
 * وحجمُ خطٍّ صفريّ يُخفي المتن كلّه. والشاشة تمنعها، لكن الحقول تُكتب في
 * القاعدة من مسارٍ برمجيّ أيضاً.
 */
export function normalizeDocTemplate(raw: Record<string, string | undefined>): DocTemplate {
  return {
    fontFamily: fontName(raw.doc_font_family) ?? DOC_TEMPLATE_DEFAULTS.fontFamily,
    headingPt: num(raw.doc_heading_pt, DOC_TEMPLATE_DEFAULTS.headingPt, 8, 48),
    bodyPt: num(raw.doc_body_pt, DOC_TEMPLATE_DEFAULTS.bodyPt, 8, 24),
    marginTopMm: num(raw.doc_margin_top_mm, DOC_TEMPLATE_DEFAULTS.marginTopMm, 0, 120),
    marginBottomMm: num(raw.doc_margin_bottom_mm, DOC_TEMPLATE_DEFAULTS.marginBottomMm, 0, 120),
    marginSideMm: num(raw.doc_margin_side_mm, DOC_TEMPLATE_DEFAULTS.marginSideMm, 0, 80),
  };
}

/** يقرأ القالب من الإعدادات. تعذُّر القراءة يعني الافتراضيات لا فشلَ تصدير. */
export async function loadDocTemplate(env: Env): Promise<DocTemplate> {
  try {
    const marks = DOC_TEMPLATE_KEYS.map(() => '?').join(',');
    const rows = await env.DB.prepare(`SELECT key, value FROM app_settings WHERE key IN (${marks})`)
      .bind(...DOC_TEMPLATE_KEYS)
      .all<{ key: string; value: string }>();
    const raw: Record<string, string> = {};
    for (const r of rows.results ?? []) raw[r.key] = r.value;
    return normalizeDocTemplate(raw);
  } catch (e: any) {
    console.error('doc template load failed:', e?.message ?? e);
    return { ...DOC_TEMPLATE_DEFAULTS };
  }
}

/**
 * سلّم العناوين مشتقٌّ من حجم العنوان الرئيس، ولا ينزل تحت المتن.
 * أربع درجات: `#` إلى `####`.
 */
export function headingSizes(t: DocTemplate): [number, number, number, number] {
  const floor = t.bodyPt;
  const step = (n: number) => Math.max(floor, t.headingPt - n);
  return [t.headingPt, step(2), step(3), step(4)];
}

// ── رأسية الشركة ──

/**
 * الرأسية كما تحتاجها القوالب.
 *
 * Word لا يعرض SVG وحده: امتداد `svgBlip` يوجب صورةً نقطية بديلة في الكتلة
 * نفسها، وقارئٌ لا يعرف الامتداد يعرض البديلة. فالنقطية لازمة دائماً،
 * والمتجهة تزيد عليها. أما الطباعة فتأخذ الأصل كما رُفع — المتجهة فيها أحدّ.
 */
export interface Letterhead {
  raster: Uint8Array;
  rasterExt: 'png' | 'jpeg';
  /** نسخة SVG إن كان الأصل متجهاً. */
  svg?: Uint8Array;
}

export const LETTERHEAD_KEY = 'settings/letterhead';
/** النقطية المشتقّة من SVG — تُولَّد عند الرفع، فلا رَسْم متجهات في Worker. */
export const LETTERHEAD_RASTER_KEY = 'settings/letterhead-raster.png';

export function isSvgMime(mime: string | null | undefined): boolean {
  return !!mime && mime.includes('svg');
}

/** يقرأ الرأسية لقوالب Word. غيابُها ليس خطأً — المستند يخرج بلا رأسية. */
export async function loadLetterhead(env: Env): Promise<Letterhead | undefined> {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'letterhead_mime'").first<{
      value: string;
    }>();
    const mime = row?.value;
    if (!mime) return undefined;

    if (isSvgMime(mime)) {
      const [rasterObj, svgObj] = await Promise.all([
        env.R2.get(LETTERHEAD_RASTER_KEY),
        env.R2.get(LETTERHEAD_KEY),
      ]);
      // رأسيةٌ متجهة رُفعت قبل أن تُولَّد النقطية: تُترك لقالب الطباعة وحده،
      // ولا تُحشر في Word نصفَ صورة.
      if (!rasterObj) {
        console.error('letterhead raster missing for svg original — word export goes without it');
        return undefined;
      }
      return {
        raster: new Uint8Array(await rasterObj.arrayBuffer()),
        rasterExt: 'png',
        svg: svgObj ? new Uint8Array(await svgObj.arrayBuffer()) : undefined,
      };
    }

    const obj = await env.R2.get(LETTERHEAD_KEY);
    if (!obj) return undefined;
    return {
      raster: new Uint8Array(await obj.arrayBuffer()),
      rasterExt: mime.includes('jp') ? 'jpeg' : 'png',
    };
  } catch (e: any) {
    console.error('letterhead load failed:', e?.message ?? e);
    return undefined;
  }
}

// ── تحويلات وحدات الصفحة ──

/** الملّيمتر بوحدة twip (١/١٤٤٠ بوصة) — وحدة الصفحة في WordML. */
export const mmToTwips = (mm: number) => Math.round((mm * 1440) / 25.4);
/** الملّيمتر بوحدة EMU — وحدة الرسم في OOXML. */
export const mmToEmu = (mm: number) => Math.round(mm * 36000);
/** النقطة بأنصاف النقاط — وحدة `w:sz`. */
export const ptToHalf = (pt: number) => Math.round(pt * 2);

/** مقاس A4 بالملّيمتر. الرأسية صورةٌ بهذا المقاس، والصفحة كذلك. */
export const A4_WIDTH_MM = 210;
export const A4_HEIGHT_MM = 297;

function num(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n * 10) / 10));
}

/**
 * اسم الخط يُنقّى: يدخل سمةَ XML في Word، وقيمةَ `font-family` في CSS.
 * فالمحارف التي تكسر أحدهما تُحذف، لا تُهرَّب في كل موضع على حدة.
 */
function fontName(v: string | undefined): string | undefined {
  const clean = (v ?? '')
    .replace(/["'`<>&;{}\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return clean || undefined;
}
