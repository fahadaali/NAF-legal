// توليد ملف Word (.docx) عربي RTL دون اعتماديات — §11
// ننشئ حاوية ZIP بإدخالات مخزَّنة (بدون ضغط) مع CRC32.
import { DISCLAIMER } from './prompts';
import { zip } from './zip';
import {
  A4_HEIGHT_MM,
  A4_WIDTH_MM,
  DOC_TEMPLATE_DEFAULTS,
  headingSizes,
  mmToEmu,
  mmToTwips,
  ptToHalf,
  type DocTemplate,
  type Letterhead,
} from './docTemplate';

export type { Letterhead };

export interface DocxOptions {
  template?: DocTemplate;
  letterhead?: Letterhead;
}

/** معرّف امتداد SVG في OOXML — ثابتٌ تعرفه Word، لا رقمٌ نختاره. */
const SVG_EXT_URI = '{96DAC541-7B7A-43D3-8B79-37D633B846F1}';
const SVG_NS = 'http://schemas.microsoft.com/office/drawing/2016/SVG/main';

const REL_HEADER = 'rIdHdr1';
const REL_RASTER = 'rIdImg1';
const REL_SVG = 'rIdImg2';

export function buildDocx(title: string, markdown: string, opts: DocxOptions = {}): Uint8Array {
  const t = opts.template ?? DOC_TEMPLATE_DEFAULTS;
  const lh = opts.letterhead;
  const body = markdownToDocXml(markdown, t);
  const sizes = headingSizes(t);

  /* نطاق الكتابة يُضبط في `w:pgMar` لا بفقراتٍ فارغة في أوّل الصفحة.
     الهامش يسري على كل صفحة، والفقرات الفارغة تسري على الأولى وحدها —
     فكان المتن يبدأ تحت الرأسية في الصفحة الأولى ثم يركبها في الثانية. */
  const sectPr = `<w:sectPr>${lh ? `<w:headerReference w:type="default" r:id="${REL_HEADER}"/>` : ''}<w:pgSz w:w="${mmToTwips(
    A4_WIDTH_MM
  )}" w:h="${mmToTwips(A4_HEIGHT_MM)}"/><w:pgMar w:top="${mmToTwips(t.marginTopMm)}" w:right="${mmToTwips(
    t.marginSideMm
  )}" w:bottom="${mmToTwips(t.marginBottomMm)}" w:left="${mmToTwips(
    t.marginSideMm
  )}" w:header="0" w:footer="0" w:gutter="0"/><w:bidi/></w:sectPr>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${XML_NS}>
<w:body>
${headingPara(title, sizes[0], t, { center: true })}
${body}
${dividerPara()}
${para(DISCLAIMER, t, { size: Math.max(8, t.bodyPt - 3), italic: true, color: MUTED })}
${sectPr}
</w:body>
</w:document>`;

  const files: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': contentTypes(lh),
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    'word/document.xml': documentXml,
    'word/_rels/document.xml.rels': documentRels(lh),
  };

  if (lh) {
    const rasterName = `letterhead.${lh.rasterExt}`;
    files[`word/media/${rasterName}`] = lh.raster;
    files['word/header1.xml'] = headerXml(lh);
    files['word/_rels/header1.xml.rels'] = headerRels(lh, rasterName);
    if (lh.svg) files['word/media/letterhead.svg'] = lh.svg;
  }

  return zip(files);
}

/**
 * الرأسية في ترويسة الصفحة لا في متنها.
 *
 * كانت صورةً مضمَّنة في أول المتن: تظهر في الصفحة الأولى وحدها، وتقتطع من
 * نطاق الكتابة سطوراً، ويدفعها النصُّ أمامه إن طال. وفي الترويسة تتكرّر في كل
 * صفحة، وتُثبَّت إلى حافة الورقة لا إلى الهامش، وتقع **خلف** النص.
 */
