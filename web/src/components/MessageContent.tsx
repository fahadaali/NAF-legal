// نصّ الرسالة كما يُعرض، وعليه ما ظُلِّل منه.
//
// التظليل يُرسم في الشجرة بعد أن يضعها React لا في نصّ الـHTML قبلها: الحقن
// في النصّ يقتضي التعامل مع الوسوم بالتعابير النمطية — وعلامةُ تظليلٍ تقع
// داخل وسمٍ تكسر العرض كلَّه. والرسم على الشجرة يعرف حدود العُقد فلا يقطع
// وسماً أبداً (`lib/highlight.ts`).
//
// والترتيب مقصود: React يكتب `innerHTML` كلَّما تغيّر النصّ — أي مع كل مقطعٍ
// يصل أثناء البثّ — فيمحو ما رُسم. والأثر يعيد الرسم بعده، فيبقى التظليل
// ظاهراً على ردٍّ يُحرَّر أو يُعاد بناؤه.
import { useEffect, useRef } from 'react';
import { renderHighlights, type RenderableHighlight } from '../lib/highlight';
import { linkArticleRefs, type ArticleRef, type KnownLaw } from '../lib/articleLinks';
import { CITE_MARK_CLASS, placeCiteMarks, type CitationSpan } from '../lib/citeMarks';

const NO_SPANS: CitationSpan[] = [];

export default function MessageContent({
  messageId,
  html,
  highlights,
  laws = [],
  onOpenArticle,
  /** الربط يُؤجَّل حتى يسكن النصّ — انظر الأثر أدناه. */
  linkable = true,
  content = '',
  citeSpans = NO_SPANS,
  citeLabel,
  citeOpenable,
  onOpenCite,
}: {
  messageId: string;
  html: string;
  highlights: RenderableHighlight[];
  /** أنظمةُ هذا الردّ — لا يُربط إلا ما طابق واحداً منها. */
  laws?: KnownLaw[];
  onOpenArticle?: (ref: ArticleRef) => void;
  linkable?: boolean;
  /** نصُّ markdown الذي وُلّد منه `html` — تُطابَق عليه مواضع الإسناد. */
  content?: string;
  /** مواضعُ الإسناد المحفوظة مع الردّ — `lib/citeMarks.ts`. */
  citeSpans?: CitationSpan[];
  citeLabel?: (key: string) => string;
  citeOpenable?: (key: string) => boolean;
  onOpenCite?: (key: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    /* الربط قبل التظليل: هذا يُنشئ عُقداً، وذاك يعرف حدود العُقد فيعمل على
       الشجرة النهائية. واللفُّ لا يغيّر `textContent` فتبقى إزاحاتُ التظليل
       صحيحة على أي حال.

       والربط لا يقع أثناء البثّ: الأثر يُعاد مع كل مقطعٍ يصل، فمرورٌ على
       الشجرة كلِّها مع كل مقطع كلفةٌ بلا مقابل — وإشارةٌ نصفُها وصل تُربط
       برقمٍ ناقص ثم تُمحى في المقطع التالي. */
    if (linkable && onOpenArticle) linkArticleRefs(ref.current, laws, onOpenArticle);
    /* علاماتُ الإسناد بعد الربط — تُوضع بعد الرابط لا داخله — وقبل التظليل.
       ولا نصَّ فيها، فلا تمسّ إزاحاته. */
    if (linkable && citeSpans.length && citeLabel && citeOpenable) {
      placeCiteMarks(ref.current, content, citeSpans, citeLabel, citeOpenable);
    }
    renderHighlights(ref.current, highlights);
  }, [html, highlights, laws, linkable, onOpenArticle, content, citeSpans, citeLabel, citeOpenable]);

  return (
    <div
      ref={ref}
      className="msg-text"
      data-message-id={messageId}
      onClick={(e) => {
        // تفويضٌ واحد للعلامات كلِّها: تُنشأ في الشجرة بعد React، فلا مستمع لكلٍّ منها.
        const mark = (e.target as HTMLElement).closest?.(`button.${CITE_MARK_CLASS}`) as HTMLElement | null;
        if (mark?.dataset.key && onOpenCite) onOpenCite(mark.dataset.key);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
