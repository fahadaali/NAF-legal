/**
 * حاوية التمرير المعلومة، وإعادتُها إلى أعلاها عند تبدّل الشاشة.
 *
 * الصفحة لا تُمرَّر في هذه المنصة — الهيكل ثابت و`.admin-wrap` وحدها هي التي
 * تُمرَّر. و`window.scrollTo` لا يمسّها، فالموضع يبقى حيث تركه القارئ مهما
 * تبدّل ما فيها.
 *
 * **وأثرُ ذلك ليس ترفاً.** المسؤول يقرأ آخر جدولٍ في تبويب، ثم يفتح تبويباً
 * آخر فيجده مفتوحاً من وسطه: ترويستُه وأزرارُه فوق حدّ الشاشة ولا شيء يقول
 * إنها هناك. ثم يُنزل قليلاً فتظهر له محتوياتٌ «فوق» لم تكن ظاهرة — وهي لم
 * تظهر، بل كان ينظر إلى أسفلها من أوّل لحظة.
 *
 * ولذلك تُعاد الحاوية إلى أعلاها عند كل تبدّلِ شاشة: التبويب، وقسمُ قاعدة
 * المعرفة، ومصدرُ الإضافة، وفتحُ نظامٍ والرجوعُ منه، وتبدّلُ طابور المراجعة.
 */
import { createContext, useContext, useEffect, type ReactNode, type RefObject } from 'react';

type BoxRef = RefObject<HTMLElement | null>;

const ScrollBox = createContext<BoxRef | null>(null);

export function ScrollBoxProvider({ value, children }: { value: BoxRef; children: ReactNode }) {
  return <ScrollBox.Provider value={value}>{children}</ScrollBox.Provider>;
}

/**
 * يعيد الحاوية إلى أعلاها كلّما تبدّل `key`.
 *
 * `key` نصٌّ واحد لا مصفوفة اعتماديات: تبدُّلُ الشاشة يوصَف بمفتاحٍ يجمع ما
 * يعرّفها — «القسم|المصدر» — فيقرأ القارئ سببَ الإعادة من موضع النداء.
 *
 * ولا تقع الإعادة على أوّل رسم: الشاشة تُفتح من أعلاها أصلاً، وإعادةُ ما هو
 * في موضعه تُلغي استعادةَ الموضع التي يفعلها المتصفّح بعد إعادة التحميل.
 */
export function useScrollReset(key: string) {
  const box = useContext(ScrollBox);
  useEffect(() => {
    const el = box?.current;
    if (!el || el.scrollTop === 0) return;
    // بلا حركة: هذه ليست رحلةً يتابعها القارئ بعينه، بل شاشةٌ أخرى حلّت محلّ
    // الأولى. والانزلاق الناعم عبر ألفَي بكسل يُري ما لا علاقة له بها.
    el.scrollTo({ top: 0 });
  }, [box, key]);
}
