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

/** الرموز الأربعة التي تمرّرها `naf-auth`. أي قيمة غيرها نصٌّ من المركز. */
const REASONS: Record<string, string> = {
  not_member: 'لا تملك صلاحية الوصول لهذه المنصة',
  inactive: 'عطّل مسؤول المنصة وصولك إليها',
  bad_state: 'انتهت مهلة الدخول. أعد المحاولة',
  auth_failed: 'تعذّر التحقق من دخولك. أعد المحاولة',
};

/** السببان العارضان وحدهما تُجدي فيهما إعادة المحاولة. */
const RETRYABLE = new Set(['bad_state', 'auth_failed']);

export default function Denied() {
  const raw = new URLSearchParams(location.search).get('r') ?? '';
  const message = REASONS[raw] ?? raw.trim();
  const retryable = RETRYABLE.has(raw);

  return (
    <div className="auth-wrap">
      <div className="auth-card denied-card">
        {/* الحالة لا تُبلَّغ باللون وحده: أيقونة وعنوان ونصّ. */}
        <Icon.accessDenied size={ICON_LG} className="denied-icon" aria-hidden />
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
