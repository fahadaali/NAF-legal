import { useEffect, useState } from 'react';
import { api, Conversation, Folder, User } from '../lib/api';
import { optionFor } from '../lib/consultations';
import NotificationBell from './NotificationBell';
import { ConsultationIcon, Icon, ICON_SM, ICON_MD } from '../lib/icons';
import NafMark from './NafMark';

interface Props {
  user: User;
  open: boolean;
  activeConv: string | null;
  view: 'chat' | 'admin' | 'tools' | 'deadlines' | 'case' | 'support';
  refreshKey: number;
  onSelectConv: (id: string) => void;
  onNewChat: () => void;
  onOpenAdmin: () => void;
  onOpenTools: () => void;
  onOpenDeadlines: () => void;
  onOpenCase: () => void;
  onOpenSupport: () => void;
  onLogout: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

export default function Sidebar(props: Props) {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [searchMode, setSearchMode] = useState<string>('');

  const load = () => {
    api.listConversations(undefined, activeFolder ?? undefined).then((r) => setConvs(r.conversations)).catch(() => {});
  };
  const loadFolders = () => api.folders().then((r) => setFolders(r.folders)).catch(() => {});

  useEffect(() => {
    if (!search) { setSearchMode(''); load(); }
    loadFolders();
  }, [props.refreshKey, activeFolder]);

  const createFolder = async () => {
    const name = prompt('اسم القضية الجديدة:');
    if (!name?.trim()) return;
    await api.createFolder(name.trim());
    loadFolders();
  };

  const removeFolder = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('حذف هذه القضية؟ (لن تُحذف محادثاتها)')) return;
    await api.deleteFolder(id);
    if (activeFolder === id) setActiveFolder(null);
    loadFolders();
  };

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

  const rename = async (e: React.MouseEvent, c: Conversation) => {
    e.stopPropagation();
    const title = prompt('اسم المحادثة:', c.title || '');
    if (title == null || title.trim() === '' || title === c.title) return;
    await api.renameConversation(c.id, title.trim()).catch(() => {});
    load();
  };

  const initials = (props.user.name ?? props.user.email).slice(0, 1).toUpperCase();

  return (
    <aside className={`sidebar ${props.open ? 'open' : ''}`}>
      <div className="sidebar-header">
        <div className="brand">
          <NafMark />
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
        {searchMode === 'semantic' && <div className="search-mode"><Icon.search size={ICON_SM} aria-hidden /> بحث دلالي</div>}
      </div>

      <button className="tools-link" onClick={props.onOpenTools}><Icon.tools size={ICON_SM} aria-hidden /> الأدوات القانونية</button>
      <button className="tools-link" onClick={props.onOpenDeadlines}><Icon.appointment size={ICON_SM} aria-hidden /> المواعيد النظامية</button>
      <button className="tools-link" onClick={props.onOpenCase}><Icon.matter size={ICON_SM} aria-hidden /> ملف القضية</button>
      <button className="tools-link" onClick={props.onOpenSupport}><Icon.support size={ICON_SM} aria-hidden /> الدعم</button>

      <div className="folder-bar">
        <button className={`folder-chip ${!activeFolder ? 'active' : ''}`} onClick={() => setActiveFolder(null)}>
          الكل
        </button>
        {folders.map((f) => (
          <button
            key={f.id}
            className={`folder-chip ${activeFolder === f.id ? 'active' : ''}`}
            onClick={() => setActiveFolder(f.id)}
            title={`${f.count} محادثة`}
          >
            <span className="folder-dot" style={{ background: f.color }} />
            {f.name}
            <span className="folder-del" onClick={(e) => removeFolder(e, f.id)}><Icon.close size={ICON_SM} aria-hidden /></span>
          </button>
        ))}
        <button className="folder-chip add" onClick={createFolder} title="قضية جديدة">＋</button>
      </div>

      <div className="conv-list">
        {convs.length === 0 && <div className="empty-state" style={{ fontSize: '0.875rem' }}>لم تبدأ أي محادثة بعد. ابدأ بأول استشارة.</div>}
        {convs.map((c) => (
          <div
            key={c.id}
            className={`conv-item ${props.activeConv === c.id && props.view === 'chat' ? 'active' : ''}`}
            onClick={() => props.onSelectConv(c.id)}
          >
            <span className="conv-icon"><ConsultationIcon option={optionFor(c.consultation_type)} size={ICON_SM} /></span>
            <span className="conv-title">{c.title || 'محادثة'}</span>
            <button className="conv-del" onClick={(e) => rename(e, c)} title="إعادة تسمية">
              <Icon.edit size={ICON_SM} aria-hidden />
            </button>
            <button className="conv-del" onClick={(e) => del(e, c.id)} title="حذف">
              <Icon.delete size={ICON_SM} aria-hidden />
            </button>
          </div>
        ))}
      </div>

      <div className="sidebar-footer">
        <div className="user-chip">
          <div className="user-avatar">{initials}</div>
          <div>
            <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>{props.user.name ?? 'مستخدم'}</div>
            <div style={{ fontSize: '0.875rem', color: 'var(--muted-foreground)' }}>
              {props.user.role === 'admin' ? 'مسؤول' : 'مستخدم'}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
            {props.user.role === 'admin' && (
              <button className="link-btn" onClick={props.onOpenAdmin}>
                لوحة الإدارة
              </button>
            )}
            <button className="link-btn" onClick={props.onLogout}>
              خروج
            </button>
          </div>
          <NotificationBell />
          <button className="theme-toggle" onClick={props.onToggleTheme} title="تبديل السمة">
            {props.theme === 'dark'
          ? <Icon.light size={ICON_MD} aria-hidden />
          : <Icon.dark size={ICON_MD} aria-hidden />}
          </button>
        </div>
      </div>
    </aside>
  );
}
