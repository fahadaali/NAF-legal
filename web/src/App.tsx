import { lazy, Suspense, useEffect, useState, useCallback } from 'react';
import { api, User } from './lib/api';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import Denied from './components/Denied';
import AccountMenu from './components/AccountMenu';
import NotificationBell from './components/NotificationBell';
import SessionBar from './components/SessionBar';
import {
  AppShell,
  AppContent,
  AppHeader,
  AppMain,
  HeaderEnd,
  HeaderStart,
  MenuButton,
  PlatformsLink,
  ShellBackdrop,
  useShell,
} from './naf/ui/app-shell';
import { useTheme, type ThemeChoice } from './lib/theme';
import { subscribeChatActivity } from './lib/chatStream';
import { Icon, ICON_LG } from './lib/icons';

/* ══ الشاشات خارج حزمة البدء ══
 *
 * كانت المنصة حزمةً واحدة بنصف ميغابايت يحمّلها كلُّ زائرٍ قبل أوّل رسم — وأكثرُ
 * من ربعها لوحةُ الإدارة وأدوات الاستيراد والمراجعة التي لا يفتحها إلا المسؤول.
 * فهذه تُحمَّل حين تُفتح. وما يفتحه المستخدم العادي منها (البحث، القضية،
 * المواعيد، الأدوات، الدعم) يُحمَّل في الخلفية بعد أوّل رسم (`preloadScreens`)،
 * فلا ينتظر أوّلَ ضغطةٍ عليه. والمحادثة نفسها في الحزمة: هي الشاشة الأولى. */
const loadAdmin = () => import('./components/Admin');
const loadMembers = () => import('./components/Members');
const loadTools = () => import('./components/Tools');
const loadDeadlines = () => import('./components/Deadlines');
const loadSearch = () => import('./components/SearchPage');
const loadCase = () => import('./components/CaseFile');
const loadSupport = () => import('./components/Support');
const loadAiTools = () => import('./components/AiTools');
const loadConnect = () => import('./components/Connect');

const Admin = lazy(loadAdmin);
const Members = lazy(loadMembers);
const Tools = lazy(loadTools);
const Deadlines = lazy(loadDeadlines);
const SearchPage = lazy(loadSearch);
const CaseFile = lazy(loadCase);
const Support = lazy(loadSupport);
const ReviewPage = lazy(() => import('./components/ReviewPage'));
const AiToolsMember = lazy(() => loadAiTools().then((m) => ({ default: m.AiToolsMember })));
const ConnectDoor = lazy(() => loadConnect().then((m) => ({ default: m.ConnectDoor })));
const ConnectConsent = lazy(() => loadConnect().then((m) => ({ default: m.ConnectConsent })));

/** شاشاتُ المستخدم العادي — تُجلب في وقت فراغ المتصفّح بعد أوّل رسم. */
function preloadScreens(role: string): void {
  const run = () => {
    const all = [loadSearch, loadCase, loadDeadlines, loadTools, loadSupport, loadAiTools];
    if (role === 'admin') all.push(loadAdmin, loadMembers);
    for (const load of all) load().catch(() => {});
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 2000);
}

/** ما يظهر لحظةَ تحميل شاشةٍ لم تُجلب بعد — الدوّار نفسه الذي تبدأ به المنصة. */
function ScreenFallback() {
  return (
    <div className="center-load">
      <div className="spinner" style={{ width: 32, height: 32 }} />
    </div>
  );
}

type View = 'chat' | 'admin' | 'members' | 'tools' | 'deadlines' | 'case' | 'support' | 'search' | 'ai-tools';

const VIEWS: View[] = ['chat', 'admin', 'members', 'tools', 'deadlines', 'case', 'support', 'search', 'ai-tools'];

/** الشاشة من العنوان، و«المحادثة» لكل ما لا يُعرف — عنوانٌ عُبث به لا يُعطّل. */
function readView(): View {
  const v = new URLSearchParams(window.location.search).get('v');
  return (VIEWS as string[]).includes(v ?? '') ? (v as View) : 'chat';
}

/**
 * يكتب الموضع في العنوان بلا إدخالٍ في سجلّ الرجوع.
 *
 * `replaceState` لا `pushState`: تبديلُ المحادثات فعلٌ داخل الشاشة لا تنقّلٌ
 * بينها، و«رجوع» بعد عشر محادثات يجب أن يُخرج القارئ من المنصة لا أن يمشي
 * بها محادثةً محادثة.
 */
