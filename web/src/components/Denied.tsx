/* ============================================================
   صفحة الرفض — يصلها من رُدّ على باب المنصة.

   الحزمة تمرّر رمز سبب في `?r=` لا جملة، وهذه الصفحة تترجمه إلى المصطلح
   المسجَّل في naf-terms.md §١٠ «صفحة الرفض في المنصة». ولو حملت الحزمة
   الجملة لصارت مصدر نصّ ثانياً خارج السجلّ.

   وما يأتي من المركز نصّاً حرّاً يُعرض كما كُتب: يكتبه مسؤول النظام سبباً
   للحرمان، ولا يُعاد صوغه ولا يُختصر ولا يُستبدل بنصّ عام.

   ولا تكشف الصفحة تفصيلاً تقنياً ولا وجود مستخدمين آخرين.
   ============================================================ */

import { Icon, ICON_LG } from '../lib/icons';

/**
 * الرموز الأربعة التي تمرّرها `naf-auth`، بنصوصها وأيقوناتها من
 * naf-terms.md §١٠ «منع الدخول إلى منصة». أي قيمة غيرها نصٌّ من المركز.
 *
 * ولكلٍّ أيقونته: `ShieldX` للحرمان وحده — بابٌ مغلق أمام هذا القارئ —
 * و`CircleSlash` لعضوية معطّلة، و`CircleAlert` لعطلٍ في المحاولة نفسها.
 * ولكلٍّ لونُها المسجَّل معها: `muted-foreground` للمعطّل و`destructive` لغيره.
 */
const REASONS: Record<string, { text: string; icon: keyof typeof Icon; muted?: true }> = {
  not_member: { text: 'لا تملك صلاحية الوصول لهذه المنصة', icon: 'accessDenied' },
  inactive: { text: 'عضويتك في هذه المنصة معطّلة. راجع مسؤول المنصة.', icon: 'disabled', muted: true },
  bad_state: { text: 'انتهت جلسة دخولك. سجّل الدخول من جديد', icon: 'failed' },
  auth_failed: { text: 'تعذّر التحقق من دخولك. أعد المحاولة.', icon: 'failed' },
};

/** العارضان وحدهما تُجدي فيهما إعادة المحاولة. الحرمان والتعطيل لا حيلة فيهما. */
const RETRYABLE = new Set(['bad_state', 'auth_failed']);

export default function Denied() {
  const raw = new URLSearchParams(location.search).get('r') ?? '';
  const known = REASONS[raw];
  // سببٌ نصّيٌّ من المركز يُعرض كما كُتب، وأيقونته الحرمان: هي حالته.
  const message = known?.text ?? raw.trim();
  const Glyph = Icon[known?.icon ?? 'accessDenied'];
  const retryable = RETRYABLE.has(raw);

  return (
    <div className="auth-wrap">
      <div className="auth-card denied-card">
        {/* الحالة لا تُبلَّغ باللون وحده: أيقونة وعنوان ونصّ. */}
        <Glyph size={ICON_LG} className={`denied-icon${known?.muted ? ' muted' : ''}`} aria-hidden />
        <h1 className="denied-title">تعذّر الدخول</h1>

        {message && (
          <p className="denied-reason" role="status">
            {message}
          </p>
        )}

        {retryable && (
          <a className="btn-primary denied-action" href="/">
            إعادة المحاولة
          </a>
        )}
      </div>
    </div>
  );
}