function headerXml(lh: Letterhead): string {
  const cx = mmToEmu(A4_WIDTH_MM);
  const cy = mmToEmu(A4_HEIGHT_MM);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${XML_NS}>
<w:p><w:pPr><w:bidi/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:drawing>
<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="0" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">
<wp:simplePos x="0" y="0"/>
<wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH>
<wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV>
<wp:extent cx="${cx}" cy="${cy}"/>
<wp:effectExtent l="0" t="0" r="0" b="0"/>
<wp:wrapNone/>
<wp:docPr id="1" name="letterhead"/>
<wp:cNvGraphicFramePr/>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="letterhead"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill>${blip(lh)}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>
</a:graphicData></a:graphic></wp:anchor>
</w:drawing></w:r></w:p>
</w:hdr>`;
}

/**
 * الكتلة المصوَّرة: النقطية دائماً، والمتجهة امتداداً عليها.
 *
 * Word ٢٠١٦ فما فوق يقرأ `svgBlip` فيرسم المتجهة — تكبر بلا تحبُّب عند
 * الطباعة — ومن لا يعرف الامتداد يعرض النقطية. فلا مستندَ بلا رأسية في أي
 * قارئ، ولا رأسيةَ مهترئة في قارئٍ حديث.
 */
function blip(lh: Letterhead): string {
  if (!lh.svg) return `<a:blip r:embed="${REL_RASTER}"/>`;
  return `<a:blip r:embed="${REL_RASTER}"><a:extLst><a:ext uri="${SVG_EXT_URI}"><asvg:svgBlip xmlns:asvg="${SVG_NS}" r:embed="${REL_SVG}"/></a:ext></a:extLst></a:blip>`;
}

function contentTypes(lh?: Letterhead): string {
  const defaults = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
  ];
  if (lh) {
    defaults.push(`<Default Extension="${lh.rasterExt}" ContentType="image/${lh.rasterExt}"/>`);
    if (lh.svg) defaults.push('<Default Extension="svg" ContentType="image/svg+xml"/>');
  }
  const overrides = [
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
  ];
  if (lh) {
    overrides.push(
      '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'
    );
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
${defaults.join('\n')}
${overrides.join('\n')}
</Types>`;
}

function documentRels(lh?: Letterhead): string {
  const rels = lh
    ? `<Relationship Id="${REL_HEADER}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels}
</Relationships>`;
}

function headerRels(lh: Letterhead, rasterName: string): string {
  const img = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
  const rels = [`<Relationship Id="${REL_RASTER}" Type="${img}" Target="media/${rasterName}"/>`];
  if (lh.svg) rels.push(`<Relationship Id="${REL_SVG}" Type="${img}" Target="media/letterhead.svg"/>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels.join('\n')}
</Relationships>`;
}

const XML_NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
].join(' ');

/** رماديّ المتن الثانوي — يطابق `--muted-foreground` في الوضع الفاتح (§الطباعة). */
const MUTED = '646A78';
/** رماديّ الفواصل — يطابق `--border` في الوضع الفاتح. */
const RULE = 'D9D9D9';

// الترقيم القانوني العربي للعناوين من المستوى الثاني: أولًا، ثانيًا…
const ORDINALS = [
  'أولًا', 'ثانيًا', 'ثالثًا', 'رابعًا', 'خامسًا', 'سادسًا', 'سابعًا', 'ثامنًا',
  'تاسعًا', 'عاشرًا', 'حادي عشر', 'ثاني عشر', 'ثالث عشر', 'رابع عشر', 'خامس عشر',
];

// ── تحويل Markdown مبسّط إلى فقرات WordML ──
function markdownToDocXml(md: string, t: DocTemplate): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const sizes = headingSizes(t);
  let sectionIndex = 0; // لترقيم عناوين المستوى الثاني قانونيًا

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      out.push(para('', t, {}));
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      let text = inlineText(h[2]);
      // نُرقّم عناوين المستوى الثاني إن لم تكن مرقّمة أصلًا
      if (level === 2) {
        // نتقدّم في العدّاد مع كل عنوان من المستوى الثاني حتى لا يتكرّر ترتيب مع العناوين المرقّمة مسبقًا
        const already = /^(أولًا|ثانيًا|ثالثًا|رابعًا|خامسًا|سادسًا|سابعًا|ثامنًا|تاسعًا|عاشرًا|\d+[.)])/.test(text);
        const ord = ORDINALS[sectionIndex] ?? `${sectionIndex + 1}`;
        if (!already) text = `${ord}: ${text}`;
        sectionIndex++;
      }
      out.push(headingPara(text, sizes[level - 1], t));
      continue;
    }
    const li = line.match(/^\s*[-*•]\s+(.*)$/);
    if (li) {
      out.push(para('• ' + inlineText(li[1]), t, { indent: 400 }));
      continue;
    }
    const num = line.match(/^\s*(\d+[.)])\s+(.*)$/);
    if (num) {
      out.push(para(num[1] + ' ' + inlineText(num[2]), t, { indent: 400 }));
      continue;
    }
    out.push(para(inlineText(line), t, {}));
  }
  return out.join('\n');
}

