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

export default function MessageContent({
  messageId,
  html,
  highlights,
}: {
  messageId: string;
  html: string;
  highlights: RenderableHighlight[];
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) renderHighlights(ref.current, highlights);
  }, [html, highlights]);

  return (
    <div
      ref={ref}
      className="msg-text"
      data-message-id={messageId}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
