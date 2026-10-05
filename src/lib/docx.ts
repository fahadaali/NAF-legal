// توليد ملف Word (.docx) عربي RTL دون اعتماديات — §11
// ننشئ حاوية ZIP بإدخالات مخزَّنة (بدون ضغط) مع CRC32.
import { DISCLAIMER } from './prompts';
import { zip } from './zip';
import { parseDraft, splitDocTitle, plain, type Block, type Inline } from './draftText';
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
const REL_STYLES = 'rIdStyles1';
const REL_RASTER = 'rIdImg1';
const REL_SVG = 'rIdImg2';

export function buildDocx(title: string, markdown: string, opts: DocxOptions = {}): Uint8Array {
  const t = opts.template ?? DOC_TEMPLATE_DEFAULTS;
  const lh = opts.letterhead;
  // عنوانٌ كتبه المحامي في أوّل المستند يتقدّم على عنوان المحادثة — `splitDocTitle`.
  const split = splitDocTitle(markdown);
  title = split.title ?? title;
  const body = markdownToDocXml(split.body, t);
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
    'word/styles.xml': stylesXml(t),
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
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
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
  const rels =
    `<Relationship Id="${REL_STYLES}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    (lh
      ? `\n<Relationship Id="${REL_HEADER}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>`
      : '');
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

/** لغة كل شوط: العربية في الخانات الثلاث — والتدقيق الإملائي في Word يتبعها. */
const LANG = '<w:lang w:val="ar-SA" w:eastAsia="ar-SA" w:bidi="ar-SA"/>';

/**
 * الافتراضيات على مستوى المستند: اتجاهٌ من اليمين ولغةٌ عربية لكل فقرة وشوط.
 *
 * كل فقرةٍ يكتبها هذا الملف تحمل `bidi` وكل شوطٍ يحمل `rtl` — وهذه لما
 * يُضاف بعدُ في Word نفسه: فقرةٌ يكتبها المحامي تحت المسودّة تبدأ عربيةً
 * من اليمين لا لاتينيةً من اليسار.
 */
