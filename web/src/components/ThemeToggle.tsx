import { Icon, ICON_MD } from '../lib/icons';
import type { ThemeChoice } from '../lib/theme';

// مجموعة أزرار المظهر — تُعرض مجموعةً واحدة لأن الحالات الثلاث متكافئة،
// ولأن إخفاء «يتبع النظام» داخل قائمة يجعلها خياراً منسيّاً.
// المصطلحات من naf-terms.md والأيقونات من naf-icons.md، ولا تُقلب في RTL.
const OPTIONS: { value: ThemeChoice; label: string; glyph: 'system' | 'light' | 'dark' }[] = [
  { value: 'system', label: 'يتبع النظام', glyph: 'system' },
  { value: 'light', label: 'الوضع الفاتح', glyph: 'light' },
  { value: 'dark', label: 'الوضع الداكن', glyph: 'dark' },
];

export default function ThemeToggle({
  choice,
  onChange,
  className = '',
}: {
  choice: ThemeChoice;
  onChange: (choice: ThemeChoice) => void;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label="المظهر" className={`appearance-toggle ${className}`.trim()}>
      {OPTIONS.map(({ value, label, glyph }) => {
        const Glyph = Icon[glyph];
        const active = choice === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            className={active ? 'on' : ''}
            onClick={() => onChange(value)}
          >
            <Glyph size={ICON_MD} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
