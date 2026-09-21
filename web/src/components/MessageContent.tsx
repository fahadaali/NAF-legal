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

export default function MessageContent({
  messageId,
  html,
  highlights,
  laws = [],
  onOpenArticle,
  /** الربط يُؤجَّل حتى يسكن النصّ — انظر الأثر أدناه. */
  linkable = true,
}: {
  messageId: string;
  html: string;
  highlights: RenderableHighlight[];
  /** أنظمةُ هذا الردّ — لا يُربط إلا ما طابق واحداً منها. */
  laws?: KnownLaw[];
  onOpenArticle?: (ref: ArticleRef) => void;
  linkable?: boolean;
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
    renderHighlights(ref.current, highlights);
  }, [html, highlights, laws, linkable, onOpenArticle]);

  return (
    <div
      ref={ref}
      className="msg-text"
      data-message-id={messageId}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
