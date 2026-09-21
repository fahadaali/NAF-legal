/**
 * إشاراتُ المواد داخل نصّ الردّ — تصير منافذَ إلى المادة نفسها.
 *
 * شاراتُ المصادر تحت الردّ تفتح المادة منذ زمن، لكنها صفٌّ واحد في آخره:
 * من قرأ «…وفقاً للمادة ٧٧ من نظام العمل» في وسط جدولٍ من عشرة صفوف يعود
 * إلى الصفّ فيبحث بعينه عن الشارة التي تقابل السطر الذي هو فيه. والعبارة
 * نفسها هي المنفذ الطبيعي.
 *
 * ── لماذا على الشجرة لا على نصّ الـHTML ──
 *
 * `renderMarkdown` يهرّب الـHTML أوّلاً ثم يبني الوسوم، فمرورٌ نصّيّ بعده
 * يطابق داخل الوسوم والسمات كما يطابق داخل النصّ — وعبارةٌ تقع داخل وسمٍ
 * تكسر العرض كلَّه. وهذا هو السبب نفسه الذي جعل التظليل يُرسم على الشجرة
 * (انظر ترويسة `MessageContent.tsx`). والمرور على عُقد النصّ يعرف حدودها
 * فلا يقطع وسماً أبداً.
 *
 * ── ولماذا الأنظمة تُمرَّر ولا تُخمَّن ──
 *
 * استخراج اسم النظام من النصّ الحرّ تخمين: «من نظام العمل على صاحب العمل
 * أن…» — أين ينتهي الاسم؟ ورابطٌ يفتح المادة الخطأ في مستندٍ قانوني أسوأ
 * من غياب الرابط. فتُمرَّر أسماءُ الأنظمة التي استُشهد بها فعلاً في هذا
 * الردّ، ولا يُربط إلا ما طابق واحداً منها حرفياً. وما استشهد به النموذج
 * ولم يُسترجَع لا رابط له — وهو الصواب: لا شيء عندنا نفتحه به، و`verify.ts`
 * يُشير إليه أصلاً.
 */

/** ما يفتحه النقر: نظامٌ ورقمُ مادة. */
export interface ArticleRef {
  lawTitle: string;
  lawId?: string;
  articleNo: string;
}

/** نظامٌ معروفٌ في هذا الردّ — من استشهاداته. */
export interface KnownLaw {
  title: string;
  lawId?: string;
}

const MARKED = 'data-article-ref';

/** لا يُربط ما كان داخل أحدها: رابطٌ داخل رابط، أو شيفرةٌ تُعرض بنصّها. */
const SKIP_INSIDE = 'a, button, code, pre, [' + MARKED + ']';

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function toWesternDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * صيغتا الإشارة كما تُكتبان فعلاً.
 *
 * الأولى صيغةُ النثر، والثانية صيغةُ سطر الإسناد الذي يُملى على النموذج في
 * `rag.ts` — «نظام العمل — المادة ٧٧ — م/٥١». وكلتاهما رقمٌ صريح: الأرقام
 * المنطوقة («الخامسة والأربعين») لا تُربط، لأن مطابقتها بـ`article_no`
 * المخزَّن تعتمد على تطابق لفظٍ لا رقم — ورابطٌ لا يُفتح أسوأ من لا رابط.
 */
function patternsFor(title: string): RegExp[] {
  const t = escapeRe(title);
  /* القوسان يُؤخذان معاً أو يُتركان معاً: `\\s*\\)?` وحدها تبتلع الفراغ
     بعد الرقم ولو لم يكن ثمّة قوس، فيمتدّ التسطير إلى ما بعد العبارة. */
  const no = '(?:\\(\\s*)?([0-9٠-٩]{1,4})(?:\\s*\\))?';
  /* وسوابقُ التعريف تدخل في اللفظ: «للمادة» و«بالمادة» و«والمادة». وبدونها
     يبدأ التسطير من وسط الكلمة. */
  const article = '(?:لل|[ولفبك]?ال)?ماد[ةه]ّ?';
  return [
    new RegExp(`${article}\\s*(?:رقم\\s*)?${no}\\s*من\\s+${t}`, 'g'),
    new RegExp(`${t}\\s*[—–‑-]\\s*${article}\\s*${no}`, 'g'),
  ];
}

