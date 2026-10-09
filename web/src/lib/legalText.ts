// الجدول داخل نصّ المادة (§3-13، §7-2 من وثيقة الاستيراد).
//
// اللوائح المقروءة من ملفّات الجهات تحمل جداولها في `text` أسطراً: خلايا كل صفٍّ
// مفصولةٌ بـ« | » (مسافة · خط عمودي · مسافة)، وأوّل صفٍّ في الجدول رأسُه. والخلية
// الفارغة في الأصل «—»، والمدموجة مكرّرةٌ في كل صف. فتُعرض جدولاً، وإلا ظهرت
// أسطراً تقطعها خطوط.
//
// والنصّ نفسه لا يُغيَّر: هذا تقسيمٌ للعرض وحده. ما يُنسخ ويُستشهد به ويُضمَّن
// هو `text` كما ورد.

/** فاصلُ الخلايا كما يكتبه الملف — بمسافتيه، فلا يُقرأ كلُّ خطٍّ عموديّ فاصلاً. */
const CELL_SEP = ' | ';

export type LegalTextBlock = { kind: 'text'; text: string } | { kind: 'table'; head: string[]; rows: string[][] };

/**
 * يقسم نصّ المادة فقراتٍ وجداول.
 *
 * الجدول سطران متتاليان فأكثر فيهما الفاصل — رأسٌ وصفٌّ على الأقل. وسطرٌ واحد
 * فيه الفاصل يبقى نصّاً: جدولٌ بلا صفّ لا يُقرأ جدولاً، وجملةٌ فيها « | »
 * مصادفةً لا تُقلب خلايا. والصفّ الأقصر من رأسه يُكمَّل بخلايا فارغة، فلا تنزاح
 * أعمدته.
 */
export function splitLegalText(text: string): LegalTextBlock[] {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const blocks: LegalTextBlock[] = [];
  let prose: string[] = [];
  const flush = () => {
    const joined = prose.join('\n');
    if (joined.trim()) blocks.push({ kind: 'text', text: joined.replace(/^\n+|\n+$/g, '') });
    prose = [];
  };

  let i = 0;
  while (i < lines.length) {
    let j = i;
    while (j < lines.length && lines[j].includes(CELL_SEP)) j++;
    if (j - i >= 2) {
      flush();
      const cells = lines.slice(i, j).map((l) => l.split(CELL_SEP).map((c) => c.trim()));
      const width = Math.max(...cells.map((r) => r.length));
      const [head, ...rows] = cells.map((r) => [...r, ...Array(width - r.length).fill('')]);
      blocks.push({ kind: 'table', head, rows });
      i = j;
    } else {
      prose.push(lines[i]);
      i++;
    }
  }
  flush();
  return blocks;
}
