import { useEffect, useState, useCallback } from 'react';
import { api, User } from './lib/api';
import Auth from './components/Auth';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import Admin from './components/Admin';
import Tools from './components/Tools';
import ReviewPage from './components/ReviewPage';
import ChangePassword from './components/ChangePassword';
import Deadlines from './components/Deadlines';
import CaseFile from './components/CaseFile';
import Support from './components/Support';
import Denied from './components/Denied';
import Members from './components/Members';
import { useTheme } from './lib/theme';
import { Icon, ICON_MD } from './lib/icons';

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
  const [view, setView] = useState<'chat' | 'admin' | 'members' | 'tools' | 'deadlines' | 'case' | 'support'>('chat');
  const [activeConv, setActiveConv] = useState<string | null>(null);
  const [pendingInitial, setPendingInitial] = useState<string | null>(null);
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

  if (!user) return <Auth onAuth={setUser} theme={theme} onThemeChange={setTheme} />;

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
    <div className="app-shell">
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}

      <div className="main">
        {/* مفتاح الشريط الجانبي — يظهر على الشاشات الصغيرة وحدها، حيث يكون
            الشريط خارج الشاشة. يبقى في كل الشاشات لا في المحادثة فقط. */}
        <button className="sidebar-toggle" onClick={() => setSidebarOpen((o) => !o)} title="القائمة">
          <Icon.menu size={ICON_MD} aria-hidden />
        </button>

        {view === 'chat' && (
          <ChatView
            key={activeConv ?? 'new'}
            conversationId={activeConv}
            initialMessage={pendingInitial}
            onInitialConsumed={() => setPendingInitial(null)}
            onStartConversation={(id, message) => {
              setPendingInitial(message);
              setActiveConv(id);
              refreshConversations();
            }}
            onConversationChange={(id) => {
              setActiveConv(id);
              refreshConversations();
            }}
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
        <div className="disclaimer-bar">
          كل مخرجات المنصّة مسوّدات مساعِدة تتطلّب مراجعة محامٍ مختصّ قبل الاعتماد.
        </div>
      </div>

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
        onOpenCase={() => openView('case')}
        onOpenSupport={() => openView('support')}
        onLogout={handleLogout}
        theme={theme}
        onThemeChange={setTheme}
      />
    </div>
  );
}
