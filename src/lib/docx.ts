// توليد ملف Word (.docx) عربي RTL دون اعتماديات — §11
// ننشئ حاوية ZIP بإدخالات مخزَّنة (بدون ضغط) مع CRC32.
import { DISCLAIMER } from './prompts';
import { zip } from './zip';

export interface Letterhead {
  bytes: Uint8Array;
  ext: 'png' | 'jpeg';
}

export function buildDocx(title: string, markdown: string, letterhead?: Letterhead): Uint8Array {
  const body = markdownToDocXml(markdown);
  const banner = letterhead ? letterheadPara() : '';
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>
${banner}
${headingPara(title, 32, true)}
${body}
${dividerPara()}
${para(DISCLAIMER, { size: 18, italic: true, color: '888888' })}
<w:sectPr><w:bidi/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
</w:body>
</w:document>`;

  const ctExtra = letterhead
    ? `<Default Extension="${letterhead.ext === 'jpeg' ? 'jpeg' : 'png'}" ContentType="image/${letterhead.ext}"/>`
    : '';

  const files: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${ctExtra}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    'word/document.xml': documentXml,
  };

  if (letterhead) {
    const imgName = `image1.${letterhead.ext === 'jpeg' ? 'jpeg' : 'png'}`;
    files[`word/media/${imgName}`] = letterhead.bytes;
    files['word/_rels/document.xml.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${imgName}"/>
</Relationships>`;
  }

  return zip(files);
}

// فقرة تحتوي صورة الرأسية بعرض المحتوى (~6.3 بوصة) وارتفاع ~1.3 بوصة
function letterheadPara(): string {
  const cx = 5760720; // العرض بوحدة EMU
  const cy = 1188720; // الارتفاع
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>
<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>
<wp:docPr id="1" name="letterhead"/>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="letterhead"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="rIdImg1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>
</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

// ── تحويل Markdown مبسّط إلى فقرات WordML ──
function markdownToDocXml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (let raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      out.push(para('', {}));
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const sizes = [30, 26, 24, 22];
      out.push(headingPara(inlineText(h[2]), sizes[level - 1], true));
      continue;
    }
    const li = line.match(/^\s*[-*•]\s+(.*)$/);
    if (li) {
      out.push(para('• ' + inlineText(li[1]), { indent: 400 }));
      continue;
    }
    const num = line.match(/^\s*(\d+[.)])\s+(.*)$/);
    if (num) {
      out.push(para(num[1] + ' ' + inlineText(num[2]), { indent: 400 }));
      continue;
    }
    out.push(para(inlineText(line), {}));
  }
  return out.join('\n');
}

function inlineText(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
}

interface RunOpts {
  size?: number; // نصف نقطة
  bold?: boolean;
  italic?: boolean;
  color?: string;
  indent?: number;
}

function para(text: string, o: RunOpts): string {
  const rpr = runProps(o);
  const ind = o.indent ? `<w:ind w:right="${o.indent}"/>` : '';
  return `<w:p><w:pPr><w:bidi/><w:jc w:val="both"/>${ind}</w:pPr><w:r>${rpr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function headingPara(text: string, size: number, bold: boolean): string {
  return `<w:p><w:pPr><w:bidi/><w:jc w:val="right"/><w:spacing w:before="200" w:after="120"/></w:pPr><w:r>${runProps(
    { size, bold }
  )}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function dividerPara(): string {
  return `<w:p><w:pPr><w:bidi/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="CCCCCC"/></w:pBdr></w:pPr></w:p>`;
}

function runProps(o: RunOpts): string {
  const size = o.size ?? 24; // 12pt
  const parts = [
    '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>',
    o.bold ? '<w:b/><w:bCs/>' : '',
    o.italic ? '<w:i/><w:iCs/>' : '',
    o.color ? `<w:color w:val="${o.color}"/>` : '',
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`,
    '<w:rtl/>',
  ];
  return `<w:rPr>${parts.join('')}</w:rPr>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
