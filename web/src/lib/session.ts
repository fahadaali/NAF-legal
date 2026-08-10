/* انتهاء الجلسة والشاشة مفتوحة.
 *
 * **المشكلة ليست انتهاء الرمز، بل من يكتشفه.** الرمز يعيش خمس عشرة دقيقة،
 * ولوحةٌ مفتوحة أطول من ذلك تكتشف انتهاءه بجَسٍّ دوريّ — الإشعارات كلَّ دقيقة،
 * وحالُ دورٍ يجري كلَّ أربع ثوانٍ — لا بفعلٍ من صاحبها. وكان كلُّ ٤٠١ يحوّل
 * الصفحة فوراً، فيقرأ المحامي مذكّرةً فتُنتزع من تحت عينيه بلا سبب يراه.
 *
 * والفرق الذي تبني عليه هذه الوحدة: **نداءٌ بدأه القارئ ينتظر نتيجته، ونداءٌ
 * بدأه مؤقّتٌ لا ينتظره أحد.** الأوّل يُحوَّل عنده فوراً — هو واقفٌ أمام نتيجة
 * لن تأتي — والثاني يرفع شريطاً ويترك الشاشة كما هي.
 */

type Listener = () => void;

const listeners = new Set<Listener>();
let lost = false;

/** هل انتهت الجلسة بعِلمنا؟ تقرؤها الشاشة عند التركيب. */
export function isSessionLost(): boolean {
  return lost;
}

/**
 * الجلسة انتهت واكتشفها جَسٌّ في الخلفية.
 *
 * لا تحوّل: ترفع العَلَم وتُخبر المشتركين، والشاشة تعرض الشريط. والتحويل
 * يقع بيد القارئ — أو عند أوّل فعلٍ يبدأه بنفسه.
 */
export function sessionLost(): void {
  if (lost) return;
  lost = true;
  for (const fn of listeners) fn();
}

export function subscribeSessionLost(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * الذهاب إلى الباب، والعودةُ إلى هذا الموضع بعينه.
 *
 * **و«تعود إلى مكانك» وعدٌ يُوفى بالعنوان.** الموضع في `?c=` و`?v=` منذ
 * `App.tsx` يكتبهما، فـ`next` يحملهما. وكان يحمل `/` وحدها — الشاشة تحفظ
 * موضعها في حالة React لا في العنوان — فتُعيد القارئ إلى الرئيسية بعد أن
 * وعدته بغيرها.
 *
 * ومسار الرفض يُستثنى: وضعُه وجهةً يعيد القارئ إلى الرفض بعد الدخول، فتدور
 * الحلقة ولا تُقرأ الرسالة أصلاً.
 */
export function loginWithReturn(login: string): void {
  let target = login;
  try {
    const url = new URL(login, window.location.origin);
    if (window.location.pathname === '/denied') url.searchParams.delete('next');
    else url.searchParams.set('next', window.location.pathname + window.location.search);
    target = url.toString();
  } catch {
    // عنوانٌ لا يُحلَّل يُتّبع كما ورد: الباب أولى من البقاء بلا باب.
  }
  window.location.href = target;
}

/**
 * عنوانُ الباب كما ورد من الخادم آخر مرّة.
 *
 * الشريط يحتاجه ليُحوِّل حين يضغط القارئ، والردّ الذي حمله جاء إلى نداءٍ في
 * الخلفية انتهى وذهب. فيُحفَظ هنا.
 */
let loginUrl: string | null = null;

export function rememberLoginUrl(url: string): void {
  loginUrl = url;
}

/** يذهب إلى الباب المحفوظ، أو إلى الجذر إن لم يُحفظ — والوسيط يتولّى الباقي. */
export function resumeSession(): void {
  loginWithReturn(loginUrl ?? '/');
}
