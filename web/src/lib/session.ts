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

/* ============================================================
   تجديد الجلسة في نافذةٍ جانبية — والشاشة الأصلية باقية كما هي.

   فعلٌ طويل كاستيراد ملفٍّ كبير يتجاوز عمر الرمز حتماً. والتحويل عنده يُفقده
   موضعَه — معرّفَ الدفعة وآخرَ جزءٍ وصل — فيبدأ من الصفر ويتجاوز الرمز ثانيةً:
   حلقةٌ لا تنتهي. فيُفتح الباب في نافذةٍ صغيرة، وجلسةُ المركز حيّةٌ في الغالب
   فتعود في ثوانٍ، والفعلُ ينتظر ثم يكمل من حيث وقف.

   والنافذة تُفتح بضغطة القارئ لا من تلقاء نفسها: المتصفّح يحجب نافذةً لم
   تسبقها ضغطة. وإن حُجبت مع ذلك فالتحويل الكامل هو البديل، ومن يستدعي هذه
   الدالة يحفظ موضعه قبلها.
   ============================================================ */

/** المعامل الذي تعود به نافذة التجديد — به تعرف أنها نافذةُ تجديد لا تبويب. */
const RENEWED_PARAM = 'renewed';
const RENEWED_CHANNEL = 'naf-session';
const RENEWED_MESSAGE = 'renewed';

/**
 * يفتح الباب في نافذةٍ جانبية ويُحلّ حين تعود بجلسةٍ جديدة.
 *
 * يعيد `false` إن حُجبت النافذة — وعندها يقع التحويل الكامل ولا يُحلّ الوعد
 * بشيء بعده، فالصفحة على وشك أن تُغادر.
 *
 * والإشارة بقناة البثّ لا بـ`opener` وحده: المركز أصلٌ آخر، وقد يقطع ما بين
 * النافذتين بترويسة `Cross-Origin-Opener-Policy` فلا تبلغ رسالةُ `opener`
 * صاحبَها. والقناة لا تمرّ بذلك الرابط أصلاً — تجمع نوافذ الأصل الواحد.
 */
export function renewSessionInWindow(login: string): Promise<boolean> {
  let target = login;
  try {
    const url = new URL(login, window.location.origin);
    url.searchParams.set('next', `/?${RENEWED_PARAM}=1`);
    target = url.toString();
  } catch {
    // عنوانٌ لا يُحلَّل يُفتح كما ورد: يعود إلى الجذر، والقارئ يغلقه بيده.
  }

  const popup = window.open(target, 'naf-session-renew', 'popup,width=520,height=680');
  if (!popup) {
    loginWithReturn(login);
    return pending();
  }

  return new Promise<boolean>((resolve) => {
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(RENEWED_CHANNEL) : null;
    const done = () => {
      channel?.close();
      window.removeEventListener('message', onMessage);
      sessionRestored();
      resolve(true);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin === window.location.origin && e.data === RENEWED_MESSAGE) done();
    };
    if (channel) channel.onmessage = (e) => e.data === RENEWED_MESSAGE && done();
    window.addEventListener('message', onMessage);
  });
}

/**
 * يُستدعى أوّلَ تحميل الواجهة. إن كانت هذه نافذةَ تجديدٍ عادت من الباب أخبرت
 * صاحبتَها وأغلقت نفسها، وأعادت `true` فلا تُرسم الواجهة فيها.
 *
 * وإن لم تُغلق — فُتحت تبويباً عادياً، أو قُطع ما بينها وبين صاحبتها —
 * أُسقط المعامل من العنوان وتُرسم الواجهة كأيّ تبويب: الجلسة تجدّدت على
 * كلّ حال، والإشارة وصلت بالقناة.
 */
export function finishSessionRenewal(): boolean {
  const url = new URL(window.location.href);
  if (url.searchParams.get(RENEWED_PARAM) !== '1') return false;

  if (typeof BroadcastChannel === 'function') {
    const channel = new BroadcastChannel(RENEWED_CHANNEL);
    channel.postMessage(RENEWED_MESSAGE);
    channel.close();
  }
  try {
    window.opener?.postMessage(RENEWED_MESSAGE, window.location.origin);
  } catch {
    // قُطع الرابط بالنافذة الأم — القناة أوصلت الإشارة.
  }
  window.close();
  if (window.closed) return true;

  // لم تُغلق: ما فتحها نصٌّ برمجي. تبقى تبويباً عادياً بلا المعامل.
  url.searchParams.delete(RENEWED_PARAM);
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  return false;
}

/** عادت الجلسة: يُنزل الشريط إن كان جَسٌّ في الخلفية قد رفعه. */
function sessionRestored(): void {
  if (!lost) return;
  lost = false;
  for (const fn of listeners) fn();
}

/** وعدٌ لا يُحلّ: التحويل جارٍ. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}
