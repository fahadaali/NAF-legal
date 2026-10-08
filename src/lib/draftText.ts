/**
 * قراءة نصّ المسودّة — من Markdown الذي يكتبه النموذج إلى كتلٍ يبنيها كلُّ مُخرِج.
 *
 * **ملفٌّ واحد يقرؤه الخادم والواجهة معاً.** مصدِّر Word (`lib/docx.ts`) وعارض
 * الواجهة والطباعة (`web/src/lib/markdown.ts`) والنسخ والنصّ المجرّد كلّها
 * تبني من هذه الكتل — فما يراه المحامي في المحادثة هو ما يخرج في Word وPDF،
 * ولا يفهم أحدها علامةً يجهلها الآخر. ولذلك لا يستورد شيئاً: لا أنواع
 * Workers ولا DOM.
 *
 * والشكوى التي بُني لها: `###` و`**` تظهر حرفيّةً في Word، والأسطر الفارغة
 * تصير فقراتٍ فارغة متتالية، والجداول تخرج أسطراً من الخطوط العمودية. فهنا:
 * - السطر الفارغ فاصلٌ لا فقرة — المسافة بين الفقرات من تنسيقها لا من فراغٍ مكتوب.
 * - العناوين من `#` إلى `######` كلّها عناوين، وما بعد الرابع يُعرض رابعاً.
 * - `**…**` و`__…__` تغليظٌ حقيقي، وما بقي من نجومٍ يتيمة يُحذف ولا يُطبع.
 * - الخطّ الفاصل (`---`) خطٌّ رفيع في Word والطباعة والواجهة، ويُسقطه النصّ المجرّد.
 * - أسوار الشيفرة تُسقط ويبقى ما بينها نصّاً.
 * - الجدول جدولٌ بخلاياه، لا أسطرٌ من `|`.
 */