function stylesXml(t: DocTemplate): string {
  const font = escAttr(t.fontFamily);
  const half = ptToHalf(t.bodyPt);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/><w:sz w:val="${half}"/><w:szCs w:val="${half}"/><w:rtl/>${LANG}</w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:bidi/></w:pPr></w:pPrDefault>
</w:docDefaults>
</w:styles>`;
}

/** رماديّ المتن الثانوي — يطابق `--muted-foreground` في الوضع الفاتح (§الطباعة). */
const MUTED = '646A78';
/** رماديّ الفواصل — يطابق `--border` في الوضع الفاتح. */
const RULE = 'D9D9D9';
/** خلفية صفّ رأس الجدول — تطابق `th` في قالب الطباعة (`web/src/lib/print.ts`). */
const HEADER_FILL = 'F2F2F2';

// الترقيم القانوني العربي للعناوين من المستوى الثاني: أولًا، ثانيًا…
const ORDINALS = [
  'أولًا', 'ثانيًا', 'ثالثًا', 'رابعًا', 'خامسًا', 'سادسًا', 'سابعًا', 'ثامنًا',
  'تاسعًا', 'عاشرًا', 'حادي عشر', 'ثاني عشر', 'ثالث عشر', 'رابع عشر', 'خامس عشر',
];

/**
 * عنوانٌ مرقّمٌ أصلاً لا يُرقَّم ثانية.
 *
 * والتنوين يُكتب على الألف أو قبلها («أولاً» و«أولًا») — والتوجيه يطلب من
 * النموذج أن يرقّم عناوينه بنفسه، فلو لم تُعرف الصيغتان لخرج «أولًا: أولاً:
 * الوقائع». و«المادة» و«الباب» و«الفصل» و«البند» ترقيمٌ كذلك في العقود واللوائح.
 */
const ALREADY_NUMBERED =
  /^(?:(?:أول|ثاني|ثالث|رابع|خامس|سادس|سابع|ثامن|تاسع|عاشر)(?:اً|ًا|ا)|(?:حادي|ثاني|ثالث|رابع|خامس|سادس|سابع|ثامن|تاسع) عشر|المادة|الباب|الفصل|البند|القسم|[\d٠-٩]+\s*[.):\-–])/;

/**
 * من الكتل إلى فقرات WordML.
 *
 * لا فقرةَ للسطر الفارغ: المسافة بين الفقرات من `w:spacing` في كل فقرة.
 * وكانت كل فقرةٍ فارغة في النصّ تصير فقرةً فارغة في Word، فيخرج المستند
 * بفراغاتٍ مضاعفة بين كل فقرتين.
 */
function markdownToDocXml(md: string, t: DocTemplate): string {
  const out: string[] = [];
  const sizes = headingSizes(t);
  let sectionIndex = 0; // لترقيم عناوين المستوى الثاني قانونيًا

  for (const b of parseDraft(md)) {
    switch (b.kind) {
      case 'heading': {
        let inl = b.inl;
        // نُرقّم عناوين المستوى الثاني إن لم تكن مرقّمة أصلًا، ونتقدّم في
        // العدّاد مع كل عنوان منها حتى لا يتكرّر ترتيب مع المرقّمة مسبقًا
        if (b.level === 2) {
          if (!ALREADY_NUMBERED.test(plain(inl))) {
            const ord = ORDINALS[sectionIndex] ?? `${sectionIndex + 1}`;
            inl = [{ text: `${ord}: ` }, ...inl];
          }
          sectionIndex++;
        }
        out.push(headingPara(inl, sizes[b.level - 1], t));
        break;
      }
      case 'item': {
        const marker: Inline = { text: `${b.marker} ` };
        out.push(para([marker, ...b.inl], t, { indent: 400 * (b.depth + 1) }));
        break;
      }
      case 'quote':
        out.push(para(b.inl, t, { indent: 400 }));
        break;
      case 'table':
        out.push(tableXml(b, t));
        break;
      case 'rule':
        // الخطّ الفاصل خطٌّ رفيع في Word كما في الطباعة — لا ثلاث شرطات.
        out.push(dividerPara());
        break;
      default:
        out.push(para(b.inl, t, {}));
    }
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
function para(content: string | Inline[], t: DocTemplate, o: RunOpts): string {
  const ind = o.indent ? `<w:ind w:right="${o.indent}"/>` : '';
  // سطرٌ ونصف: العربية تحتاج فراغاً رأسياً للحركات والنقاط تحت السطر.
  return `<w:p><w:pPr><w:bidi/><w:spacing w:after="120" w:line="360" w:lineRule="auto"/>${ind}<w:jc w:val="lowKashida"/></w:pPr>${runs(
    content,
    t,
    o
  )}</w:p>`;
}

/**
 * مقاطع السطر أشواطاً: المغلَّظ شوطٌ مغلَّظ، لا نصٌّ تُحذف نجومه فيضيع توكيده.
 * والرابط نصُّه وحده — المستند يُطبع ويُقدَّم، والعنوان الإلكتروني فيه لا يُنقر.
 */
function runs(content: string | Inline[], t: DocTemplate, o: RunOpts): string {
  const list: Inline[] = typeof content === 'string' ? [{ text: content }] : content;
  return list
    .map(
      (x) =>
        `<w:r>${runProps(t, { ...o, bold: o.bold || x.bold })}<w:t xml:space="preserve">${esc(x.text)}</w:t></w:r>`
    )
    .join('');
}

/**
 * الجدول جدولُ Word بخلاياه وحدوده، لا أسطرٌ من `|`.
 *
 * `bidiVisual` يجعل أوّل عمود على اليمين كما يُقرأ الجدول العربي، وصفُّ
 * الرأس يتكرّر في أعلى كل صفحة إن انقسم الجدول (`tblHeader`). والعرض موزّعٌ
 * بالتساوي على نطاق الكتابة، فلا يخرج الجدول عن الهامش في أيّ قالب.
 */
function tableXml(b: Extract<Block, { kind: 'table' }>, t: DocTemplate): string {
  const cols = Math.max(1, (b.header ?? b.rows[0] ?? []).length);
  const width = mmToTwips(A4_WIDTH_MM - 2 * t.marginSideMm);
  const colW = Math.floor(width / cols);
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="${RULE}"/>`;
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('');
  const size = Math.max(8, t.bodyPt - 1);

  const cell = (inl: Inline[], header: boolean) =>
    `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/>${
      header ? `<w:shd w:val="clear" w:color="auto" w:fill="${HEADER_FILL}"/>` : ''
    }</w:tcPr><w:p><w:pPr><w:bidi/><w:spacing w:before="0" w:after="0" w:line="300" w:lineRule="auto"/></w:pPr>${runs(
      inl.length ? inl : [{ text: '' }],
      t,
      { size, bold: header }
    )}</w:p></w:tc>`;
  const row = (cells: Inline[][], header: boolean) =>
    `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : '<w:trPr><w:cantSplit/></w:trPr>'}${cells
      .map((c) => cell(c, header))
      .join('')}</w:tr>`;

  return `<w:tbl><w:tblPr><w:bidiVisual/><w:tblW w:w="${colW * cols}" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${Array.from(
    { length: cols },
    () => `<w:gridCol w:w="${colW}"/>`
  ).join('')}</w:tblGrid>${b.header ? row(b.header, true) : ''}${b.rows.map((r) => row(r, false)).join('')}</w:tbl>
${spacerPara()}`;
}

