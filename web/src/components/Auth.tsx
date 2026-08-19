/* ══ شاشةُ دخولٍ متقاعدة ══
 *
 * كانت نموذجَ الدخول والتسجيل المحلّيين. وبعد الدخول الموحّد لم يعد لها
 * باب: `App.tsx` لا يستوردها، ومساراها في الخادم (`‎/api/auth/login‎`
 * و`‎/api/auth/register‎`) أُسقطا — التفصيل في `src/routes/auth.ts`.
 *
 * والملفّ يبقى على القرص ولا يُحذف (CLAUDE.md §11)، ومحتواه صار قولاً واحداً
 * صادقاً بدل نموذجٍ يَعِد بدخولٍ لا يقع. ومن استورده يوماً بالخطأ يرى هذا لا
 * حقولاً معطَّلة.
 *
 * وتاريخُ النموذج كما كان في سجلّ Git — وهو موضعه.
 */
export default function Auth() {
  return (
    <div className="auth-wrap">
      <div className="auth-card denied-card">
        <h1 className="denied-title">الدخول من مركز الهوية</h1>
        <p className="denied-reason" role="status">
          لم يعد لهذه المنصة دخولٌ بكلمة مرور. افتح المنصة من مركز ناف وستدخل مباشرة
        </p>
        <a className="btn-primary denied-action" href="/">
          فتح المنصة
        </a>
      </div>
    </div>
  );
}
