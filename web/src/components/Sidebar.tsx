import { useEffect, useState } from 'react';
import { api, Conversation, Folder, User } from '../lib/api';
import { optionFor } from '../lib/consultations';
import { ConsultationIcon, Icon, ICON_SM } from '../lib/icons';
import NafMark from './NafMark';

interface Props {
  user: User;
  open: boolean;
  activeConv: string | null;
  view: 'chat' | 'admin' | 'members' | 'tools' | 'deadlines' | 'case' | 'support' | 'search';
  refreshKey: number;
  onSelectConv: (id: string) => void;
  onNewChat: () => void;
  onOpenAdmin: () => void;
  onOpenMembers: () => void;
  onOpenTools: () => void;
  onOpenDeadlines: () => void;
  /** يفتح شاشة البحث في المنصة بنصّ الاستعلام كما كُتب. */
  onOpenSearch: (q: string) => void;
  onOpenCase: () => void;
  onOpenSupport: () => void;
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
      // ترشيح المحادثات في الشريط: بحثٌ لفظيّ في المحادثات وحدها.
      api.search(search, 'chats').then((r) => {
        setSearchMode(r.mode);
        const seen = new Set<string>();
        setConvs(
          r.chats
            .filter((x) => (seen.has(x.conversation_id) ? false : seen.add(x.conversation_id)))
            .map((x) => ({
              id: x.conversation_id,
              title: x.title ?? '',
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

  return (
    <aside id="naf-sidebar" className={`naf-sidebar ${props.open ? 'is-open' : ''}`}>
      <div className="naf-sidebar-header">
        <NafMark />
        <div>
          <div className="naf-sidebar-brand-name">مستشار ناف</div>
          <div className="naf-sidebar-brand-sub">الاستشارات القانونية الذكية</div>
        </div>
      </div>

      {/* «مستخدم (اطّلاع)» يقرأ ولا ينشئ. والزرّ يُخفى ولا يُعطَّل: زرٌّ
          معطَّل بلا سبب ظاهر يُقرأ عطلاً في المنصة، والخادم يردّ الإنشاء
          بـ٤٠٣ على أي حال. */}
      {props.user.role !== 'viewer' && (
        <button className="new-chat-btn" onClick={props.onNewChat}>
          <span>＋</span> محادثة جديدة
        </button>
      )}

      <div className="search-box">
        {/* الشريط يرشّح المحادثات، و«Enter» يفتح البحث في المنصة كلها:
            محادثاتٍ ومخرجاتٍ وقاعدةَ معرفة. وكلاهما لفظيّ بلا نموذج. */}
        <input
          placeholder="بحث في محادثاتك — Enter للبحث في المنصة"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && search.trim()) props.onOpenSearch(search.trim());
          }}
        />
        {search.trim() ? (
          <button className="search-mode" onClick={() => props.onOpenSearch(search.trim())}>
            <Icon.search size={ICON_SM} aria-hidden /> البحث في المنصة
          </button>
        ) : null}
      </div>

      <button className="tools-link" onClick={props.onOpenTools}><Icon.tools size={ICON_SM} aria-hidden /> الأدوات القانونية</button>
      <button className="tools-link" onClick={props.onOpenDeadlines}><Icon.appointment size={ICON_SM} aria-hidden /> المواعيد النظامية</button>
      <button className="tools-link" onClick={props.onOpenCase}><Icon.matter size={ICON_SM} aria-hidden /> ملف القضية</button>
      <button className="tools-link" onClick={props.onOpenSupport}><Icon.support size={ICON_SM} aria-hidden /> الدعم</button>

      {/* شاشتا الإدارة تنقّلٌ لا أوامرُ حساب، فموضعهما الشريط مع بقية
          الوجهات — كانتا في أسفل الشريط مع الخروج والمظهر، فيبحث عنهما
          المسؤول حيث لا تكونان. والقائمة في الترويسة للهوية والمظهر
          والخروج وحدها، في المنصات الخمس. */}
      {props.user.role === 'admin' && (
        <>
          <button className="tools-link" onClick={props.onOpenAdmin}>
            <Icon.adminPanel size={ICON_SM} aria-hidden /> لوحة الإدارة
          </button>
          <button className="tools-link" onClick={props.onOpenMembers}>
            <Icon.permissions size={ICON_SM} aria-hidden /> المستخدمون والصلاحيات
          </button>
        </>
      )}

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

      {/* الهوية والمظهر والإشعارات وتسجيل الخروج انتقلت إلى قائمة الحساب
          في الترويسة — الموضع نفسه في المنصات الخمس. وكانت هنا في أسفل
          الشريط، فيختفي الخروج كلّه حين ينزلق الشريط خارج الشاشة. */}
    </aside>
  );
}