/**
 * فقرةٌ بلا ارتفاعٍ يُذكر بعد الجدول: Word يلصق الفقرة التالية بحدّه السفلي،
 * وجدولان متتاليان بلا فقرةٍ بينهما يندمجان جدولاً واحداً.
 */
function spacerPara(): string {
  return '<w:p><w:pPr><w:bidi/><w:spacing w:before="0" w:after="120" w:line="240" w:lineRule="auto"/></w:pPr></w:p>';
}

/**
 * العنوان الرئيس وحده في الوسط: هو أول ما تحت الرأسية، فيقع في وسط أعلى
 * الصفحة. وعناوين الأقسام تُضبط بالكشيدة كالمتن — عنوانٌ يمتدّ سطرين يستوي
 * طرفاه مع ما حوله، والقصيرُ سطرٌ أخير فيبقى على جهة البداية. وعنوانٌ
 * متوسّطٌ في كل قسم يُفقد القارئَ خيط التسلسل، فلا يُعمَّم التوسيط.
 */
function headingPara(
  content: string | Inline[],
  sizePt: number,
  t: DocTemplate,
  o: { center?: boolean } = {}
): string {
  const jc = o.center ? 'center' : 'lowKashida';
  const spacing = o.center
    ? '<w:spacing w:before="0" w:after="360" w:line="300" w:lineRule="auto"/>'
    : '<w:spacing w:before="240" w:after="120" w:line="300" w:lineRule="auto"/>';
  // `keepNext`: العنوان لا يبقى وحده في ذيل صفحةٍ وقسمُه في التي تليها.
  return `<w:p><w:pPr><w:keepNext/><w:bidi/>${spacing}<w:jc w:val="${jc}"/></w:pPr>${runs(content, t, {
    size: sizePt,
    bold: true,
  })}</w:p>`;
}

function dividerPara(): string {
  return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="${RULE}"/></w:pBdr><w:bidi/></w:pPr></w:p>`;
}

function runProps(t: DocTemplate, o: RunOpts): string {
  const half = ptToHalf(o.size ?? t.bodyPt);
  const font = escAttr(t.fontFamily);
  const parts = [
    // العائلة واحدة في الخانات الثلاث، فلا حاجة إلى `w:hint` — وقيمته `cs` يردّها مدقّق المخطَّط.
    `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>`,
    o.bold ? '<w:b/><w:bCs/>' : '',
    o.italic ? '<w:i/><w:iCs/>' : '',
    o.color ? `<w:color w:val="${o.color}"/>` : '',
    `<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>`,
    '<w:rtl/>',
    LANG,
  ];
  return `<w:rPr>${parts.join('')}</w:rPr>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s: string): string {
  return esc(s).replace(/'/g, '&apos;');
}
