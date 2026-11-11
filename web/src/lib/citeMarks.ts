/**
 * علاماتُ الإسناد داخل نصّ الردّ — رقمٌ مرتفع بعد الجملة المسنودة يفتح مادتها.
 *
 * الخادم يحفظ مع الردّ `citation_spans`: لكل مقطعٍ أسنده Claude إلى موادّ بعينها
 * إزاحتاه في **نصّ markdown** ومفاتيحُ موادّه. والعرضُ HTML مولَّد من ذلك النصّ،
 * فالإزاحتان لا تصلحان عليه مباشرةً: `**` و`#` وعلاماتُ القوائم تسقط في العرض.
 *
 * فيُطابَق المقطعُ بآخر نصّه لا بإزاحته: تُنزع علاماتُ markdown من ذيله، ويُبحث
 * عنه في نصّ الشجرة بعد توحيد المسافات، وتوضع العلامة حيث انتهى. وما لا يُطابَق
 * يُترك بلا علامة — موادّه في سطر «المصادر» تحت الردّ على أيّ حال، وعلامةٌ في غير
 * موضعها في مستندٍ قانوني أسوأ من غيابها.
 *
 * **والعلامة بلا نصّ.** رقمُها من `data-n` في CSS، واسمُها لقارئ الشاشة في
 * `aria-label`. فلا يتغيّر `textContent` بها، وتبقى إزاحاتُ التظليل
 * (`lib/highlight.ts`) صحيحةً على الشجرة نفسها.
 */

export interface CitationSpan {
  start: number;
  end: number;
  keys: string[];
}

/** صنفُ العلامة — يُقرأ في `styles.css` وفي تفويض النقر. */
export const CITE_MARK_CLASS = 'cite-mark';

/** أقصرُ ذيلٍ يُطابَق به: ما دونه يتكرّر في النصّ فيضع العلامة في غير موضعها. */
const MIN_ANCHOR = 8;
const MAX_ANCHOR = 48;

/** نصُّ markdown بلا علاماته، بمسافاتٍ موحَّدة — كما يقرؤه العرض تقريباً. */
function plainOf(md: string): string {
  return md
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|\s)\*(\S)/g, '$1$2')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

interface TextIndex {
  /** نصُّ الشجرة بمسافاتٍ موحَّدة. */
  flat: string;
  /** لكل حرفٍ في `flat`: عقدتُه وموضعُه فيها. */
  at: { node: Text; offset: number }[];
}

function indexText(root: HTMLElement): TextIndex {
  const at: TextIndex['at'] = [];
  let flat = '';
  let lastSpace = true;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    const s = node.data;
    for (let i = 0; i < s.length; i++) {
      const space = /\s/.test(s[i]);
      if (space && lastSpace) continue;
      flat += space ? ' ' : s[i];
      at.push({ node, offset: i });
      lastSpace = space;
    }
  }
  return { flat, at };
}

/** ما لا تُوضع العلامة داخله: زرٌّ داخل زرّ لا تبلغه لوحة المفاتيح. */
function interactiveAncestor(node: Node, root: HTMLElement): HTMLElement | null {
  let el = node.parentElement;
  while (el && el !== root) {
    if (el.matches('a, button')) return el;
    el = el.parentElement;
  }
  return null;
}

export function clearCiteMarks(root: HTMLElement): void {
  root.querySelectorAll(`.${CITE_MARK_CLASS}`).forEach((m) => m.remove());
}

/**
 * يضع العلامات. `label(key)` اسمُ المادة لقارئ الشاشة، و`openable(key)` هل لها
 * ما يُفتح — الوثيقة المرفوعة تُرقَّم ولا تُفتح.
 */
export function placeCiteMarks(
  root: HTMLElement,
  content: string,
  spans: CitationSpan[],
  label: (key: string) => string,
  openable: (key: string) => boolean
): void {
  clearCiteMarks(root);
  if (!spans.length) return;
  const { flat, at } = indexText(root);

  // المواضع أوّلاً على الشجرة كما هي، ثم الوضعُ من الآخر إلى الأول: قسمةُ عقدةٍ
  // تُبطل مواضعَ ما بعدها فيها، ولا تمسّ ما قبلها.
  const places: { idx: number; keys: string[] }[] = [];
  let cursor = 0;
  for (const span of [...spans].sort((a, b) => a.end - b.end)) {
    if (!span.keys.length) continue;
    const anchor = plainOf(content.slice(span.start, span.end)).slice(-MAX_ANCHOR).trim();
    if (anchor.length < MIN_ANCHOR) continue;
    let found = flat.indexOf(anchor, cursor);
    if (found < 0) found = flat.indexOf(anchor);
    if (found < 0) continue;
    const idx = found + anchor.length - 1;
    cursor = idx + 1;
    const same = places.find((p) => p.idx === idx);
    if (same) same.keys.push(...span.keys.filter((k) => !same.keys.includes(k)));
    else places.push({ idx, keys: [...span.keys] });
  }

  // الأرقام بترتيب الظهور في النصّ، والمادةُ الواحدة برقمٍ واحد أينما تكرّرت.
  places.sort((a, b) => a.idx - b.idx);
  const numbers = new Map<string, number>();
  for (const p of places) for (const k of p.keys) if (!numbers.has(k)) numbers.set(k, numbers.size + 1);

  for (const p of [...places].reverse()) {
    const { node, offset } = at[p.idx];
    // بعد الحرف الأخير من المقطع — أو بعد الرابط الذي ينتهي فيه.
    const host = interactiveAncestor(node, root);
    let parent: Node;
    let ref: Node | null;
    if (host) {
      parent = host.parentNode!;
      ref = host.nextSibling;
    } else {
      ref = node.splitText(offset + 1);
      parent = ref.parentNode!;
    }
    for (const key of p.keys) {
      const open = openable(key);
      const mark = document.createElement(open ? 'button' : 'sup');
      mark.className = CITE_MARK_CLASS;
      mark.dataset.n = String(numbers.get(key));
      mark.dataset.key = key;
      mark.setAttribute('aria-label', label(key));
      // الزرّ يُقرأ باسمه؛ والعلامة الصمّاء بلا نصّ تحتاج دوراً يُنطق به اسمُها.
      if (open) (mark as HTMLButtonElement).type = 'button';
      else mark.setAttribute('role', 'img');
      parent.insertBefore(mark, ref);
    }
  }
}
