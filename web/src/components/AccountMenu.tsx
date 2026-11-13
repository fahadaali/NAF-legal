import { AccountMenu as NafAccountMenu } from '../naf/ui/app-shell';
import { ROLE_LABELS, User } from '../lib/api';
import ThemeToggle from './ThemeToggle';
import type { ThemeChoice } from '../lib/theme';
import { Icon, ICON_SM } from '../lib/icons';

/* غلافٌ رقيق حول `AccountMenu` من السجلّ: يترجم مستخدم هذه المنصة
   ودرجتَه إلى واجهة المكوّن، ويمرّر مُبدِّل المظهر المحلّي — وهو مرآة
   العقد المسجَّل بحالاته الثلاث. لا منطق هنا، فالسلوك كلّه في السجلّ. */

export default function AccountMenu({
  user,
  theme,
  onThemeChange,
  onOpenAiTools,
  onLogout,
}: {
  user: User;
  theme: ThemeChoice;
  onThemeChange: (choice: ThemeChoice) => void;
  /** «أدوات الذكاء الاصطناعي» — إعداداتُ العضو لربط أداته (naf-terms.md §١٥). */
  onOpenAiTools: () => void;
  onLogout: () => void;
}) {
  return (
    // الاسم يُمرَّر كما هو ولو كان فارغاً — البديل في المكوّن المسجَّل
    <NafAccountMenu
      name={user.name}
      email={user.email}
      role={ROLE_LABELS[user.role]}
      items={[{ label: 'أدوات الذكاء الاصطناعي', icon: <Icon.aiTool size={ICON_SM} aria-hidden />, onSelect: onOpenAiTools }]}
      appearance={<ThemeToggle choice={theme} onChange={onThemeChange} />}
      onLogout={onLogout}
    />
  );
}
