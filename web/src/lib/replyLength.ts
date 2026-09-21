import { useEffect, useState } from 'react';

/* طول الردّ — تفضيلٌ للقارئ لا إعدادٌ للمحادثة.
 *
 * المحامي يختار مرّةً كيف يحبّ أن يقرأ، فيسري اختياره على ما بعده. ولو
 * عاش الاختيار في حالة `ChatView` وحدها لضاع مع أوّل انتقال: `App.tsx`
 * يهدم الشاشة عند كل تبديل محادثة (`key={activeConv}`)، فيعود الخيار إلى
 * «متوسط» وقد اختار «قصير» قبل سطرين.
 *
 * والتخزين دائم لا للجلسة — بخلاف مسوّدة صندوق الكتابة: تلك نصٌّ كتبه
 * القارئ ولا يُترك في حاسوبٍ مشترك، وهذا تفضيلُ قراءةٍ لا يكشف شيئاً.
 *
 * والآلية آلية `theme.ts` نفسها: قراءةٌ وكتابةٌ داخل `try/catch` لأن
 * التخزين يُمنَع في نافذةٍ خاصة، وغيابُ المفتاح معناه الافتراض.
 *
 * الألفاظ والمجموعة المغلقة مسجَّلة في `naf-terms.md` §٣ تحت «ضبط الردّ» —
 * ولا خامسةَ لها. والدرجة تضبط الطول وحده: الجهد وسقف الرموز في
 * `src/routes/chat.ts` لا يتغيّران بها.
 */

export type ReplyLength = 'short' | 'medium' | 'long' | 'extended';

const STORAGE_KEY = 'naf-reply-length';

const DEFAULT: ReplyLength = 'medium';

export const REPLY_LENGTHS: { value: ReplyLength; label: string }[] = [
  { value: 'short', label: 'قصير' },
  { value: 'medium', label: 'متوسط' },
  { value: 'long', label: 'طويل' },
  { value: 'extended', label: 'موسّع' },
];

function isReplyLength(v: unknown): v is ReplyLength {
  return REPLY_LENGTHS.some((o) => o.value === v);
}

/** الدرجة المحفوظة — «متوسط» إن لم توجد أو تعذّر التخزين. */
export function readReplyLength(): ReplyLength {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isReplyLength(v) ? v : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

/** يحفظ الدرجة. و«متوسط» تُمحى ولا تُخزَّن، فيبقى غياب المفتاح معناه الافتراض. */
export function writeReplyLength(value: ReplyLength): void {
  try {
    if (value === DEFAULT) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* التخزين غير متاح — يبقى الاختيار لهذه الشاشة */
  }
}

export function useReplyLength(): [ReplyLength, (value: ReplyLength) => void] {
  const [value, setValue] = useState<ReplyLength>(readReplyLength);

  useEffect(() => {
    writeReplyLength(value);
  }, [value]);

  return [value, setValue];
}