export interface Inline {
  text: string;
  bold?: boolean;
  /** رابطٌ بمخطّط http(s) وحده — وغيره يبقى نصّاً. */
  href?: string;
}

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; inl: Inline[] }
  | { kind: 'para'; inl: Inline[] }
  | { kind: 'item'; ordered: boolean; marker: string; depth: number; inl: Inline[] }
  | { kind: 'quote'; inl: Inline[] }
  | { kind: 'rule' }
  | { kind: 'table'; header: Inline[][] | null; rows: Inline[][][] };

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const FENCE = /^\s*(```|~~~)/;
const QUOTE = /^\s*>\s?(.*)$/;
const BULLET = /^(\s*)[-*+•]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+|[٠-٩]+)([.)])\s+(.*)$/;
const SEPARATOR_CELL = /^:?-{2,}:?$/;

/**
 * عنوان المستند إن بدأ به النصّ (`# …` في أوّل سطرٍ غير فارغ).
 *
 * والمُخرِجات تضعه عنواناً للمستند مكان عنوان المحادثة: العنوان الذي كتبه
 * المحامي في المستند («صحيفة دعوى مطالبة مالية») هو ما يُقدَّم، وعنوانُ
 * المحادثة تسميةٌ داخلية. ولو بقيا معاً لخرج المستند بعنوانين متتاليين.
 */
export function splitDocTitle(md: string): { title: string | null; body: string } {
  const lines = normalize(md).split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first === -1) return { title: null, body: '' };
  const m = lines[first].match(/^\s{0,3}#\s+(.*?)\s*#*\s*$/);
  if (!m) return { title: null, body: lines.join('\n') };
  const title = plain(parseInline(m[1]));
  if (!title) return { title: null, body: lines.join('\n') };
  return { title, body: lines.slice(first + 1).join('\n') };
}

/* ══ «ملاحظات للمحامي» — قسمٌ يُقرأ في المحادثة ولا يُصدَّر ══
 *
 * المساعد يكتب فيه للمحامي ما لا يُكتب للعميل ولا للدائرة: بندٌ عالي المخاطر،
 * وبندٌ ناقص، ودفعٌ متوقَّع. والعنوان مسجّلٌ بحرفه في `naf-terms.md`، لأنه عقدٌ
 * بين التوجيه (`outputStyleInstruction`) وهذا الملف: لفظٌ آخر يعني قسماً يبقى
 * في Word ويصل إلى العميل.
 *
 * والتعرّف متسامحٌ مع ما يضيفه النموذج حول العنوان — ترتيبٌ قبله («خامساً:»)،
 * أو تغليظ، أو نقطتان بعده — لأن الخطأ في هذا الاتجاه هو المكلف. */
export const LAWYER_NOTES_HEADING = 'ملاحظات للمحامي';

export function isLawyerNotesHeading(text: string): boolean {
  const t = text.replace(/[*_`]/g, '').replace(/[:：.]\s*$/, '').trim();
  if (t === LAWYER_NOTES_HEADING) return true;
  const i = t.indexOf(LAWYER_NOTES_HEADING);
  // ترتيبٌ قصير ثم فاصل ثم العنوان، ولا شيء بعده.
  return i > 0 && i + LAWYER_NOTES_HEADING.length === t.length && /^[^\n]{1,20}[:.)\-–]\s*$/.test(t.slice(0, i));
}

/**
 * المسودّة بلا «ملاحظات للمحامي» — لكل ما يخرج من المنصة: Word وPDF والنصّ والنسخ.
 *
 * يُحذف القسم من عنوانه إلى أوّل عنوانٍ في مستواه أو أعلى، أو إلى آخر النصّ.
 * فلو وضعه النموذج في غير آخر المستند لم يُحذف ما بعده من المتن.
 */
export function stripLawyerNotes(md: string): string {
  const lines = normalize(md).split('\n');
  const out: string[] = [];
  let skipLevel = 0;
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    const h = inFence ? null : line.match(HEADING);
    if (h) {
      const level = h[1].length;
      if (skipLevel && level <= skipLevel) skipLevel = 0;
      if (!skipLevel && isLawyerNotesHeading(h[2])) {
        skipLevel = level;
        continue;
      }
    }
    if (!skipLevel) out.push(line);
  }
  // ما قبل القسم قد ينتهي بخطٍّ فاصل وأسطرٍ فارغة كانت تفصله عنه.
  while (out.length && (!out[out.length - 1].trim() || RULE.test(out[out.length - 1]))) out.pop();
  return out.join('\n');
}

export function parseDraft(md: string): Block[] {
  const lines = normalize(md).split('\n');
  const out: Block[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!line.trim()) continue;
    if (inFence) {
      out.push({ kind: 'para', inl: [{ text: line.trim() }] });
      continue;
    }

    if (isTableRow(line)) {
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(splitRow(lines[i++]));
      i--;
      out.push(tableBlock(rows));
      continue;
    }

    if (RULE.test(line)) {
      out.push({ kind: 'rule' });
      continue;
    }

    const h = line.match(HEADING);
    if (h) {
      const inl = parseInline(stripWrappingBold(h[2]));
      if (plain(inl)) out.push({ kind: 'heading', level: Math.min(h[1].length, 4) as 1 | 2 | 3 | 4, inl });
      continue;
    }

    const q = line.match(QUOTE);
    if (q) {
      if (q[1].trim()) out.push({ kind: 'quote', inl: parseInline(q[1].trim()) });
      continue;
    }

    const b = line.match(BULLET);
    if (b) {
      out.push({ kind: 'item', ordered: false, marker: '•', depth: depthOf(b[1]), inl: parseInline(b[2].trim()) });
      continue;
    }

    const o = line.match(ORDERED);
    if (o) {
      out.push({ kind: 'item', ordered: true, marker: o[2] + o[3], depth: depthOf(o[1]), inl: parseInline(o[4].trim()) });
      continue;
    }

    const inl = parseInline(line.trim());
    if (plain(inl)) out.push({ kind: 'para', inl });
  }
  return out;
}

/**
 * التغليظ والروابط داخل السطر، وما سواهما يُنزع.
 *
 * والنزع لا الإبقاء: نجمةٌ يتيمة أو خطٌّ مائل بالنجمة الواحدة أو علامة
 * شيفرة — كلّها تظهر في Word حروفاً كما هي، والمستند يُسلَّم إلى عميل.
 */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*(.+?)\*\*|__(.+?)__/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) pushLinks(out, src.slice(last, m.index), false);
    pushLinks(out, m[1] ?? m[2], true);
    last = re.lastIndex;
  }
  if (last < src.length) pushLinks(out, src.slice(last), false);
  return merge(out);
}

/** النصّ المجرّد لسطرٍ من الكتل. */
export function plain(inl: Inline[]): string {
  return inl.map((x) => x.text).join('').trim();
}

/**
 * النصّ المجرّد للمسودّة كلّها — للتنزيل نصّاً وللنسخ.
 *
 * سطرٌ فارغ واحد بين الفقرات، ولا فراغ بين عناصر القائمة الواحدة ولا بين صفوف
 * الجدول. وخلايا الجدول يفصلها « — » لا `|`.
 */
export function toPlainText(md: string): string {
  const blocks = parseDraft(md);
  const parts: string[] = [];
  let prev: Block['kind'] | null = null;
  for (const b of blocks) {
    if (b.kind === 'rule') continue;
    let text: string;
    if (b.kind === 'item') {
      text = `${'  '.repeat(b.depth)}${b.marker} ${plain(b.inl)}`;
    } else if (b.kind === 'table') {
      const rows = b.header ? [b.header, ...b.rows] : b.rows;
      text = rows.map((r) => r.map(plain).join(' — ')).join('\n');
    } else {
      text = plain(b.inl);
    }
    const tight = prev === 'item' && b.kind === 'item';
    parts.push((parts.length ? (tight ? '\n' : '\n\n') : '') + text);
    prev = b.kind;
  }
  return parts.join('');
}

// ── داخلي ──

function normalize(md: string): string {
  return md.replace(/\r\n?/g, '\n').replace(/ /g, ' ');
}

function depthOf(indent: string): number {
  return Math.min(2, Math.floor(indent.replace(/\t/g, '  ').length / 2));
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith('|') && t.indexOf('|', 1) !== -1;
}

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim());
}

function tableBlock(rows: string[][]): Block {
  const isSep = (r: string[]) => r.every((c) => c === '' || SEPARATOR_CELL.test(c.replace(/\s/g, '')));
  const hasHeader = rows.length > 1 && isSep(rows[1]);
  const body = rows.filter((r, i) => !(i === 1 && hasHeader) && !isSep(r));
  const cells = body.map((r) => r.map((c) => parseInline(c)));
  const width = Math.max(1, ...cells.map((r) => r.length));
  const pad = (r: Inline[][]) => (r.length < width ? [...r, ...Array.from({ length: width - r.length }, () => [])] : r);
  if (hasHeader && cells.length) {
    return { kind: 'table', header: pad(cells[0]), rows: cells.slice(1).map(pad) };
  }
  return { kind: 'table', header: null, rows: cells.map(pad) };
}

function stripWrappingBold(s: string): string {
  const m = s.trim().match(/^(\*\*|__)(.+)\1$/);
  return m && !m[2].includes(m[1]) ? m[2] : s;
}

function pushLinks(out: Inline[], s: string, bold: boolean): void {
  const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(piece(s.slice(last, m.index), bold));
    const href = /^https?:\/\//i.test(m[2]) ? m[2] : undefined;
    out.push({ ...piece(m[1], bold), ...(href ? { href } : {}) });
    last = re.lastIndex;
  }
  if (last < s.length) out.push(piece(s.slice(last), bold));
}

function piece(s: string, bold: boolean): Inline {
  const text = s
    // الخطّ المائل بالنجمة الواحدة: تُنزع النجمتان ويبقى ما بينهما
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, '$1$2')
    // ما بقي من النجوم المزدوجة يتيماً — تغليظٌ لم يُغلق
    .replace(/\*\*+/g, '')
    .replace(/`+/g, '')
    // الهروب: `\*` تُكتب نجمةً
    .replace(/\\([\\`*_#|[\]()>-])/g, '$1')
    // فراغٌ مضاعف خلّفه نزعُ علامة
    .replace(/ {2,}/g, ' ');
  return bold ? { text, bold: true } : { text };
}

function merge(list: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const x of list) {
    if (!x.text) continue;
    const prev = out[out.length - 1];
    if (prev && !!prev.bold === !!x.bold && prev.href === x.href) prev.text += x.text;
    else out.push({ ...x });
  }
  return out;
}
