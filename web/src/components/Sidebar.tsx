import { useEffect, useState } from 'react';
import { api, Conversation, User } from '../lib/api';
import { iconFor } from '../lib/consultations';

interface Props {
  user: User;
  open: boolean;
  activeConv: string | null;
  view: 'chat' | 'admin' | 'tools';
  refreshKey: number;
  onSelectConv: (id: string) => void;
  onNewChat: () => void;
  onOpenAdmin: () => void;
  onOpenTools: () => void;
  onLogout: () => void;
}

export default function Sidebar(props: Props) {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [search, setSearch] = useState('');
  const [searchMode, setSearchMode] = useState<string>('');

  const load = () => {
    api.listConversations().then((r) => setConvs(r.conversations)).catch(() => {});
  };

  useEffect(() => {
    if (!search) { setSearchMode(''); load(); }
  }, [props.refreshKey]);

  useEffect(() => {
    if (!search) { setSearchMode(''); load(); return; }
    const t = setTimeout(() => {
      // بحث دلالي في سجل المحادثات مع رجوع نصّي (§3)
      api.search(search).then((r) => {
        setSearchMode(r.mode);
        setConvs(
          r.results.map((x: any) => ({
            id: x.conversationId ?? x.id,
            title: x.title,
            consultation_type: null,
            created_at: 0,
            updated_at: 0,
          }))
        );
      }).catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [search]);

  const del = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('حذف هذه المحادثة؟')) return;
    await api.deleteConversation(id);
    load();
    if (props.activeConv === id) props.onNewChat();
  };

  const initials = (props.user.name ?? props.user.email).slice(0, 1).toUpperCase();

  return (
    <aside className={`sidebar ${props.open ? 'open' : ''}`}>
      <div className="sidebar-header">
        <div className="brand">
          <div className="brand-logo">ن</div>
          <div>
            <div className="brand-name">مستشار ناف</div>
            <div className="brand-sub">الاستشارات القانونية الذكية</div>
          </div>
        </div>
      </div>

      <button className="new-chat-btn" onClick={props.onNewChat}>
        <span>＋</span> محادثة جديدة
      </button>

      <div className="search-box">
        <input placeholder="بحث دلالي في محادثاتك…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {searchMode === 'semantic' && <div className="search-mode">🔎 بحث دلالي</div>}
      </div>

      <button className="tools-link" onClick={props.onOpenTools}>🧰 الأدوات القانونية</button>

      <div className="conv-list">
        {convs.length === 0 && <div className="empty-state" style={{ fontSize: 13 }}>لا توجد محادثات بعد</div>}
        {convs.map((c) => (
          <div
            key={c.id}
            className={`conv-item ${props.activeConv === c.id && props.view === 'chat' ? 'active' : ''}`}
            onClick={() => props.onSelectConv(c.id)}
          >
            <span className="conv-icon">{iconFor(c.consultation_type)}</span>
            <span className="conv-title">{c.title || 'محادثة'}</span>
            <button className="conv-del" onClick={(e) => del(e, c.id)} title="حذف">
              🗑
            </button>
          </div>
        ))}
      </div>

      <div className="sidebar-footer">
        <div className="user-chip">
          <div className="user-avatar">{initials}</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{props.user.name ?? 'مستخدم'}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              {props.user.role === 'admin' ? 'مسؤول' : 'مستخدم'}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-end' }}>
          {props.user.role === 'admin' && (
            <button className="link-btn" onClick={props.onOpenAdmin}>
              لوحة الإدارة
            </button>
          )}
          <button className="link-btn" onClick={props.onLogout}>
            خروج
          </button>
        </div>
      </div>
    </aside>
  );
}
