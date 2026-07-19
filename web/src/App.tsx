import { useEffect, useState, useCallback } from 'react';
import { api, User } from './lib/api';
import Auth from './components/Auth';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import Admin from './components/Admin';
import Tools from './components/Tools';
import ReviewPage from './components/ReviewPage';

export default function App() {
  // مسار المراجعة العامة (بلا مصادقة)
  const reviewMatch = location.pathname.match(/^\/review\/([\w-]+)/);
  if (reviewMatch) return <ReviewPage token={reviewMatch[1]} />;

  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'chat' | 'admin' | 'tools'>('chat');
  const [activeConv, setActiveConv] = useState<string | null>(null);
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

  if (!user) return <Auth onAuth={setUser} />;

  return (
    <div className="app-shell">
      <div className="main">
        {view === 'chat' && (
          <ChatView
            key={activeConv ?? 'new'}
            conversationId={activeConv}
            onConversationChange={(id) => {
              setActiveConv(id);
              refreshConversations();
            }}
            onToggleSidebar={() => setSidebarOpen((o) => !o)}
          />
        )}
        {view === 'admin' && <Admin />}
        {view === 'tools' && <Tools />}
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
          setView('chat');
          setSidebarOpen(false);
        }}
        onNewChat={() => {
          setActiveConv(null);
          setView('chat');
          setSidebarOpen(false);
        }}
        onOpenAdmin={() => setView('admin')}
        onOpenTools={() => setView('tools')}
        onLogout={handleLogout}
      />
    </div>
  );
}
