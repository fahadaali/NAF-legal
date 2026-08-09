/**
 * تظليل النصّ داخل فقاعة الرسالة — بين الإزاحة والشجرة.
 *
 * الرسالة تُعرض HTML مولَّداً من `renderMarkdown`، والتظليل يُحفَظ بإزاحتين
 * على **نصّ** ذلك العرض لا على وسومه. والسبب أن الوسوم تتغيّر: عارضُ
 * `markdown` قد يُحسَّن غداً فيلفّ الفقرة بوسمٍ آخر، ونصُّها هو هو. فما
 * يُحفَظ هو ما لا يتبدّل.
 *
 * والترجمة بين الاثنين هنا، في موضعٍ واحد: من تحديدِ القارئ إلى إزاحتين
 * (`offsetsOfSelection`)، ومن الإزاحتين إلى وسومٍ تُرسم (`renderHighlights`).
 */

/** تظليلٌ كما يُرسم: إزاحتاه، ومقتطعُه الشاهد، ومعرّفه. */
export interface RenderableHighlight {
  id: string;
  start: number;
  end: number;
  /** المقتطع كما ظُلِّل — يُقابَل به الموضع قبل الرسم. */
  text: string;
}

/** صنفُ الوسم المرسوم، وسمةُ معرّفه. الاثنان يُقرآن في `styles.css` وهنا. */
const MARK_SELECTOR = 'mark[data-hl]';

/**
 * يمسح ما رُسم من تظليل ويعيد النصّ عُقداً متّصلة.
 *
 * **و`normalize` ليست تجميلاً.** الوسمُ يُدخل قطعاً في مجرى النصّ، فرفعُه
 * يترك عُقداً متجاورة تُحصى كلٌّ منها وحدها. والإزاحات تُقاس بمسحٍ متتابع
 * على العُقد، فبقاؤها مفكَّكة لا يُغيّر مجموع الطول — لكنه يجعل كلَّ رسمٍ
 * تالٍ يقسّم ما قُسِّم، حتى تصير الفقرة مئةَ عقدة.
 */
export function clearHighlights(root: HTMLElement): void {
  const marks = Array.from(root.querySelectorAll<HTMLElement>(MARK_SELECTOR));
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }
  if (marks.length) root.normalize();
}

/**
 * إزاحتا تحديدٍ داخل عنصر، ومقتطعُه.
 *
 * تُقاسان بمدىً يبدأ من أوّل العنصر وينتهي عند بداية التحديد: `Range.toString`
 * تعيد نصَّ المدى بلا وسومه، وهو المقياس نفسه الذي يُرسم به لاحقاً.
 *
 * ويعيد `null` إذا خرج طرفٌ من التحديد عن العنصر — تحديدٌ يمتدّ من رسالةٍ
 * إلى التي تليها ليس تظليلاً في واحدةٍ منهما.
 */
export function offsetsOfSelection(
  root: HTMLElement,
  range: Range
): { start: number; end: number; text: string } | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const text = range.toString();
  if (!text.trim()) return null;

  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  return { start, end: start + text.length, text };
}

/**
 * يرسم التظليلات على نصّ العنصر.
 *
 * ويُسقط صامتاً ما لم يعد موضعُه هو موضعه: المسوّدة تُحرَّر وتُعتمد، فكلمةٌ
 * تُزاح تُزيح كلَّ إزاحةٍ بعدها. فيُقابَل المقتطعُ الشاهد بما في الموضع، وما
 * خالفه لم يُرسم. وتظليلٌ ذهب أهون من تظليلٍ يقع على الجملة الخطأ في مستندٍ
 * قانوني.
 */
export function renderHighlights(root: HTMLElement, highlights: RenderableHighlight[]): void {
  clearHighlights(root);
  if (!highlights.length) return;

  const full = root.textContent ?? '';
  const ordered = [...highlights].sort((a, b) => a.start - b.start || b.end - a.end);

  const drawable: RenderableHighlight[] = [];
  let lastEnd = 0;
  for (const h of ordered) {
    if (h.end <= h.start || h.end > full.length) continue;
    // متداخلان: الأسبقُ موضعاً يُرسم وحده. وسمٌ داخل وسمٍ يُضاعف اللون
    // فيقرأ القارئ درجتين لمعنى واحد.
    if (h.start < lastEnd) continue;
    // الشاهد يُقابَل بأوّل المدى: الخادم يقصّ المقتطعَ الطويل، فيبقى بادئةً
    // له لا نسخةً منه.
    if (full.slice(h.start, h.start + h.text.length) !== h.text) continue;
    drawable.push(h);
    lastEnd = h.end;
  }

  // من الآخر إلى الأوّل: الرسم يقسّم عُقد النصّ، وتقسيمُ ما قبلَ موضعٍ يُزيح
  // ما بعده. والبدء من الآخر يجعل كلَّ رسمٍ يقع على شجرةٍ لم تُمسّ قبله.
  for (let i = drawable.length - 1; i >= 0; i--) draw(root, drawable[i]);
}

/** يلفّ مدىً واحداً — قطعةً في كل عقدة نصٍّ يمرّ بها. */
function draw(root: HTMLElement, h: RenderableHighlight): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const pieces: { node: Text; from: number; to: number }[] = [];
  let pos = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const nodeStart = pos;
    const nodeEnd = pos + node.data.length;
    pos = nodeEnd;
    if (nodeEnd > h.start && nodeStart < h.end) {
      pieces.push({
        node,
        from: Math.max(0, h.start - nodeStart),
        to: Math.min(node.data.length, h.end - nodeStart),
      });
    }
    node = walker.nextNode() as Text | null;
  }

  /* الشجرة تُغيَّر بعد أن يفرغ المشّاء لا أثناءه: `splitText` يُدخل عقدةً
     جديدة، ومشّاءٌ يمرّ على ما يُنشأ أمامه يعيد المرور على ما لفَّه للتوّ. */
  for (const piece of pieces) {
    if (piece.to <= piece.from) continue;
    // فراغُ التنسيق بين الكتل عقدةُ نصٍّ أيضاً — ولفُّه يرسم شريطاً ملوّناً
    // بين فقرتين لا نصَّ فيه.
    if (!piece.node.data.slice(piece.from, piece.to).trim()) continue;

    let target = piece.node;
    if (piece.from > 0) target = target.splitText(piece.from);
    if (piece.to - piece.from < target.data.length) target.splitText(piece.to - piece.from);

    const mark = document.createElement('mark');
    mark.className = 'msg-highlight';
    mark.dataset.hl = h.id;
    target.parentNode?.insertBefore(mark, target);
    mark.appendChild(target);
  }
}

/** معرّفُ التظليل الذي تقع فيه هذه العقدة، إن وقعت في واحد. */
export function highlightIdAt(root: HTMLElement, node: Node | null): string | null {
  let current: Node | null = node;
  while (current && current !== root) {
    if (current instanceof HTMLElement && current.dataset.hl) return current.dataset.hl;
    current = current.parentNode;
  }
  return null;
}
