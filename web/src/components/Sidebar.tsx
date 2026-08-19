import { Fragment, useEffect, useState } from 'react';
import { api, Conversation, Folder, User } from '../lib/api';
import { optionFor } from '../lib/consultations';
import { ConsultationIcon, Icon, ICON_SM } from '../lib/icons';
import { formatDayHeading, formatTime, isolate } from '../lib/format';
import { streamingConversationIds, subscribeChatActivity } from '../lib/chatStream';
import { Sidebar as NafSidebar } from '../naf/ui/app-shell';
import NafMark from './NafMark';

interface Props {
  user: User;
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

/**
 * صنفُ نغمة الشارة من قيمة `color` المخزَّنة.
 *
 * القيمة اسمُ نغمةٍ (`chart-1`…`chart-5`) لا لونٌ خام — انظر هجرة `0024`.
 * وما لا يُعرف يأخذ الأولى: صفٌّ قديم نجا من الهجرة يُرسم ولا يختفي.
 */
function folderTone(color: string | null | undefined): string {
  return /^chart-[1-5]$/.test(color ?? '') ? `tone-${color!.slice(-1)}` : 'tone-1';
}

/**
 * عنوان اليوم إن بدأت به مجموعة جديدة، وإلا فلا عنوان.
 *
 * القائمة مرتَّبة بـ`updated_at` تنازلياً، فتبدّلُ العنوان بين صفٍّ وسابقه
 * هو حدُّ اليوم. والمحادثة بلا وقت — صفٌّ اصطناعيّ من نتيجة بحث — لا تحمل
 * عنواناً ولا تكسر مجموعةَ ما قبلها.
 */
function dayHeadingFor(conv: Conversation, previous?: Conversation): string | null {
  if (!conv.updated_at) return null;
  const heading = formatDayHeading(conv.updated_at);
  if (previous?.updated_at && formatDayHeading(previous.updated_at) === heading) return null;
  return heading;
}

export default function Sidebar(props: Props) {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [searchMode, setSearchMode] = useState<string>('');

  /** لا نتيجة لبحثٍ جرى — تفرّقها الشاشة الفارغة عن قائمةٍ لم تبدأ بعد. */
  const [noMatches, setNoMatches] = useState(false);

  /* المحادثات التي يجري فيها دورٌ الآن.
     `streamingConversationIds` كُتبت لهذا الموضع بنصّ توثيقها — «للشريط
     الجانبي» — ولم تُستورَد قطّ. فمن بدّل المحادثة أثناء توليدٍ يجري لم يجد
     في الشريط ما يدلّه على أين تركه، والتوليد يمضي في الخلفية على أي حال.
     والاشتراك على دورة الحياة وحدها — البدء والختام — لا على كل مقطعٍ من
     النصّ: الشريط لا يُعاد بناؤه مئة مرّة في الدور الواحد. */
  const [busyConvs, setBusyConvs] = useState<string[]>(() => streamingConversationIds());
  useEffect(() => subscribeChatActivity(() => setBusyConvs(streamingConversationIds())), []);

  const load = () => {
    setNoMatches(false);
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

  /* البحث يتبع القضية المختارة كما تتبعها القائمة.
     كان الأثر معلَّقاً على `search` وحدها ولا يمرّر المجلّد، فمن رشّح قضيةً
     ثم كتب كلمةً رأى محادثاتٍ من قضايا أخرى — وشارةُ القضية ما زالت مضاءةً
     تقول إنها مُرشَّحة. والترشيح في الخادم لا هنا: الترشيح بعد القصّ يعطي
     صفحةً ناقصة أو فارغة. */
  useEffect(() => {
    if (!search) { setSearchMode(''); load(); return; }
    const t = setTimeout(() => {
      // ترشيح المحادثات في الشريط: بحثٌ لفظيّ في المحادثات وحدها.
      api.search(search, 'chats', activeFolder ?? undefined).then((r) => {
        setSearchMode(r.mode);
        const seen = new Set<string>();
        const found = r.chats
          .filter((x) => (seen.has(x.conversation_id) ? false : seen.add(x.conversation_id)))
          .map((x) => ({
            id: x.conversation_id,
            title: x.title ?? '',
            consultation_type: null,
            created_at: 0,
            updated_at: 0,
          }));
        setConvs(found);
        setNoMatches(found.length === 0);
      }).catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [search, activeFolder]);

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
    /* العنصر من السجلّ: يحمل `id` و`naf-sidebar` وحالةَ الفتح من `useShell`.
       كانت هذه الشجرة تكتبها بيدها وتأخذ الفتحَ مَعلَماً — نسختان لعقدٍ واحد. */
    <NafSidebar>
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
        <button type="button" className="new-chat-btn" onClick={props.onNewChat}>
          {/* أيقونة لا محرف: كان `＋` (U+FF0B) — زائدٌ عريض من جدول المحارف،
              لا يتبع مقاسات الأيقونات ولا سمكها، ويُرسم على كل نظامٍ بشكل.
              و«إضافة → Plus» مسجَّلة في naf-icons.md §الإجراءات. */}
          <Icon.add size={ICON_SM} aria-hidden /> محادثة جديدة
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

      {/* ══ الشارة غلافٌ لا زرّ ══
          كان زرّ الحذف `<span onClick>` داخل زرّ الشارة: زرٌّ داخل زرّ لا
          يصحّ في HTML، و`<span>` بلا `tabindex` لا تبلغه لوحة المفاتيح ولا
          تشمله قاعدةُ حلقة التركيز في `styles.css` — فكان حذف القضية فعلاً
          بالفأرة وحدها. والآن زرّان متجاوران في غلافٍ محايد، ولكلٍّ اسمٌ
          مقروء وحلقةُ تركيز. */}
      <div className="folder-bar">
        <button type="button" className={`folder-chip ${!activeFolder ? 'active' : ''}`} onClick={() => setActiveFolder(null)}>
          الكل
        </button>
        {folders.map((f) => (
          <span key={f.id} className={`folder-chip ${activeFolder === f.id ? 'active' : ''}`}>
            <button
              type="button"
              className="folder-open"
              onClick={() => setActiveFolder(f.id)}
              aria-pressed={activeFolder === f.id}
              /* العدد معزولٌ اتجاهياً: رقمٌ عارٍ في نصٍّ عربي ينقلب ترتيبه،
                 و`<bdi>` لا تصلح في سمة — و`isolate` من `naf-format` لها. */
              title={`${isolate(f.count)} محادثة`}
            >
              <span className={`folder-dot ${folderTone(f.color)}`} />
              {f.name}
            </button>
            <button
              type="button"
              className="folder-del"
              onClick={(e) => removeFolder(e, f.id)}
              aria-label={`حذف القضية ${f.name}`}
            >
              <Icon.close size={ICON_SM} aria-hidden />
            </button>
          </span>
        ))}
        <button type="button" className="folder-chip add" onClick={createFolder}>
          <Icon.add size={ICON_SM} aria-hidden /> قضية جديدة
        </button>
      </div>

      <div className="conv-list">
        {/* بحثٌ لم يُطابق شيئاً ليس قائمةً لم تبدأ.
            كانت الرسالة واحدة، فيقرأ صاحبُ ثمانين محادثة «لم تبدأ أي محادثة
            بعد» لأنه بحث عن كلمةٍ ليست فيها. وكلتاهما تدعو إلى فعلٍ صحيح
            (§7): هذه إلى توسيع البحث، وتلك إلى بدء الاستشارة الأولى. */}
        {convs.length === 0 && (
          <div className="empty-state" style={{ fontSize: '0.875rem' }}>
            {noMatches
              ? activeFolder
                ? 'لا محادثة تطابق بحثك في هذه القضية. جرّب كلمة أخرى، أو اختر «الكل».'
                : 'لا محادثة تطابق بحثك. جرّب كلمة أخرى، أو ابحث في المنصة كلها.'
              : 'لم تبدأ أي محادثة بعد. ابدأ بأول استشارة.'}
          </div>
        )}
        {convs.map((c, i) => (
          <Fragment key={c.id}>
            {/* عنوان المجموعة يظهر عند تبدّل اليوم فقط — القائمة مرتَّبة
                بـ`updated_at` تنازلياً، فتبدّلُه هو حدُّ اليوم. */}
            {dayHeadingFor(c, convs[i - 1]) && (
              <div className="conv-day">{dayHeadingFor(c, convs[i - 1])}</div>
            )}
          <div
            className={`conv-item ${props.activeConv === c.id && props.view === 'chat' ? 'active' : ''}`}
            onClick={() => props.onSelectConv(c.id)}
          >
            <span className="conv-icon"><ConsultationIcon option={optionFor(c.consultation_type)} size={ICON_SM} /></span>
            <span className="conv-main">
              <span className="conv-title">{c.title || 'محادثة'}</span>
              {/* «دورٌ يجري» — شارةٌ نصّية لا لونٌ وحده (§6: لا معنى بلون
                  مفرد). و`aria-live` مرفوعٌ عنها: القائمة تُقرأ بالتنقّل،
                  وإعلانُ كل بدءٍ وختام في محادثةٍ أخرى ضجيجٌ للقارئ بالصوت. */}
              {busyConvs.includes(c.id) && (
                <span className="conv-busy" title="يجري توليد ردّ">
                  <Icon.embedding size={ICON_SM} className="icon-spin" aria-hidden /> جارٍ
                </span>
              )}
              {/* الوقت وحده: يومُه في عنوان المجموعة فوقه، وتكراره في كل
                  صفٍّ حشوٌ يزاحم العنوان. والصيغة من `naf-format` لا من هنا،
                  وفي `bdi`: وقتٌ عارٍ داخل نصّ عربي ينقلب ترتيبه (§٥). */}
              {c.updated_at > 0 && (
                <span className="conv-time"><bdi>{formatTime(c.updated_at)}</bdi></span>
              )}
            </span>
            <button className="conv-del" onClick={(e) => rename(e, c)} title="إعادة تسمية">
              <Icon.edit size={ICON_SM} aria-hidden />
            </button>
            <button className="conv-del" onClick={(e) => del(e, c.id)} title="حذف">
              <Icon.delete size={ICON_SM} aria-hidden />
            </button>
          </div>
          </Fragment>
        ))}
      </div>

      {/* الهوية والمظهر والإشعارات وتسجيل الخروج انتقلت إلى قائمة الحساب
          في الترويسة — الموضع نفسه في المنصات الخمس. وكانت هنا في أسفل
          الشريط، فيختفي الخروج كلّه حين ينزلق الشريط خارج الشاشة. */}
    </NafSidebar>
  );
}