function writePlace(view: View, conv: string | null): void {
  const url = new URL(window.location.href);
  if (view === 'chat') url.searchParams.delete('v');
  else url.searchParams.set('v', view);
  if (conv) url.searchParams.set('c', conv);
  else url.searchParams.delete('c');
  if (url.toString() !== window.location.href) window.history.replaceState(null, '', url);
}

export default function App() {
  // صفحة الرفض — عامة، وإليها يحوّل وسيط الدخول الموحّد من رُدّ على الباب.
  // تُفحص قبل كل شيء: لا جلسة لقارئها ولا مستخدم يُقرأ.
  if (location.pathname === '/denied') return <Denied />;

  /* ربطُ أداة ذكاءٍ اصطناعي (naf-terms.md §١٥). البابُ عامٌّ — يفتحه الضيف
     ولا حساب له — والإذنُ بعد دخول العضو من المركز: `/connect-member/` خارج
     المسارات العامة في `src/lib/sso.ts`، فلا يبلغ هذا السطرَ إلا من دخل.
     وكلاهما صفحةُ بابٍ بلا هيكل، كصفحة الرفض. */
  const connectMatch = location.pathname.match(/^\/connect\/([\w-]+)\/?$/);
  if (connectMatch) return <Suspense fallback={<ScreenFallback />}><ConnectDoor requestId={connectMatch[1]} /></Suspense>;
  const consentMatch = location.pathname.match(/^\/connect-member\/([\w-]+)\/?$/);
  if (consentMatch) return <Suspense fallback={<ScreenFallback />}><ConnectConsent requestId={consentMatch[1]} /></Suspense>;

  // مسار المراجعة العامة (بلا مصادقة)
  const reviewMatch = location.pathname.match(/^\/review\/([\w-]+)/);
  if (reviewMatch) return <Suspense fallback={<ScreenFallback />}><ReviewPage token={reviewMatch[1]} /></Suspense>;

  const [theme, setTheme] = useTheme();
  const [user, setUser] = useState<User | null>(null);
  // عنوان مركز الهوية من الخادم (`AUTH_ISSUER`) — لا يُكتب في الواجهة.
  const [center, setCenter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /* ══ الموضع في العنوان لا في الحالة وحدها ══
   *
   * الرمز يعيش خمس عشرة دقيقة، ولوحةٌ مفتوحة أطول من ذلك تعود إلى المركز
   * لتأخذ رمزاً جديداً — تنقّلٌ كاملٌ يهدم الحالة كلَّها. وكان الموضع في
   * `useState` وحدها، و`next` يحمل `/`، فيعود القارئ إلى **الرئيسية** لا إلى
   * محادثته. وهو ما يُقرأ «يخرجني ويحيدني للصفحة الرئيسية».
   *
   * والقراءة الأولى من العنوان، فالعائد يجد ما تركه. */
  const [view, setView] = useState<View>(() => readView());
  // نصّ البحث يُرفع من الشريط الجانبي إلى الشاشة: يُكتب مرّة ولا يُعاد.
  const [searchQuery, setSearchQuery] = useState('');
  const [activeConv, setActiveConv] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('c')
  );
  /* رسالةُ البدء ومعها مرفقاتُها. والمعرِّفات معها لا تُقرأ من الخادم:
     الإرسال التلقائي يقع فور تركيب الشاشة، قبل أن تصل جلبةُ المحادثة —
     فمرفقُ نافذة البدء كان يبقى بلا رسالة، ونصُّه لا يبلغ المساعد أبداً. */
  const [pendingInitial, setPendingInitial] = useState<{ text: string; attachmentIds: string[] } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    api
      .me()
      .then((r) => {
        setUser(r.user);
        setCenter(r.center ?? null);
        if (r.user) preloadScreens(r.user.role);
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const refreshConversations = useCallback(() => setRefreshKey((k) => k + 1), []);

  /* الشريط الجانبي يتبع الدور ولو غادرت شاشتُه.
     التوليد يمضي في الخلفية (`lib/chatStream.ts`)، وعنوانُ المحادثة يُصاغ
     عند أوّل ردّ وترتيبُها يتغيّر بختامه. وكان التحديث معلَّقاً على نداءٍ من
     `ChatView` — فمن بدّل المحادثة أثناء الدور بقيت في قائمته «محادثة جديدة»
     إلى أن يُعيد فتحها. والاشتراك هنا على دورة الحياة وحدها — البدء والعنوان
     والختام — لا على كل مقطعٍ من النصّ: الشريط لا يُعاد بناؤه مئة مرّة في
     الدور الواحد. */
  useEffect(() => subscribeChatActivity(refreshConversations), [refreshConversations]);

  // الموضع يُكتب في العنوان مع كل تغيّر — فما يحمله `next` عند العودة إلى
  // المركز هو ما كان على الشاشة، لا الجذر.
  useEffect(() => writePlace(view, activeConv), [view, activeConv]);

  const handleLogout = async () => {
    await api.logout();
    setUser(null);
    setActiveConv(null);
    setView('chat');
  };

  if (loading) return <ScreenFallback />;

  // بابُ المنصة المركزُ وحده، فبلوغُ هذه النقطة يعني أن الوسيط سمح بالطلب
  // ثم تعذّرت قراءة الحساب — خللٌ في النظام لا نقصُ دخول. ولا تُعرض هنا
  // شاشةُ كلمة مرور: مسارها مغلق، وعرضُها يُوهم القارئ أن بيده حيلة.
  // ولا يُعاد التحميل تلقائياً: الوسيط سيسمح ثانيةً فتدور الصفحة بلا نهاية.
  if (!user) {
    return (
      <div className="auth-wrap">
        <div className="auth-card denied-card">
          <Icon.failed size={ICON_LG} className="denied-icon" aria-hidden />
          <h1 className="denied-title">تعذّر الدخول</h1>
          <p className="denied-reason" role="status">
            حدث خطأ في النظام. أعد المحاولة بعد قليل
          </p>
          <a className="btn-primary denied-action" href="/">
            إعادة المحاولة
          </a>
        </div>
      </div>
    );
  }

  /* وأُسقطت هنا بوّابةُ «غيّر كلمة مرورك عند أوّل دخول».
     هجرة `0010` صفّرت الراية، والمساران اللذان كانا يرفعانها أُسقطا، ومسارُ
     التغيير نفسه أُسقط — فلا أحد يبلغها، والشرطُ عليها يقرأ حقلاً لا يتغيّر
     أبداً. التفصيل في `src/routes/auth.ts`. */

  /* الهيكل من السجلّ لا مبنيّاً باليد.
     كانت هذه الشجرة تكتب `naf-shell` و`naf-backdrop` و`naf-header` و
     `naf-menu-btn` بأصنافها — وهي الأصناف نفسها التي يُصدرها
     `naf/ui/app-shell.tsx` المنقول من السجلّ. فكان المكوّن حاضراً في
     الشجرة ومُعاد بناؤه بجانبه، وهو ما يمنعه §4 نصّاً.
     وفي المكوّن سلوكان لم يكونا هنا: «هروبٌ يغلق الدرج»، و«إيقافُ تمرير
     الخلفية والدرج مفتوح». وحالةُ الدرج صارت في `AppShell`، فيقرؤها الجسم
     بـ`useShell` — ولذلك انفصل `AppBody` عن `App`. */
  return (
    <AppShell fixed>
      <AppBody
        user={user}
        center={center}
        theme={theme}
        setTheme={setTheme}
        view={view}
        setView={setView}
        activeConv={activeConv}
        setActiveConv={setActiveConv}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        pendingInitial={pendingInitial}
        setPendingInitial={setPendingInitial}
        refreshKey={refreshKey}
        refreshConversations={refreshConversations}
        onLogout={handleLogout}
      />
    </AppShell>
  );
}

interface BodyProps {
  user: User;
  /** عنوان مركز الهوية — `null` يُخفي زرّ «كل المنصات». */
  center: string | null;
  theme: ThemeChoice;
  setTheme: (c: ThemeChoice) => void;
  view: View;
  setView: (v: View) => void;
  activeConv: string | null;
  setActiveConv: (id: string | null) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  pendingInitial: { text: string; attachmentIds: string[] } | null;
  setPendingInitial: (v: { text: string; attachmentIds: string[] } | null) => void;
  refreshKey: number;
  refreshConversations: () => void;
  onLogout: () => void;
}

/** جسمُ الهيكل — داخل `AppShell` ليقرأ حالة الدرج منه. */
function AppBody({
  user, center, theme, setTheme, view, setView, activeConv, setActiveConv,
  searchQuery, setSearchQuery, pendingInitial, setPendingInitial,
  refreshKey, refreshConversations, onLogout,
}: BodyProps) {
  const { setOpen } = useShell();

  // فتح شاشة مع إغلاق الدرج — على الشاشات الصغيرة يغطّي الدرجُ المحتوى
  const openView = (v: View) => {
    setView(v);
    setOpen(false);
  };

  return (
    <>
      <ShellBackdrop />

      {/* الشريط أوّلَ الهيكل: جهة البداية هي اليمين في RTL. كان آخره فوقع
          يساراً وحده بين المنصات الخمس. */}
      <Sidebar
        user={user}
        activeConv={activeConv}
        view={view}
        refreshKey={refreshKey}
        onSelectConv={(id) => {
          setActiveConv(id);
          openView('chat');
        }}
        onNewChat={() => {
          setActiveConv(null);
          openView('chat');
        }}
        onOpenAdmin={() => openView('admin')}
        onOpenMembers={() => openView('members')}
        onOpenTools={() => openView('tools')}
        onOpenDeadlines={() => openView('deadlines')}
        onOpenSearch={(q) => {
          setSearchQuery(q);
          openView('search');
        }}
        onOpenCase={() => openView('case')}
        onOpenSupport={() => openView('support')}
      />

      <AppMain>
        {/* أعلى عمود العمل لا أعلى الهيكل: `.naf-shell` صفٌّ أفقيّ — الشريط
            الجانبي ثم المحتوى — فابنٌ ثالثٌ فيه يقف عموداً بجانبهما. وهو فوق
            الترويسة لأنه يعمّ الشاشات: الجلسة انتهت أيّاً كان المعروض. */}
        <SessionBar />
        {/* الترويسة الموحّدة — زرّ القائمة دون نقطة الانكسار، والإشعارات
            وقائمة الحساب في نهايتها. تسجيل الخروج داخل القائمة لا زرّاً
            في أسفل الشريط كما كان. */}
        <AppHeader>
          <HeaderStart>
            <MenuButton />
          </HeaderStart>
          <HeaderEnd>
            <NotificationBell />
            {/* إلى شبكة المنصات في المركز — قبل قائمة الحساب مباشرةً،
                وفي اللسان نفسه. لا مركز، لا زرّ. */}
            <PlatformsLink href={center ? `${center}/` : null} />
            <AccountMenu
              user={user}
              theme={theme}
              onThemeChange={setTheme}
              onOpenAiTools={() => openView('ai-tools')}
              onLogout={onLogout}
            />
          </HeaderEnd>
        </AppHeader>

        <AppContent flush>
        <Suspense fallback={<ScreenFallback />}>
        {view === 'chat' && (
          <ChatView
            key={activeConv ?? 'new'}
            conversationId={activeConv}
            initialMessage={pendingInitial}
            onInitialConsumed={() => setPendingInitial(null)}
            onStartConversation={(id, message, attachmentIds) => {
              setPendingInitial({ text: message, attachmentIds });
              setActiveConv(id);
              refreshConversations();
            }}
            onConversationChange={(id) => {
              setActiveConv(id);
              refreshConversations();
            }}
            readOnly={user?.role === 'viewer'}
          />
        )}
        {view === 'admin' && <Admin />}
        {view === 'members' && <Members />}
        {view === 'tools' && <Tools />}
        {view === 'deadlines' && <Deadlines />}
        {view === 'case' && (
          <CaseFile onOpenConversation={(id) => { setActiveConv(id); openView('chat'); }} />
        )}
        {view === 'support' && <Support />}
        {view === 'ai-tools' && <AiToolsMember />}
        {view === 'search' && (
          <SearchPage
            initial={searchQuery}
            onOpenConversation={(id) => {
              setActiveConv(id);
              setView('chat');
            }}
          />
        )}
        </Suspense>
        </AppContent>

        <div className="disclaimer-bar">
          كل مخرجات المنصّة مسوّدات مساعِدة تتطلّب مراجعة محامٍ مختصّ قبل الاعتماد.
        </div>
      </AppMain>
    </>
  );
}
