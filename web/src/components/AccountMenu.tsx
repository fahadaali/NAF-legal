import { AccountMenu as NafAccountMenu } from '../naf/ui/app-shell';
import { ROLE_LABELS, User } from '../lib/api';
import ThemeToggle from './ThemeToggle';
import type { ThemeChoice } from '../lib/theme';

/* غلافٌ رقيق حول `AccountMenu` من السجلّ: يترجم مستخدم هذه المنصة
   ودرجتَه إلى واجهة المكوّن، ويمرّر مُبدِّل المظهر المحلّي — وهو مرآة
   العقد المسجَّل بحالاته الثلاث. لا منطق هنا، فالسلوك كلّه في السجلّ. */

export default function AccountMenu({
  user,
  theme,
  onThemeChange,
  onLogout,
}: {
  user: User;
  theme: ThemeChoice;
  onThemeChange: (choice: ThemeChoice) => void;
  onLogout: () => void;
}) {
  return (
    <NafAccountMenu
      name={user.name ?? 'مستخدم'}
      email={user.email}
      role={ROLE_LABELS[user.role]}
      appearance={<ThemeToggle choice={theme} onChange={onThemeChange} />}
      onLogout={onLogout}
    />
  );
}
