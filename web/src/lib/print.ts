/**
 * قالب الطباعة و PDF.
 *
 * **هذا الملف أحد المواضع الأربعة التي تُكتب فيها القيم صراحةً** (§١ من قواعد
 * الواجهة): المستند يُبنى في نافذةٍ مستقلّة لا ترث ورقة أنماط التطبيق ولا
 * تُحلّ فيها `var(--…)`، ويبقى فاتحاً مهما كان مظهر القارئ — مذكّرةٌ داكنة لا
 * تُقدَّم في محكمة. فالألوان هنا حرفية، وهي نفسها قيم الوضع الفاتح في
 * `naf-theme.css`، وتُحدَّث معه.
 *
 * والقالب يطابق قالب Word: العائلة والأحجام ونطاق الكتابة من الإعدادات
 * نفسها، والرأسية الصورة نفسها. فما يُصدَّر Word وما يُطبع PDF مستندٌ واحد.
 */
import type { DocTemplate } from './api';
import arabic400 from '@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-400-normal.woff2?url';
import arabic600 from '@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-600-normal.woff2?url';
import arabic700 from '@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-700-normal.woff2?url';
import latin400 from '@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-latin-400-normal.woff2?url';
import latin600 from '@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-latin-600-normal.woff2?url';
import latin700 from '@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-latin-700-normal.woff2?url';

/* قيم الوضع الفاتح، محسوبة من oklch في `naf-theme.css`:
   --foreground · --muted-foreground · --border · --primary */
const INK = '#333333';
const MUTED = '#646A78';
const RULE = '#D9D9D9';
const ACCENT = '#937133';

/** مقاس الورقة — الرأسية صورةٌ بهذا المقاس، والصفحة كذلك. */
const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;

/**
 * قيمٌ تُستعمل حين يتعذّر جلب القالب من الخادم — تطابق افتراضيات
 * `src/lib/docTemplate.ts`. وتعذُّر جلب إعدادٍ لا يمنع طباعة مسودّة.
 */
export const PRINT_TEMPLATE_FALLBACK: DocTemplate = {
  fontFamily: 'IBM Plex Sans Arabic',
  headingPt: 16,
  bodyPt: 12,
  marginTopMm: 45,
  marginBottomMm: 30,
  marginSideMm: 20,
};

export interface PrintDoc {
  title: string;
  /** المحتوى مُحوَّلاً إلى HTML (من `renderMarkdown`). */
  html: string;
  template: DocTemplate;
  /** الرأسية كـ`data:` — تُطبع خلف النص في كل صفحة. */
  letterheadUrl?: string;
  disclaimer: string;
}

/**
 * يجلب الرأسية ويحوّلها إلى `data:`.
 *
 * ونافذة الطباعة لا تطلبها من الخادم: طلبٌ ثانٍ منها يعني انتظاراً قبل
 * الطباعة قد ينقضي فتخرج ورقةٌ بلا رأسية — والمعاينة قبل الطباعة تُفتح
 * وتُغلق أسرع من دورة شبكة.
 */
export async function fetchLetterhead(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) return undefined;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    // رأسيةٌ لم تصل لا تمنع طباعة مسودّة — تخرج الورقة بلا رأسية.
    return undefined;
  }
}

/**
 * يفتح نافذة طباعة بالمستند. يعيد `false` إن منع المتصفّح النافذة.
 *
 * والطباعة تُطلب بعد تحميل الرأسية لا مع `onload` وحده: نافذةٌ تُطبع قبل أن
 * تصل صورتها تُخرج ورقةً بيضاء تحت النص.
 */
export function printDocument(doc: PrintDoc): boolean {
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.write(buildPrintHtml(doc));
  w.document.close();
  return true;
}

