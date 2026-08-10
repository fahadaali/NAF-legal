/* شريطُ انتهاء الجلسة — بديلُ التحويل لا إشعارٌ فوقه.
 *
 * الرمز يعيش خمس عشرة دقيقة، ويكتشف انتهاءَه جَسٌّ دوريّ لا فعلٌ من القارئ.
 * وكان ذلك يحوّل الصفحة في الحال: يقرأ المحامي مذكّرةً فيجد نفسه في الرئيسية
 * بلا سبب يراه. فصار الجسُّ يرفع هذا الشريط ويترك الشاشة كما هي — والتحويل
 * بيد القارئ، أو عند أوّل فعلٍ يبدأه بنفسه.
 */
import { useEffect, useState } from 'react';
import { ICON_SM, Icon } from '../lib/icons';
import { isSessionLost, resumeSession, subscribeSessionLost } from '../lib/session';

export default function SessionBar() {
  const [lost, setLost] = useState(isSessionLost);

  useEffect(() => subscribeSessionLost(() => setLost(true)), []);

  if (!lost) return null;

  return (
    /* `alert` لا `status`: الجلسة انتهت وما يليه من عملٍ يحتاج دخولاً، فيُقرأ
       في حينه لا عند أوّل هدوء. */
    <div className="session-bar" role="alert">
      <Icon.failed size={ICON_SM} aria-hidden />
      <span>انتهت جلسة دخولك. ما كتبته محفوظ، وتعود إلى مكانك بعد الدخول.</span>
      <button className="btn-sm" onClick={resumeSession}>
        تسجيل الدخول
      </button>
    </div>
  );
}
