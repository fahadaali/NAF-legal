import { useEffect, useState, useCallback } from 'react';
import { api, User } from './lib/api';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import Admin from './components/Admin';
import Tools from './components/Tools';
import ReviewPage from './components/ReviewPage';
import ChangePassword from './components/ChangePassword';
import Deadlines from './components/Deadlines';
import SearchPage from './components/SearchPage';
import CaseFile from './components/CaseFile';
import Support from './components/Support';
import Denied from './components/Denied';
import Members from './components/Members';
import AccountMenu from './components/AccountMenu';
import NotificationBell from './components/NotificationBell';
import SessionBar from './components/SessionBar';
import { useTheme } from './lib/theme';
import { subscribeChatActivity } from './lib/chatStream';
import { Icon, ICON_MD, ICON_LG } from './lib/icons';

type View = 'chat' | 'admin' | 'members' | 'tools' | 'deadlines' | 'case' | 'support' | 'search';

const VIEWS: View[] = ['chat', 'admin', 'members', 'tools', 'deadlines', 'case', 'support', 'search'];

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

  // مسار المراجعة العامة (بلا مصادقة)
  const reviewMatch = location.pathname.match(/^\/review\/([\w-]+)/);
  if (reviewMatch) return <ReviewPage token={reviewMatch[1]} />;

  const [theme, setTheme] = useTheme();
  const [user, setUser] = useState<User | null>(null);
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
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    api
      .me()
      .then((r) => setUser(r.user))
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

  if (loading) {
    return (
      <div className="center-load">
        <div className="spinner" style={{ width: 32, height: 32 }} />
      </div>
    );
  }

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

  // بوابة أول دخول: إجبار تعيين كلمة مرور جديدة
  if (user.must_change_password) {
    return (
      <ChangePassword
        theme={theme}
        onThemeChange={setTheme}
        onDone={() => setUser({ ...user, must_change_password: false })}
      />
    );
  }

  // فتح شاشة مع إغلاق الشريط الجانبي — على الشاشات الصغيرة يغطّي الشريط المحتوى
  const openView = (v: typeof view) => {
    setView(v);
    setSidebarOpen(false);
  };

  return (
    <div className="naf-shell naf-shell--fixed">
      <div
        className={`naf-backdrop ${sidebarOpen ? 'is-open' : ''}`}
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />

      {/* الشريط أوّلَ الهيكل: جهة البداية هي اليمين في RTL. كان آخره فوقع
          يساراً وحده بين المنصات الخمس. */}
      <Sidebar
        user={user}
        open={sidebarOpen}
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

      <div className="naf-main">
        {/* أعلى عمود العمل لا أعلى الهيكل: `.naf-shell` صفٌّ أفقيّ — الشريط
            الجانبي ثم المحتوى — فابنٌ ثالثٌ فيه يقف عموداً بجانبهما. وهو فوق
            الترويسة لأنه يعمّ الشاشات: الجلسة انتهت أيّاً كان المعروض. */}
        <SessionBar />
        {/* الترويسة الموحّدة — زرّ القائمة دون نقطة الانكسار، والإشعارات
            وقائمة الحساب في نهايتها. تسجيل الخروج داخل القائمة لا زرّاً
            في أسفل الشريط كما كان. */}
        <header className="naf-header">
          <div className="naf-header-start">
            <button
              type="button"
              className="naf-icon-btn naf-menu-btn"
              aria-label="القائمة"
              aria-expanded={sidebarOpen}
              aria-controls="naf-sidebar"
              onClick={() => setSidebarOpen((o) => !o)}
            >
              <Icon.menu size={ICON_MD} aria-hidden />
            </button>
          </div>
          <div className="naf-header-end">
            <NotificationBell />
            <AccountMenu
              user={user}
              theme={theme}
              onThemeChange={setTheme}
              onLogout={handleLogout}
            />
          </div>
        </header>

        <main className="naf-content naf-content--flush">
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
        {view === 'search' && (
          <SearchPage
            initial={searchQuery}
            onOpenConversation={(id) => {
              setActiveConv(id);
              setView('chat');
            }}
          />
        )}
        </main>

        <div className="disclaimer-bar">
          كل مخرجات المنصّة مسوّدات مساعِدة تتطلّب مراجعة محامٍ مختصّ قبل الاعتماد.
        </div>
      </div>
    </div>
  );
}
