import { useCallback, useState } from 'react';

/* طول الردّ — تفضيلٌ للقارئ لا إعدادٌ للمحادثة.
 *
 * المحامي يختار مرّةً كيف يحبّ أن يقرأ، فيسري اختياره على ما بعده. ولو
 * عاش الاختيار في حالة `ChatView` وحدها لضاع مع أوّل انتقال: `App.tsx`
 * يهدم الشاشة عند كل تبديل محادثة (`key={activeConv}`)، فيعود الخيار إلى
 * «متوسط» وقد اختار «قصير» قبل سطرين.
 *
 * والتخزين طبقتان. لكل نافذةٍ درجتُها (`sessionStorage`): المحامي يعمل في
 * محادثتين جنباً إلى جنب، واحدةٌ يريدها «قصير» والأخرى «موسّع»، ولو اشتركتا
 * في مفتاحٍ واحد لقلبت الأولى الثانيةَ عند أوّل تبديل محادثةٍ فيها — والقائمة
 * تعرض ما لا يُرسَل. وآخرُ اختيارٍ في أيّ نافذة يُحفظ دائماً (`localStorage`)
 * فتبدأ به النافذة الجديدة. وهذا تفضيلُ قراءةٍ لا يكشف شيئاً، بخلاف مسوّدة
 * صندوق الكتابة التي لا تُترك في حاسوبٍ مشترك.
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

function readFrom(storage: Storage): ReplyLength | null {
  const v = storage.getItem(STORAGE_KEY);
  return isReplyLength(v) ? v : null;
}

/** درجة هذه النافذة، ثم آخرُ اختيارٍ في أيّ نافذة، ثم «متوسط». */
export function readReplyLength(): ReplyLength {
  try {
    return readFrom(sessionStorage) ?? readFrom(localStorage) ?? DEFAULT;
  } catch {
    return DEFAULT;
  }
}

/** يحفظ الدرجة للنافذة ولما يُفتح بعدها. وتُخزَّن «متوسط» أيضاً في النافذة:
 *  غيابُ مفتاحها يعني «خذ آخر اختيار» لا «متوسط». */
export function writeReplyLength(value: ReplyLength): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, value);
    if (value === DEFAULT) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* التخزين غير متاح — يبقى الاختيار لهذه الشاشة */
  }
}

/** والكتابة عند الاختيار وحده لا عند التركيب: شاشةٌ تُركَّب بدرجة نافذتها
 *  لا تكتبها فوق آخر اختيارٍ في نافذةٍ أخرى. */
export function useReplyLength(): [ReplyLength, (value: ReplyLength) => void] {
  const [value, setValue] = useState<ReplyLength>(readReplyLength);

  const choose = useCallback((next: ReplyLength) => {
    writeReplyLength(next);
    setValue(next);
  }, []);

  return [value, choose];
}
