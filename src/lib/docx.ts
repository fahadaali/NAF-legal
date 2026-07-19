// توليد ملف Word (.docx) عربي RTL دون اعتماديات — §11
// ننشئ حاوية ZIP بإدخالات مخزَّنة (بدون ضغط) مع CRC32.
import { DISCLAIMER } from './prompts';

export function buildDocx(title: string, markdown: string): Uint8Array {
  const body = markdownToDocXml(markdown);
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${headingPara(title, 32, true)}
${body}
${dividerPara()}
${para(DISCLAIMER, { size: 18, italic: true, color: '888888' })}
<w:sectPr><w:bidi/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
</w:body>
</w:document>`;

  const files: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    'word/document.xml': documentXml,
  };

  return zip(files);
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

// ── كاتب ZIP (إدخالات مخزَّنة) مع CRC32 ──
function zip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // method: stored
    lv.setUint16(10, 0, true); // time
    lv.setUint16(12, 0, true); // date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + 22;
  const result = new Uint8Array(total);
  let pos = 0;
  for (const c of [...chunks, ...central, end]) {
    result.set(c, pos);
    pos += c.length;
  }
  return result;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