// يُلحق المكافئ الهجري بالتواريخ الميلادية الظاهرة في النص (YYYY-MM-DD)
export function annotateDates(text: string, toHijriFn: (d: string) => string): string {
  // نتجاهل التاريخ المتبوع بقوس يحوي مكافئًا هجريًا (منعًا للتكرار) دون تجاهل أي قوس آخر
  return text.replace(/\b(\d{4}-\d{2}-\d{2})\b(?!\s*\([^)]*هـ)/g, (m, d) => {
    const h = toHijriFn(d);
    return h ? `${d} (${h})` : m;
  });
}

function inlineText(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
}

interface RunOpts {
  /** بالنقاط لا بأنصافها — التحويل في `runProps`. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  indent?: number;
}

/**
 * ترتيب العناصر داخل `w:pPr` و`w:rPr` يتبع المخطَّط لا الذوق: `bidi` قبل
 * `spacing`، و`ind` قبل `jc`، و`pBdr` قبل `bidi`. وترتيبٌ مخالف يقرأه Word
 * أحياناً ويردّه مدقّق المخطَّط دائماً.
 */
/**
 * ضبط المتن بالكشيدة لا بالمسافات.
 *
 * `both` يوسّع ما بين الكلمات، فيترك في السطر العربي فجواتٍ بيضاء تُقطّع
 * النصّ — وهي علّةُ الضبط في العربية. و`lowKashida` يمدّ حروف الوصل بدل
 * ذلك، وهو ضبطُ العربية المعروف في Word («ضبط منخفض»)، ويُبقي الكلمات
 * متلاصقة. والمنخفض دون المتوسط والعالي: المدّ الطويل يشتّت في مستندٍ
 * قانوني يُقرأ سطراً سطراً.
 */
function para(text: string, t: DocTemplate, o: RunOpts): string {
  const ind = o.indent ? `<w:ind w:right="${o.indent}"/>` : '';
  // سطرٌ ونصف: العربية تحتاج فراغاً رأسياً للحركات والنقاط تحت السطر.
  return `<w:p><w:pPr><w:bidi/><w:spacing w:after="120" w:line="360" w:lineRule="auto"/>${ind}<w:jc w:val="lowKashida"/></w:pPr><w:r>${runProps(
    t,
    o
  )}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

/**
 * العنوان الرئيس وحده في الوسط: هو أول ما تحت الرأسية، فيقع في وسط أعلى
 * الصفحة. وعناوين الأقسام تُضبط بالكشيدة كالمتن — عنوانٌ يمتدّ سطرين يستوي
 * طرفاه مع ما حوله، والقصيرُ سطرٌ أخير فيبقى على جهة البداية. وعنوانٌ
 * متوسّطٌ في كل قسم يُفقد القارئَ خيط التسلسل، فلا يُعمَّم التوسيط.
 */
function headingPara(text: string, sizePt: number, t: DocTemplate, o: { center?: boolean } = {}): string {
  const jc = o.center ? 'center' : 'lowKashida';
  const spacing = o.center
    ? '<w:spacing w:before="0" w:after="360" w:line="300" w:lineRule="auto"/>'
    : '<w:spacing w:before="240" w:after="120" w:line="300" w:lineRule="auto"/>';
  return `<w:p><w:pPr><w:bidi/>${spacing}<w:jc w:val="${jc}"/></w:pPr><w:r>${runProps(
    t,
    { size: sizePt, bold: true }
  )}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function dividerPara(): string {
  return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="${RULE}"/></w:pBdr><w:bidi/></w:pPr></w:p>`;
}

function runProps(t: DocTemplate, o: RunOpts): string {
  const half = ptToHalf(o.size ?? t.bodyPt);
  const font = escAttr(t.fontFamily);
  const parts = [
    `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}" w:hint="cs"/>`,
    o.bold ? '<w:b/><w:bCs/>' : '',
    o.italic ? '<w:i/><w:iCs/>' : '',
    o.color ? `<w:color w:val="${o.color}"/>` : '',
    `<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>`,
    '<w:rtl/>',
    '<w:lang w:bidi="ar-SA"/>',
  ];
  return `<w:rPr>${parts.join('')}</w:rPr>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s: string): string {
  return esc(s).replace(/'/g, '&apos;');
}
