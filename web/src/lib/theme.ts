import { useEffect, useState } from 'react';

/* مُبدِّل المظهر ثلاثي الحالات — العقد المسجَّل في naf-ui (`naf-theme-toggle`).
   حالتان فخّ: قارئٌ نظامه فاتح واختار «الوضع الفاتح» لا يجد طريقاً للعودة
   إلى «يتبع النظام» عند تغيّره. ولذلك «يتبع النظام» هي الافتراض وتبقى
   خياراً ظاهراً لا مخبوءاً.

   الآلية صنف `dark` على عنصر الجذر — وهو ما يتوقّعه naf-theme.css. */

export type ThemeChoice = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'naf-theme';

/** الاختيار المحفوظ — «يتبع النظام» إن لم يوجد أو تعذّر التخزين. */
export function readThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** يطبّق الاختيار على عنصر الجذر ويحفظه. */
export function applyThemeChoice(choice: ThemeChoice): void {
  const dark =
    choice === 'dark' || (choice === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  try {
    // «يتبع النظام» تُمحى ولا تُخزَّن، فيبقى غياب المفتاح معناه الافتراض
    if (choice === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    /* التخزين غير متاح — يبقى الاختيار لهذه الجلسة */
  }
  // القيمتان هما --background في ثيم ناف بالوضعين، مكتوبتان hex بموجب
  // استثناء <meta name="theme-color"> في CLAUDE.md §1: الوسم لا يحلّ var().
  //
  // ونظيرهما في `web/public/theme-init.js` — وهو الذي يضبط الوسم قبل أوّل
  // رسم، وهذه تتبعه عند تبديل المظهر. **موضعان لا ثالث لهما، ويتغيّران
  // معاً:** كان الوسم ساكناً على قيمة الوضع الداكن وحدها، فيرى صاحبُ الوضع
  // الفاتح شريطَ متصفّحٍ داكناً حتى يُركَّب React.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#1c2433' : '#e8ebed');
}

export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(readThemeChoice);

  useEffect(() => {
    applyThemeChoice(choice);
    if (choice !== 'system') return;
    // «يتبع النظام» تتابع تغيّر تفضيل النظام والصفحة مفتوحة
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyThemeChoice('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [choice]);

  return [choice, setChoice];
}