export function buildPrintHtml(doc: PrintDoc): string {
  const t = doc.template;
  const sizes = headingSizes(t);
  const font = cssFontStack(t.fontFamily);

  /* الرأسية خلفيةٌ للجذر تتكرّر بارتفاع الورقة، لا عنصراً مثبَّتاً.
     `position: fixed` في الطباعة يُقاس داخل صندوق المحتوى — داخل هوامش
     `@page` — فينزلق عن حافة الورقة ولا يتكرّر في الصفحة الثانية. وبهامشٍ
     صفريّ يصير أصلُ الخلفية حافةَ الورقة نفسها، فتقع كل بلاطةٍ على صفحة. */
  const sheet = doc.letterheadUrl
    ? `background-image: url("${escapeAttr(doc.letterheadUrl)}");
  background-size: ${A4_WIDTH_MM}mm ${A4_HEIGHT_MM}mm;
  background-repeat: repeat-y;
  background-position: top center;
  /* خلفيات CSS لا تُطبع إلا بإذن القارئ، وهذا يفرضها */
  print-color-adjust: exact;
  -webkit-print-color-adjust: exact;`
    : '';

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<title>${escapeHtml(doc.title)}</title>
<style>
${fontFaces()}
@page {
  size: A4;
  /* الهامش صفرٌ لتبلغ الرأسيةُ حافةَ الورقة. ونطاق الكتابة يصنعه جدول
     الصفحة أدناه: رأسه وذيله يتكرّران في كل صفحة بارتفاع الهامش. */
  margin: 0;
}
* { box-sizing: border-box; }
html {
  background-color: #FFFFFF;
  ${sheet}
}
html, body {
  margin: 0;
  padding: 0;
  color: ${INK};
}
body {
  background: transparent;
  font-family: ${font};
  font-size: ${t.bodyPt}pt;
  /* لا يُنقص ارتفاع السطر: العربية تحتاج مدىً للحركات وما تحت السطر */
  line-height: 1.9;
  text-align: justify;
}
/* جدول الصفحة: رأسه وذيله يعيدهما المتصفّح في كل صفحة مطبوعة، فيحجزان
   نطاق الكتابة على امتداد المستند لا في صفحته الأولى وحدها. */
table.naf-sheet { width: 100%; border-collapse: collapse; }
table.naf-sheet > thead > tr > td { height: ${t.marginTopMm}mm; border: 0; padding: 0; }
table.naf-sheet > tfoot > tr > td { height: ${t.marginBottomMm}mm; border: 0; padding: 0; }
table.naf-sheet > tbody > tr > td {
  border: 0;
  padding: 0 ${t.marginSideMm}mm;
  vertical-align: top;
}
h1, h2, h3, h4 {
  font-weight: 600;
  line-height: 1.5;
  text-align: start;
  margin: 1.1em 0 0.5em;
  page-break-after: avoid;
  break-after: avoid;
}
h1 { font-size: ${sizes[0]}pt; margin-top: 0; }
h2 { font-size: ${sizes[1]}pt; }
h3 { font-size: ${sizes[2]}pt; }
h4 { font-size: ${sizes[3]}pt; }
p { margin: 0 0 0.7em; orphans: 3; widows: 3; }
ul, ol { margin: 0 0 0.7em; padding-inline-start: 1.6em; }
li { margin-bottom: 0.25em; }
strong { font-weight: 600; }
a { color: ${ACCENT}; text-decoration: none; }
code { font-family: ui-monospace, "Courier New", monospace; font-size: 0.92em; }
hr { border: 0; border-block-start: 1px solid ${RULE}; margin: 1.2em 0; }
table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.8em 0;
  /* أرقام الجداول تُصفّ بعضها تحت بعض */
  font-variant-numeric: tabular-nums;
  page-break-inside: avoid;
  break-inside: avoid;
}
th, td {
  border: 1px solid ${RULE};
  padding: 6px 8px;
  text-align: start;
  vertical-align: top;
}
th { font-weight: 600; background: #F2F2F2; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
bdi { unicode-bidi: isolate; }
.disclaimer {
  margin-top: 2em;
  padding-block-start: 0.8em;
  border-block-start: 1px solid ${RULE};
  color: ${MUTED};
  font-size: ${Math.max(8, t.bodyPt - 3)}pt;
  line-height: 1.7;
  text-align: start;
  page-break-inside: avoid;
  break-inside: avoid;
}
</style>
</head>
<body>
<table class="naf-sheet">
<thead><tr><td></td></tr></thead>
<tfoot><tr><td></td></tr></tfoot>
<tbody><tr><td>
<h1>${escapeHtml(doc.title)}</h1>
${doc.html}
<div class="disclaimer">${escapeHtml(doc.disclaimer)}</div>
</td></tr></tbody>
</table>
<script>
  /* الطباعة بعد أن تكتمل الموارد: خلفيةُ الرأسية والخطوط. ونافذةٌ تُطبع
     قبلها تُخرج ورقةً بلا رأسية وبخطٍّ بديل. */
  (function () {
    var go = function () { window.focus(); window.print(); };
    var loaded = new Promise(function (r) {
      if (document.readyState === 'complete') r();
      else window.addEventListener('load', r);
    });
    var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    Promise.all([loaded, fonts]).then(go, go);
  })();
</script>
</body>
</html>`;
}

/**
 * سلّم العناوين مشتقٌّ من حجم العنوان الرئيس ولا ينزل تحت المتن — نفس اشتقاق
 * قالب Word، فالمستندان يخرجان بأحجامٍ واحدة.
 */
function headingSizes(t: DocTemplate): [number, number, number, number] {
  const step = (n: number) => Math.max(t.bodyPt, t.headingPt - n);
  return [t.headingPt, step(2), step(3), step(4)];
}

/**
 * الخط المضبوط أولاً، ثم خطّ ناف، ثم ما يوجد في الجهاز.
 *
 * ونافذة الطباعة لا ترث خطوط التطبيق — لكلّ مستندٍ خطوطُه — فتُحقن
 * `@font-face` بالمسارات نفسها التي بناها Vite.
 */
function cssFontStack(family: string): string {
  const first = family && family !== 'IBM Plex Sans Arabic' ? `"${family}", ` : '';
  return `${first}"IBM Plex Sans Arabic", "Segoe UI", Tahoma, Arial, sans-serif`;
}

function fontFaces(): string {
  return FONT_FILES.map(
    ({ weight, url, range }) => `@font-face {
  font-family: "IBM Plex Sans Arabic";
  font-style: normal;
  font-weight: ${weight};
  src: url("${new URL(url, location.origin).href}") format("woff2");
  unicode-range: ${range};
  font-display: block;
}`
  ).join('\n');
}

/* النطاقان منقولان من `@fontsource/ibm-plex-sans-arabic`. واللاتيني لازمٌ لا
   زائد: الأرقام غربية في كل مخرجات المنصة (§٨)، وأرقام التواريخ والمواد
   ومبالغ الأحكام كلّها في هذا النطاق — وملفُّ العربية وحده لا يحمل رسمها. */
const ARABIC_RANGE =
  'U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0897-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC';
const LATIN_RANGE =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';

/* الملفات نفسها التي تحمّلها الواجهة — يحلّها Vite إلى مسارها المبنيّ بعد
   البصمة، فلا يُكتب اسمٌ مجزوم يتغيّر مع كل بناء.
   والأوزان ثلاثة: المتن ٤٠٠، والعناوين ٦٠٠، والتوكيد ٧٠٠. */
const FONT_FILES: { weight: number; url: string; range: string }[] = [
  { weight: 400, url: arabic400, range: ARABIC_RANGE },
  { weight: 400, url: latin400, range: LATIN_RANGE },
  { weight: 600, url: arabic600, range: ARABIC_RANGE },
  { weight: 600, url: latin600, range: LATIN_RANGE },
  { weight: 700, url: arabic700, range: ARABIC_RANGE },
  { weight: 700, url: latin700, range: LATIN_RANGE },
];

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