interface Hit {
  start: number;
  end: number;
  ref: ArticleRef;
}

function hitsIn(text: string, laws: KnownLaw[]): Hit[] {
  const found: Hit[] = [];
  for (const law of laws) {
    if (!law.title?.trim()) continue;
    for (const re of patternsFor(law.title)) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const articleNo = toWesternDigits(m[1] ?? '');
        if (!articleNo) continue;
        found.push({
          start: m.index,
          end: m.index + m[0].length,
          ref: { lawTitle: law.title, lawId: law.lawId, articleNo },
        });
        // نمطٌ بلا تقدّمٍ يدور بلا نهاية — وهو ممكنٌ لو طابق فراغاً.
        if (re.lastIndex === m.index) re.lastIndex++;
      }
    }
  }

  /* المتداخلان: الأسبقُ موضعاً ثم الأطول. نظامان أحدهما بادئةُ الآخر —
     «نظام العمل» و«نظام العمل البحري» — يطابقان الموضع نفسه، والأطول هو
     الاسم الحقيقيّ فيه. */
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Hit[] = [];
  let lastEnd = 0;
  for (const h of found) {
    if (h.start < lastEnd) continue;
    kept.push(h);
    lastEnd = h.end;
  }
  return kept;
}

/**
 * يحوّل إشارات المواد في العنصر إلى أزرارٍ تفتح المادة.
 *
 * ويُستدعى بعد كل كتابةٍ لـ`innerHTML` — فهي تمحو ما رُسم. ولا يُضاعف عملَه
 * إن استُدعي مرّتين على شجرةٍ واحدة: ما لُفَّ صار داخل `[data-article-ref]`
 * والمشّاء يتخطّاه.
 *
 * ويسبق `renderHighlights`: ذاك يقيس بإزاحاتٍ على `textContent`، واللفُّ لا
 * يغيّر نصّاً — فتبقى إزاحاتُه صحيحة أيّاً كان الترتيب، ويبقى أن تقع
 * التظليلات على الشجرة النهائية.
 */
export function linkArticleRefs(
  root: HTMLElement,
  laws: KnownLaw[],
  onOpen: (ref: ArticleRef) => void
): void {
  if (!laws.length) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let node = walker.nextNode() as Text | null;
  while (node) {
    const parent = node.parentElement;
    if (parent && !parent.closest(SKIP_INSIDE) && node.data.includes('ماد')) targets.push(node);
    node = walker.nextNode() as Text | null;
  }

  /* الشجرة تُغيَّر بعد أن يفرغ المشّاء لا أثناءه — `splitText` يُدخل عقداً
     أمامه فيعيد المرور على ما لفَّه للتوّ. وهو الاحتراز نفسه في
     `highlight.ts`. */
  for (const target of targets) wrapAll(target, hitsIn(target.data, laws), onOpen);
}

/** يلفّ مواضعَ عقدةٍ واحدة — من الآخر إلى الأوّل حتى لا تُزاح الإزاحات. */
function wrapAll(node: Text, hits: Hit[], onOpen: (ref: ArticleRef) => void): void {
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    let target = node;
    if (h.start > 0) target = target.splitText(h.start);
    if (h.end - h.start < target.data.length) target.splitText(h.end - h.start);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'article-ref';
    button.setAttribute(MARKED, '');
    // الوسيلة المساعدة تقرأ النصّ نفسه، وهو «المادة ٧٧ من نظام العمل» —
    // فاللقب يقول ما يفعل الزرّ لا ما يقوله النصّ مرّةً ثانية.
    button.title = 'عرض نصّ المادة';
    button.addEventListener('click', () => onOpen(h.ref));
    target.parentNode?.insertBefore(button, target);
    button.appendChild(target);
  }
}
