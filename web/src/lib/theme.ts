import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  );

  useEffect(() => {
    // صنف `dark` هو آلية ثيم ناف — مصدر حقيقة واحد لا اثنان.
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem('naf-theme', theme);
    } catch {}
    // القيمتان هما --background في ثيم ناف بالوضعين، مكتوبتان hex بموجب
    // استثناء <meta name="theme-color"> في CLAUDE.md §1: الوسم لا يحلّ
    // var(). أي تغيير في الثيم يستوجب تحديثهما هنا وفي index.html.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#1c2433' : '#e8ebed');
  }, [theme]);

  const toggle = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  return [theme, toggle];
}
