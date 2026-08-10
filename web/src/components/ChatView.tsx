import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, Message, Attachment, Folder, ConsultConfig, type Citation, type Highlight } from '../lib/api';
import { CONSULTATIONS, labelFor } from '../lib/consultations';
import { renderMarkdown } from '../lib/markdown';
import { printDocument, fetchLetterhead, PRINT_TEMPLATE_FALLBACK } from '../lib/print';
import {
  clearChatStream,
  getChatStream,
  startChatStream,
  subscribeChatStream,
  type ChatStream,
} from '../lib/chatStream';
import { highlightIdAt, offsetsOfSelection, type RenderableHighlight } from '../lib/highlight';
import IntakeModal from './IntakeModal';
import DraftEditor from './DraftEditor';
import ClauseLibrary from './ClauseLibrary';
import RegulationRequestModal from './RegulationRequestModal';
import MessageContent from './MessageContent';
import SelectionToolbar, { type SelectionAnchor } from './SelectionToolbar';
import SourceModal, { isOpenableCitation } from './SourceModal';
import AttachmentViewer from './AttachmentViewer';
import { ConsultationIcon, Icon, ICON_SM, ICON_MD, ICON_LG } from '../lib/icons';

interface Props {
  conversationId: string | null;
  initialMessage?: string | null;
  onInitialConsumed?: () => void;
  onStartConversation?: (conversationId: string, message: string) => void;
  onConversationChange: (id: string) => void;
  /** «مستخدم (اطّلاع)» يقرأ المحادثات ولا يكتب فيها. */
  readOnly?: boolean;
}

interface UiMessage extends Message {
  citations?: Citation[];
  clarifying?: boolean;
  streaming?: boolean;
  verification?: { verified: boolean; unsupported: string[]; note: string } | null;
  // أنظمة يتطلّبها الإسناد ولا وجود لها في قاعدة المعرفة
  missingRegulations?: string[];
}

/**
 * كم بكسلاً عن القاع يبقى «في القاع».
 *
 * قياسُ سلوكٍ لا قياسُ تصميم: ما دون هذا يعني أن القارئ يتابع آخر الردّ،
 * فيُنزَل معه؛ وما فوقه يعني أنه صعد يقرأ ما مضى، فجرُّه إلى الأسفل مع كل
 * مقطعٍ يصل يسلبه ما كان يقرؤه.
 */
const NEAR_BOTTOM = 120;

/** جسُّ دورٍ يجري في الخادم بعد أن ذهب بثُّه مع الصفحة. */
const POLL_MS = 4000;

/** مرجعٌ ثابت لرسالةٍ بلا تظليل — حتى لا يُعاد الرسم مع كل إعادة بناء. */
const NO_HIGHLIGHTS: RenderableHighlight[] = [];

/**
 * مسوّدةُ الصندوق — محفوظةٌ بمحادثتها.
 *
 * بمحادثتها لا بمفتاحٍ واحد: من كتب سؤالاً في محادثةٍ ثم فتح أخرى لا يجد
 * سؤاله في غير موضعه. و«محادثة جديدة» لها مفتاحُها كذلك.
 */
const draftKey = (id: string | null) => `naf.draft.${id ?? 'new'}`;

function readDraft(id: string | null): string {
  try {
    return sessionStorage.getItem(draftKey(id)) ?? '';
  } catch {
    return ''; // تخزينٌ ممنوع في المتصفّح: الصندوق يبدأ فارغاً ولا شيء ينكسر.
  }
}

function writeDraft(id: string | null, text: string): void {
  try {
    if (text) sessionStorage.setItem(draftKey(id), text);
    else sessionStorage.removeItem(draftKey(id));
  } catch {
    // ممتلئٌ أو ممنوع — الكتابة تمضي والمسوّدة لا تُحفَظ. ولا يُوقَف الإرسال لأجلها.
  }
}

/** أقربُ فقاعةِ نصٍّ تحتوي هذه العقدة. */
function hostOf(node: Node | null): HTMLElement | null {
  const el = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  return el?.closest<HTMLElement>('[data-message-id]') ?? null;
}

export default function ChatView({ conversationId, initialMessage, onInitialConsumed, onStartConversation, onConversationChange, readOnly = false }: Props) {
  const [convType, setConvType] = useState<string | null>(null);
  // عنوان المحادثة كما هو مخزَّن — يُصاغ من موضوعها عند أول ردّ (§٦ من مسار
  // المحادثة). وكانت الترويسة تعرض أول خمسين حرفاً من رسالة المستخدم، وهي في
  // كل مرّة ترويسةُ نموذج الإدخال نفسها.
  const [convTitle, setConvTitle] = useState('');
  const [configs, setConfigs] = useState<ConsultConfig[]>([]);
  const [intake, setIntake] = useState<ConsultConfig | null>(null);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [clausePicker, setClausePicker] = useState(false);
  // طلب إضافة نظام: اسم النظام المعروض في النافذة، والأسماء التي عولجت في هذه الجلسة
  const [regRequest, setRegRequest] = useState<string | null>(null);
  const [handledRegs, setHandledRegs] = useState<string[]>([]);
  const autoAsked = useRef<Set<string>>(new Set());
  const autoSent = useRef(false);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [convFolder, setConvFolder] = useState<string>('');
  const [feedback, setFeedback] = useState<Record<string, number>>({});
  /* ما كُتب ولم يُرسَل يعيش خارج هذه الشاشة أيضاً.
     الجلسة تنتهي فتُحوَّل الصفحة إلى المركز وتعود — تنقّلٌ كامل يهدم الحالة —
     وصفحةٌ كتبها المحامي في الصندوق تذهب معها. و«ما كتبته محفوظ» في شريط
     انتهاء الجلسة وعدٌ يُوفى هنا أو لا يُقال. والتخزين للجلسة لا دائم: مسوّدةٌ
     تركها في حاسوبٍ مشترك لا تبقى فيه بعد إغلاق التبويب. */
  const [input, setInput] = useState(() => readDraft(conversationId));
  const [internet, setInternet] = useState(false);
  const [bilingual, setBilingual] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  /** دورٌ يجري في الخادم ولا بثَّ له هنا — عودةٌ بعد إعادة تحميل الصفحة. */
  const [generating, setGenerating] = useState(false);
  /** المصدر المفتوح في النافذة، إن فُتح. */
  const [source, setSource] = useState<Citation | null>(null);
  /** المرفق المفتوح في النافذة العائمة، إن فُتح. */
  const [openAttachment, setOpenAttachment] = useState<Attachment | null>(null);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const messagesBox = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  useEffect(() => {
    api.folders().then((r) => setFolders(r.folders)).catch(() => {});
  }, []);

  // الحفظ مع كل حرف: التحويل يقع بلا إنذار، فلا فرصة لحفظٍ مؤجَّل.
  useEffect(() => writeDraft(conversationId, input), [conversationId, input]);

  /* ══ الدور الجاري يعيش خارج هذه الشاشة ══
   *
   * كانت حالة البثّ هنا في `useState`، والشاشة تُهدَم عند كل انتقال —
   * `key={activeConv}` في `App.tsx` يهدمها عند تبديل المحادثة، والعرضُ
   * المشروط يهدمها عند فتح الأدوات — فيذهب معها ما وصل من الردّ. وهي في
   * `lib/chatStream.ts` الآن: خريطةٌ تعيش ما عاشت الصفحة، وهذه الشاشة تشترك
   * فيها وتنصرف. */
  const [stream, setStream] = useState<ChatStream | undefined>(() => getChatStream(conversationId));

  useEffect(() => {
    if (!conversationId) {
      setStream(undefined);
      return;
    }
    setStream(getChatStream(conversationId));
    return subscribeChatStream(conversationId, setStream);
  }, [conversationId]);

  /** رمزُ آخر طلب تحميل — استجابةٌ سبقتها أخرى لا تُبنى فوقها. */
  const loadToken = useRef(0);

  /** يجلب المحادثة من القاعدة. تُستدعى عند الفتح، وعند ختام دور، وفي الجسّ. */
  /* `background` يمرّ إلى `api` ولا يُستعمل هنا: النداء واحد والباعث اثنان —
     من فتح المحادثة ينتظر ظهورها، ومن يجسّ دوراً يجري لا ينتظر شيئاً. وانتهاءُ
     الرمز أثناء الجسّ يرفع شريطاً؛ وأثناء الفتح يُحوِّل. */
  const load = useCallback(async (opts: { withFeedback?: boolean; background?: boolean } = {}) => {
    if (!conversationId) return;
    const token = ++loadToken.current;
    try {
      const r = await api.getConversation(conversationId, opts.background === true);
      // استجابةٌ تخصّ محادثةً غادرها القارئ: لا تُبنى الرسائل فوقه.
      if (token !== loadToken.current) return;
      setConvType(r.conversation.consultation_type);
      setConvTitle(r.conversation.title ?? '');
      setConvFolder((r.conversation as any).folder_id ?? '');
      setGenerating(!!r.generating);
      const msgs = r.messages.map((m) => {
        let citations, clarifying, verification, missingRegulations;
        try {
          const meta = m.metadata_json ? JSON.parse(m.metadata_json) : {};
          citations = meta.citations;
          clarifying = meta.clarifying;
          verification = meta.verification;
          missingRegulations = meta.missing_regulations;
        } catch {}
        return { ...m, citations, clarifying, verification, missingRegulations };
      });
      setMessages(msgs);
      setAttachments(r.attachments);

      /* التقييمات تُجلب عند فتح المحادثة وحدها.
         نداءٌ لكل رسالة مساعد — ومحادثةٌ ذات عشرين ردّاً تعني إحدى وعشرين
         نداءً في الجلبة الواحدة. وحدّ المعدّل ستون في الدقيقة، فجلبةٌ متكرّرة
         كلَّ أربع ثوانٍ أثناء الجسّ تُحرق الحدّ وتُغلق المنصة على صاحبها.
         والجسُّ لا يحتاجها أصلاً: التقييم لا يتغيّر إلا بيد صاحبه، ورسالةٌ
         وُلدت للتوّ لا تقييم لها. */
      if (opts.withFeedback === false) return;
      const pairs = await Promise.all(
        msgs
          .filter((m) => m.role === 'assistant')
          .map((m) => api.getFeedback(m.id).then((f) => [m.id, f.feedback?.rating] as const).catch(() => [m.id, undefined] as const))
      );
      if (token !== loadToken.current) return;
      const map: Record<string, number> = {};
      for (const [id, rating] of pairs) if (rating) map[id] = rating;
      setFeedback(map);
    } catch {
      // محادثةٌ لم تُجلب لا تُفرَّغ: ما على الشاشة أصدق من شاشةٍ خاوية.
    }
  }, [conversationId]);

  useEffect(() => {
    if (conversationId) {
      load();
    } else {
      setConvType(null);
      setConvTitle('');
      setMessages([]);
      setAttachments([]);
      setGenerating(false);
    }
  }, [conversationId, load]);

  // تظليلات المحادثة كلِّها — نداءٌ واحد عند فتحها لا نداءٌ لكل رسالة.
  useEffect(() => {
    if (!conversationId) {
      setHighlights([]);
      return;
    }
    let live = true;
    api
      .highlights(conversationId)
      .then((r) => live && setHighlights(r.highlights))
      .catch(() => live && setHighlights([]));
    return () => {
      live = false;
    };
  }, [conversationId]);

  /* ختامُ الدور: القاعدة تصير المصدر.
     تُجلب المحادثة ليأتي الردّ بمعرّفه وبياناته الوصفية، ثم يُمسح الدور من
     الخريطة فلا يُرسم مرّتين. والمنقطعُ لا يُمسح: نصُّه لم يُحفَظ، ومحوُه
     يُضيّع ما وصل وسببَ انقطاعه معاً. */
  const settled = useRef<number | null>(null);
  useEffect(() => {
    if (!conversationId || !stream || stream.streaming || stream.error) return;
    if (settled.current === stream.startedAt) return;
    const token = stream.startedAt;
    settled.current = token;
    load({ withFeedback: false }).finally(() => {
      /* العلامة تُنزل هنا ولا تُنتظر من الخادم.
         الخادم يمسحها بعد أن يبعث `done` بقليل، فالجلبة التي تلي الختام قد
         تعود بها مرفوعة — فتُشغّل الجسّ ويظهر «جارٍ التوليد» تحت ردٍّ وصل
         واكتمل. والدور انتهى عندنا يقيناً: `done` معناه أن الردّ حُفظ. */
      setGenerating(false);
      /* ولا يُمسح إلا الدور الذي خُتم: من أرسل رسالةً ثانية والجلبة في
         الطريق يكون قد بدأ دوراً جديداً، ومسحُه يُطفئ ما يُبَثّ الآن. */
      if (getChatStream(conversationId)?.startedAt === token) clearChatStream(conversationId);
    });
  }, [conversationId, stream, load]);

  // العنوان يُصاغ من موضوع المحادثة عند أوّل ردّ — والترويسة تتبعه فوراً.
  useEffect(() => {
    if (stream?.title) setConvTitle(stream.title);
  }, [stream?.title]);

  /* نظامٌ يتطلّبه الإسناد وغير موجود: تُعرض النافذة مرّة واحدة لكل نظام،
     ويبقى التنبيه أسفل الرد لفتحها متى شاء المستخدم بعد إغلاقها. */
  useEffect(() => {
    const missing = stream?.missingRegulations;
    if (!missing?.length) return;
    const pending = missing.filter((n) => !autoAsked.current.has(n));
    if (pending.length) {
      autoAsked.current.add(pending[0]);
      setRegRequest(pending[0]);
    }
  }, [stream?.missingRegulations]);

  /* عائدٌ بعد إعادة تحميل الصفحة: الدور يجري في الخادم وبثُّه ذهب مع الصفحة.
     فيُجَسّ متباعداً حتى يصل الردّ — ولا يُعاد الإرسال: دورٌ ثانٍ على دورٍ
     يجري يدفع كلفةً مرّتين ويعطي إجابتين لسؤال واحد. */
  useEffect(() => {
    if (!conversationId || !generating || stream) return;
    const t = window.setInterval(() => void load({ withFeedback: false, background: true }), POLL_MS);
    return () => window.clearInterval(t);
  }, [conversationId, generating, stream, load]);

  /* الرسائل المعروضة: ما في القاعدة، ثم ما يجري الآن.
     ورسالة المستخدم لا تُضاف مرّتين — الخادم يحفظها قبل أن يبدأ التوليد،
     فمن عاد إلى المحادثة وجدها في القاعدة سلفاً. */
  const shown: UiMessage[] = useMemo(() => {
    if (!stream) return messages;
    const list = [...messages];
    const last = list[list.length - 1];
    if (!(last && last.role === 'user' && last.content === stream.userText)) {
      list.push({ id: `u${stream.startedAt}`, role: 'user', content: stream.userText, created_at: stream.startedAt });
    }
    list.push({
      id: stream.messageId,
      role: 'assistant',
      content: stream.error ? (stream.text ? `${stream.text}\n\n${stream.error}` : stream.error) : stream.text,
      created_at: stream.startedAt,
      citations: stream.citations,
      clarifying: stream.clarifying,
      verification: stream.verification,
      missingRegulations: stream.missingRegulations,
      streaming: stream.streaming,
    });
    return list;
  }, [messages, stream]);

  const sending = !!stream?.streaming;
  const searching = !!stream?.searching;
  /** رسائلُ لها صفٌّ في القاعدة — وهي وحدها ما يُظلَّل: التظليل يُسنَد إليها. */
  const persistedIds = useMemo(() => new Set(messages.map((m) => m.id)), [messages]);

  const highlightsByMessage = useMemo(() => {
    const map = new Map<string, RenderableHighlight[]>();
    for (const h of highlights) {
      const list = map.get(h.message_id) ?? [];
      list.push({ id: h.id, start: h.start_off, end: h.end_off, text: h.text });
      map.set(h.message_id, list);
    }
    return map;
  }, [highlights]);

  /* ══ المرفقات: بابان لا واحد ══
   *
   * `message_id` يقسمها. ما له رسالةٌ يُعرض في فقاعتها — هناك ذهب الملف،
   * ومع هذا السؤال بعينه لحق. وما لا رسالة له يبقى في صندوق الكتابة
   * منتظراً إرساله، ويُحذف من هناك.
   *
   * وكان القسمان واحداً: كلُّ مرفقات المحادثة فوق الصندوق أبداً. فالشارة
   * تقول «لم يُرسَل» عن ملفٍّ أُرسل قبل عشرة أدوار، ولا شيء في الشاشة يقول
   * أين ذهب — وهو ما يجعل الملف «مرفوعاً في مكانٍ لا يُعرَف». */
  const pendingAttachments = useMemo(
    () => attachments.filter((a) => !a.message_id),
    [attachments]
  );

  const attachmentsByMessage = useMemo(() => {
    const map = new Map<string, Attachment[]>();
    for (const a of attachments) {
      if (!a.message_id) continue;
      const list = map.get(a.message_id) ?? [];
      list.push(a);
      map.set(a.message_id, list);
    }
    return map;
  }, [attachments]);

  /* ══ التحديد ══
   *
   * النصّ في المحادثة قابلٌ للتحديد كأي نصّ، وشريطُ التحديد يظهر فوق ما
   * حُدِّد. والقياس يقع على فقاعةٍ واحدة: تحديدٌ يمتدّ من رسالةٍ إلى التي
   * تليها ليس تظليلاً في واحدةٍ منهما، فيُنسخ ولا يُظلَّل. */
  const [selection, setSelection] = useState<{
    messageId: string;
    start: number;
    end: number;
    text: string;
    highlightId: string | null;
    anchor: SelectionAnchor;
  } | null>(null);

  useEffect(() => {
    const evaluate = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return setSelection(null);
      const range = sel.getRangeAt(0);
      const host = hostOf(range.startContainer);
      if (!host || host !== hostOf(range.endContainer)) return setSelection(null);
      const offsets = offsetsOfSelection(host, range);
      if (!offsets) return setSelection(null);
      const rect = range.getBoundingClientRect();
      setSelection({
        messageId: host.dataset.messageId ?? '',
        ...offsets,
        highlightId: highlightIdAt(host, sel.anchorNode),
        // إحداثيات قياسٍ لا قيم تصميم: الشريط `fixed` عند مستطيل التحديد كما
        // قاسه المتصفّح. والمنتصف فيزيائيّ بالضرورة — `getBoundingClientRect`
        // تقيس من حافّة النافذة اليسرى في الاتجاهين معاً. وحبسُه داخل النافذة
        // في `SelectionToolbar` بعد قياس عرضه.
        anchor: { top: rect.top, bottom: rect.bottom, center: rect.left + rect.width / 2 },
      });
    };

    // بعد دورةٍ واحدة: التحديد لا يكتمل في المتصفّح إلا بعد `mouseup` نفسه.
    const onUp = () => window.setTimeout(evaluate, 0);
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest?.('.selection-toolbar')) setSelection(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelection(null);
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchend', onUp);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchend', onUp);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  /** يُنهي التحديد بعد أن يقع فعلُه: شريطٌ يبقى فوق نصٍّ عُولج يُقرأ عطلاً. */
  const dropSelection = () => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  const copySelection = () => {
    if (selection) navigator.clipboard?.writeText(selection.text).catch(() => {});
  };

  const highlightSelection = async () => {
    if (!selection) return;
    const { messageId, start, end, text } = selection;
    dropSelection();
    try {
      const h = await api.addHighlight(messageId, { start, end, text });
      setHighlights((all) => [...all, h]);
    } catch (e: any) {
      alert(e?.message ?? 'تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة');
    }
  };

  const removeHighlight = async () => {
    const id = selection?.highlightId;
    if (!id) return;
    dropSelection();
    try {
      await api.deleteHighlight(id);
      setHighlights((all) => all.filter((h) => h.id !== id));
    } catch (e: any) {
      alert(e?.message ?? 'تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة');
    }
  };

  const quoteSelection = () => {
    const text = selection?.text;
    if (!text) return;
    dropSelection();
    setInput((v) => `${v}${v ? '\n\n' : ''}«${text}»\n`);
    textarea.current?.focus();
  };

  /* ══ النزول التلقائي ══
   *
   * كان يقع مع كل تغيّرٍ في الرسائل بلا شرط، فينتزع من القارئ ما كان يقرؤه
   * أو يحدّده: الردّ يصل مقطعاً مقطعاً، وكلُّ مقطعٍ يقفز بالشاشة إلى القاع.
   * فصار مشروطاً باثنتين: أن يكون القارئ متابعاً للقاع، وألّا يكون بيده
   * تحديدٌ قائم. */
  const pinned = useRef(true);
  useEffect(() => {
    pinned.current = true;
  }, [conversationId]);

  useEffect(() => {
    if (!pinned.current) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && messagesBox.current?.contains(sel.anchorNode)) return;
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [shown, generating]);

  const onMessagesScroll = () => {
    const box = messagesBox.current;
    if (!box) return;
    pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM;
  };

  const autoGrow = () => {
    const el = textarea.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    }
  };

  // حمّل إعدادات نماذج الاستشارات (للنافذة المنبثقة)
  useEffect(() => {
    if (!conversationId) api.consultationConfigs().then((r) => setConfigs(r.configs)).catch(() => {});
  }, [conversationId]);

  // فتح نافذة الإدخال عند اختيار نوع
  const openIntake = (type: string) => {
    const cfg = configs.find((c) => c.key === type);
    if (cfg) setIntake(cfg);
    else startConsultation(type); // احتياط إن لم تُحمّل الإعدادات
  };

  const startConsultation = async (type: string) => {
    const conv = await api.createConversation(type);
    setConvType(type);
    onConversationChange(conv.id);
  };

  // إرسال رسالة البدء تلقائيًا بعد إنشاء المحادثة من النافذة المنبثقة
  useEffect(() => {
    if (conversationId && initialMessage && !autoSent.current) {
      autoSent.current = true;
      send(initialMessage);
      onInitialConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, initialMessage]);

  const doUpload = async (files: FileList | null) => {
    if (!files?.length || !conversationId) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        const r = await api.uploadFile(conversationId, f);
        setAttachments((a) => [
          ...a,
          {
            id: r.id,
            message_id: null,
            filename: r.filename,
            mime: r.mime,
            size: r.size,
            parse_status: r.parse_status,
            created_at: Date.now(),
          },
        ]);
      }
    } catch (e: any) {
      alert(e.message ?? 'فشل رفع الملف');
    } finally {
      setUploading(false);
    }
  };

  /* استخراج النصّ يجري في الخادم بعد ردّ الرفع، فتُسأل حالُه حتى تستقرّ.
     والسؤال يقف عند أوّل شارةٍ تستقرّ لا يمضي بلا نهاية: `pending` وحدها
     تُسأل، ومن يفتح الشاشة بلا مرفقٍ منتظر لا يرسل نداءً أصلاً. */
  const parsingIds = pendingAttachments
    .filter((a) => a.parse_status === 'pending')
    .map((a) => a.id)
    .join(',');
  useEffect(() => {
    if (!parsingIds) return;
    let live = true;
    const tick = window.setInterval(async () => {
      const rows = await Promise.all(
        parsingIds.split(',').map((id) => api.attachment(id).catch(() => null))
      );
      if (!live) return;
      const settled = rows.filter((r): r is Attachment => !!r && r.parse_status !== 'pending');
      if (settled.length) {
        setAttachments((list) =>
          list.map((a) => settled.find((s) => s.id === a.id) ?? a)
        );
      }
    }, 2000);
    return () => {
      live = false;
      window.clearInterval(tick);
    };
  }, [parsingIds]);

  /** يحذف مرفقاً لم يُرسَل بعد — من صندوق الكتابة كما وُضع فيه. */
  const removeAttachment = async (id: string) => {
    try {
      await api.deleteAttachment(id);
      setAttachments((list) => list.filter((a) => a.id !== id));
    } catch (e: any) {
      // رسالةُ الخادم إن جاءت — «المرفق مُرسَل مع رسالته ولا يُحذف منها» تقول
      // السبب، والعامّة تقول ما العمل. وكلتاهما مسجَّلة.
      alert(e.message ?? 'تعذّر حذف المرفق. أعد المحاولة بعد قليل');
    }
  };

  /* دورٌ لا يُرسَل ونصُّ مرفقه يُقرأ بعد.
     المرفق أُلحق **بهذا السؤال**، وإرسالُه قبل أن يُقرأ يُنتج جواباً لا يراه —
     ثم يُعاد السؤال. والشارة تقول لماذا الزرُّ معطَّل، فلا يحتاج سطراً ثانياً. */
  const attachmentsParsing = pendingAttachments.some((a) => a.parse_status === 'pending');

  const send = (explicit?: string) => {
    const text = (explicit ?? input).trim();
    if (!text || !conversationId || sending || attachmentsParsing) return;
    if (!explicit) setInput('');
    if (textarea.current) textarea.current.style.height = 'auto';

    /* المرفقات تُرسل بمعرِّفاتها وتغادر صندوق الكتابة في اللحظة نفسها.
       الخادم يختمها برسالة هذا الدور، والشاشة تُسقطها من الصندوق فوراً —
       ولا تنتظر جولةً إلى الخادم وعودة: شارةٌ تبقى ثانيةً بعد الإرسال تقول
       إن الملف لم يُرسَل، وهو مرسَل. وتعود إلى فقاعتها عند أوّل جلبة. */
    const sentIds = pendingAttachments.map((a) => a.id);
    if (sentIds.length) setAttachments((list) => list.filter((a) => !sentIds.includes(a.id)));

    // دورٌ سابق انقطع فبقي معروضاً: يُمسح عند بدء التالي لا قبله.
    if (getChatStream(conversationId)) clearChatStream(conversationId);
    pinned.current = true;
    startChatStream({ conversationId, message: text, internet, bilingual, attachmentIds: sentIds });
  };

  // تسجيل صوتي للوقائع ثم تفريغه عربيًا (§3)
  const toggleRecording = async () => {
    if (recording) {
      recorder.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunks.current = [];
      mr.ondataavailable = (e) => chunks.current.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunks.current, { type: 'audio/webm' });
        try {
          const r = await api.transcribe(blob);
          if (r.text) setInput((v) => (v ? v + ' ' : '') + r.text);
        } catch (e: any) {
          alert(e.message ?? 'تعذّر التفريغ الصوتي');
        }
      };
      mr.start();
      recorder.current = mr;
      setRecording(true);
    } catch {
      alert('تعذّر الوصول للميكروفون. تحقّق من إذن المتصفّح وأعد المحاولة.');
    }
  };

  /* تصدير PDF عبر طباعة المتصفّح (يدعم العربية أصلًا) (§4).
     القالب في `lib/print.ts`: الخط والأحجام ونطاق الكتابة والرأسية من
     إعدادات المنصة نفسها التي يقرأها تصدير Word. */
  const exportPdf = async (m: UiMessage) => {
    let template = PRINT_TEMPLATE_FALLBACK;
    let letterheadUrl: string | undefined;
    try {
      const r = await api.docTemplate();
      template = r.template;
      if (r.letterhead) letterheadUrl = await fetchLetterhead(api.letterheadUrl());
    } catch {
      // إعدادٌ لم يُجلب لا يمنع طباعة مسودّة — تخرج بقالب المنصة الافتراضي.
    }
    printDocument({
      title: convTitle || labelFor(convType),
      html: renderMarkdown(m.content),
      template,
      letterheadUrl,
      disclaimer: 'هذا المحتوى مسودّة مساعِدة تتطلّب مراجعة محامٍ مختصّ قبل الاعتماد.',
    });
  };

  // مشاركة المسودّة مع محامٍ للمراجعة (§3)
  const shareDraft = async (m: UiMessage) => {
    const label = prompt('اسم/صفة المراجِع (اختياري):') ?? undefined;
    try {
      const r = await api.createShare(m.id, label);
      const url = `${location.origin}${r.url}`;
      await navigator.clipboard.writeText(url).catch(() => {});
      alert(`تم إنشاء رابط المراجعة ونسخه:\n${url}`);
    } catch (e: any) {
      alert(e.message ?? 'تعذّر إنشاء الرابط');
    }
  };

  const sendFeedback = async (m: UiMessage, rating: number) => {
    const next = feedback[m.id] === rating ? 0 : rating; // إلغاء عند إعادة النقر
    setFeedback((f) => ({ ...f, [m.id]: next }));
    if (next === 0) return;
    try {
      await api.sendFeedback(m.id, next);
    } catch {}
  };

  const assignFolder = async (folderId: string) => {
    if (!conversationId) return;
    setConvFolder(folderId);
    await api.assignFolder(conversationId, folderId || null).catch(() => {});
    onConversationChange(conversationId); // حدّث الشريط الجانبي
  };

  // ── شاشة اختيار النوع ──
  if (!conversationId) {
    const grouped = CONSULTATIONS.filter((c) => c.group === 'التقاضي');
    const others = CONSULTATIONS.filter((c) => !c.group);
    return (
      <div className="picker">
        <div className="picker-inner">
          <h1>كيف يمكن لمستشار ناف مساعدتك اليوم؟</h1>
          <p className="lead">اختر نوع الاستشارة لبدء محادثة جديدة. جميع المخرجات مسوّدات تخضع لمراجعة محامٍ.</p>

          <div className="picker-group-title"><Icon.litigation size={ICON_SM} aria-hidden /> التقاضي</div>
          <div className="cards">
            {grouped.map((c) => (
              <button key={c.type} className="card" onClick={() => openIntake(c.type)}>
                <div className="card-icon"><ConsultationIcon option={c} size={ICON_LG} /></div>
                <div className="card-title">{c.label}</div>
                <div className="card-desc">{c.description}</div>
              </button>
            ))}
          </div>

          <div className="picker-group-title">خدمات أخرى</div>
          <div className="cards">
            {others.map((c) => (
              <button key={c.type} className="card" onClick={() => openIntake(c.type)}>
                <div className="card-icon"><ConsultationIcon option={c} size={ICON_LG} /></div>
                <div className="card-title">{c.label}</div>
                <div className="card-desc">{c.description}</div>
              </button>
            ))}
          </div>
        </div>

        {intake && (
          <IntakeModal
            config={intake}
            onClose={() => setIntake(null)}
            onStart={(convId, message) => {
              setIntake(null);
              onStartConversation?.(convId, message);
            }}
          />
        )}
      </div>
    );
  }

  // ── نافذة المحادثة ──
  return (
    <>
      <div className="chat-header">
        <span className="ch-title">{convTitle || 'محادثة جديدة'}</span>
        {folders.length > 0 && (
          <select className="folder-select" value={convFolder} onChange={(e) => assignFolder(e.target.value)} title="ربط بقضية">
            <option value="">بدون قضية</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        )}
        {convType && <span className="ch-badge">{labelFor(convType)}</span>}
      </div>

      <div className="messages" ref={messagesBox} onScroll={onMessagesScroll}>
        <div className="messages-inner">
          {shown.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              <div className="msg-avatar">{m.role === 'user' ? 'أنت' : 'ن'}</div>
              <div className="msg-body">
                <div className="msg-role">{m.role === 'user' ? 'أنت' : 'مستشار ناف'}</div>
                {/* مرفقاتُ هذه الرسالة، فوق نصِّها كما أُرسلت معه. وهي منفذ
                    النافذة العائمة: لا زرَّ ثالث في الفقاعة، الشارةُ نفسها
                    تفتح ما تسمّيه. */}
                {(attachmentsByMessage.get(m.id) ?? []).length > 0 && (
                  <div className="attachments-row">
                    {attachmentsByMessage.get(m.id)!.map((a) => (
                      <AttachChip key={a.id} attachment={a} onOpen={() => setOpenAttachment(a)} />
                    ))}
                  </div>
                )}
                <div className="msg-content">
                  {m.streaming && !m.content ? (
                    <div className="typing-dots">
                      {searching && <span className="typing-note"><Icon.search size={ICON_SM} aria-hidden /> يبحث في المصادر…</span>}
                      <span></span>
                      <span></span>
                      <span></span>
                    </div>
                  ) : (
                    <MessageContent
                      messageId={m.id}
                      html={renderMarkdown(m.content)}
                      highlights={highlightsByMessage.get(m.id) ?? NO_HIGHLIGHTS}
                    />
                  )}
                  {m.clarifying && <div className="clarify-note"><Icon.awaitingClarification size={ICON_SM} aria-hidden /> بانتظار توضيحك للمتابعة</div>}
                  {m.verification && !m.streaming && (
                    <div className={`verify-badge ${m.verification.verified ? 'ok' : 'warn'}`}>
                      {m.verification.verified ? (
                        'تحقّق الإسناد: كل المواد المذكورة مسنودة في قاعدة المعرفة'
                      ) : (
                        <>
                          <Icon.warning size={ICON_SM} aria-hidden /> مواد بحاجة لتأكيد يدوي:{' '}
                          <bdi>{m.verification.unsupported.join('، ')}</bdi>
                        </>
                      )}
                    </div>
                  )}
                  {!m.streaming &&
                    (m.missingRegulations ?? [])
                      .filter((n) => !handledRegs.includes(n))
                      .map((n) => (
                        <div className="missing-reg-note" key={n}>
                          <span className="missing-reg-label">
                            <Icon.warning size={ICON_SM} aria-hidden /> غير موجود في قاعدة المعرفة:
                          </span>
                          <bdi>{n}</bdi>
                          <button className="btn-sm" onClick={() => setRegRequest(n)}>
                            طلب إضافته
                          </button>
                        </div>
                      ))}
                  {/* المصدر يُفتح لا يُذكر وحده: الشارة زرٌّ يعرض المادة
                      بنصّها وأداة إصدارها وسجلّ تعديلاتها، ومنفذاً إلى
                      صفحتها الرسمية. وما لا يحمل ما يُفتح به يبقى شارةً —
                      استشهادات المحادثات القديمة حُفظت بالعنوان وحده. */}
                  {m.citations && m.citations.length > 0 && (
                    <div className="citations">
                      <span>المصادر:</span>
                      {m.citations.map((c: Citation, i: number) =>
                        isOpenableCitation(c) ? (
                          <button key={i} className="citation-chip is-open" onClick={() => setSource(c)}>
                            <Icon.officialSource size={ICON_SM} aria-hidden />
                            <bdi>
                              {c.title}
                              {c.ref ? ` — ${c.ref}` : ''}
                            </bdi>
                          </button>
                        ) : (
                          <span key={i} className="citation-chip">
                            <bdi>
                              {c.title}
                              {c.ref ? ` — ${c.ref}` : ''}
                            </bdi>
                          </span>
                        )
                      )}
                    </div>
                  )}
                </div>
                {m.role === 'assistant' && !m.streaming && m.content && !m.clarifying && persistedIds.has(m.id) && (
                  <div className="msg-actions">
                    <a href={api.exportUrl(m.id, 'docx')} download>
                      <button><Icon.download size={ICON_SM} aria-hidden /> Word</button>
                    </a>
                    <button onClick={() => exportPdf(m)}><Icon.download size={ICON_SM} aria-hidden /> PDF</button>
                    <a href={api.exportUrl(m.id, 'txt')} download>
                      <button><Icon.download size={ICON_SM} aria-hidden /> نص</button>
                    </a>
                    <button onClick={() => navigator.clipboard.writeText(m.content)}>نسخ</button>
                    <button onClick={() => setEditing({ id: m.id, title: labelFor(convType) })}><Icon.edit size={ICON_SM} aria-hidden /> تعديل واعتماد</button>
                    <button onClick={() => shareDraft(m)}><Icon.share size={ICON_SM} aria-hidden /> مشاركة للمراجعة</button>
                    <button className={feedback[m.id] === 1 ? 'fb-on' : ''} onClick={() => sendFeedback(m, 1)} title="مفيد"><Icon.helpful size={ICON_SM} aria-hidden /></button>
                    <button className={feedback[m.id] === -1 ? 'fb-on' : ''} onClick={() => sendFeedback(m, -1)} title="يحتاج تحسين"><Icon.needsWork size={ICON_SM} aria-hidden /></button>
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* دورٌ يجري في الخادم وبثُّه ذهب مع الصفحة: يُقال ذلك ولا تُترك
              المحادثة ساكنةً فيُعاد السؤال على سؤالٍ يُجاب. */}
          {generating && !stream && (
            <div className="msg assistant">
              <div className="msg-avatar">ن</div>
              <div className="msg-body">
                <div className="msg-role">مستشار ناف</div>
                <div className="msg-content">
                  <div className="typing-dots">
                    <span className="typing-note">جارٍ التوليد</span>
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEnd} />
        </div>
      </div>

      {/* «مستخدم (اطّلاع)» يقرأ المحادثة ولا يكتب فيها.

          والصندوق يُخفى ولا يُعطَّل: صندوقُ كتابةٍ معطَّل يدعو إلى الكتابة
          ثم يمنعها، وأزرارُه العشرة تبقى معروضة بلا عمل. وسطرٌ واحد يقول
          الحدّ أصدقُ منه — والنصّ مسجَّل في `naf-terms.md` §١٠. */}
      {readOnly ? (
        <div className="composer">
          <div className="composer-inner">
            <div className="composer-hint" role="status">
              هذه العملية تتطلب صلاحية تحرير
            </div>
          </div>
        </div>
      ) : (
      <div className="composer">
        <div className="composer-inner">
          {pendingAttachments.length > 0 && (
            <div className="attachments-row">
              {pendingAttachments.map((a) => (
                <AttachChip
                  key={a.id}
                  attachment={a}
                  onOpen={() => setOpenAttachment(a)}
                  onRemove={() => removeAttachment(a.id)}
                />
              ))}
            </div>
          )}
          <div className="composer-box">
            <input
              ref={fileInput}
              type="file"
              hidden
              multiple
              accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp"
              onChange={(e) => {
                doUpload(e.target.files);
                e.target.value = '';
              }}
            />
            <button
              className="icon-btn"
              title="إرفاق ملف"
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
            >
              {uploading ? <span className="spinner" /> : <Icon.attachment size={ICON_MD} aria-hidden />}
            </button>
            <button
              className={`icon-btn ${internet ? 'on' : ''}`}
              title="البحث في الإنترنت"
              onClick={() => setInternet((v) => !v)}
            >
              <Icon.webSearch size={ICON_MD} aria-hidden />
            </button>
            <button
              className={`icon-btn ${recording ? 'on rec' : ''}`}
              title="إدخال صوتي (تفريغ عربي)"
              onClick={toggleRecording}
            >
              {recording ? <Icon.micStop size={ICON_MD} aria-hidden /> : <Icon.micStart size={ICON_MD} aria-hidden />}
            </button>
            <button className="icon-btn" title="بنك البنود" onClick={() => setClausePicker(true)}>
              <Icon.clauseBank size={ICON_MD} aria-hidden />
            </button>
            <button
              className={`icon-btn ${bilingual ? 'on' : ''}`}
              title="مخرَج ثنائي اللغة (عربي/إنجليزي)"
              onClick={() => setBilingual((v) => !v)}
            >
              ع/EN
            </button>
            <textarea
              ref={textarea}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                autoGrow();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="اكتب رسالتك… (Enter للإرسال، Shift+Enter لسطر جديد)"
              rows={1}
            />
            <button
              className="send-btn"
              onClick={() => send()}
              disabled={sending || attachmentsParsing || !input.trim()}
            >
              {sending ? <span className="spinner" /> : <Icon.send size={ICON_MD} aria-hidden />}
            </button>
          </div>
          <div className="composer-hint">
            {internet ? <><Icon.webSearch size={ICON_SM} aria-hidden /> البحث في الإنترنت مُفعَّل</> : 'يعتمد الرد على قاعدة المعرفة النظامية'}
          </div>
        </div>
      </div>
      )}

      {selection && (
        <SelectionToolbar
          anchor={selection.anchor}
          onCopy={copySelection}
          // التظليل يُسنَد إلى صفٍّ في القاعدة: ردٌّ يُبثّ الآن ليس صفّاً بعد.
          onHighlight={
            !readOnly && !selection.highlightId && persistedIds.has(selection.messageId)
              ? highlightSelection
              : undefined
          }
          onRemoveHighlight={!readOnly && selection.highlightId ? removeHighlight : undefined}
          onQuote={readOnly ? undefined : quoteSelection}
        />
      )}

      {source && <SourceModal citation={source} onClose={() => setSource(null)} />}

      {clausePicker && (
        <ClauseLibrary
          mode="pick"
          onClose={() => setClausePicker(false)}
          onPick={(cl) => {
            setInput((v) => `${v}${v ? '\n\n' : ''}أدرِج البند التالي بنصّه:\n\n${cl.body}`);
            setClausePicker(false);
          }}
        />
      )}

      {regRequest !== null && (
        <RegulationRequestModal
          initialName={regRequest}
          source="chat"
          conversationId={conversationId}
          onClose={() => setRegRequest(null)}
          onDone={() => setHandledRegs((h) => (h.includes(regRequest) ? h : [...h, regRequest]))}
        />
      )}

      {editing && (
        <DraftEditor
          messageId={editing.id}
          title={editing.title}
          onClose={() => setEditing(null)}
          onSaved={(content) =>
            setMessages((msgs) => msgs.map((m) => (m.id === editing.id ? { ...m, content } : m)))
          }
        />
      )}

      {openAttachment && (
        <AttachmentViewer attachment={openAttachment} onClose={() => setOpenAttachment(null)} />
      )}
    </>
  );
}

/**
 * شارةُ مرفق — في صندوق الكتابة قبل الإرسال، وفي فقاعة رسالته بعده.
 *
 * **وواحدةٌ للموضعين لا اثنتان.** الشارة نفسها تنتقل من الصندوق إلى الفقاعة
 * عند الإرسال، وشكلان لها يجعلان الانتقال يبدو استبدالاً — ملفٌّ اختفى وآخر
 * ظهر. والفرق بين الموضعين زرُّ الحذف وحده: يُعرض لما لم يُرسَل، ولا يُعرض
 * لما صار جزءاً من سجلّ المحادثة.
 *
 * **والشارة زرٌّ يفتح، لا وسمٌ يُقرأ.** بلا ذلك لا منفذ إلى الملف أصلاً:
 * يُرفع ويُرسَل ولا يراه صاحبُه ثانيةً.
 */
function AttachChip({
  attachment,
  onOpen,
  onRemove,
}: {
  attachment: Attachment;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  const parsing = attachment.parse_status === 'pending';
  const failed = attachment.parse_status === 'error';

  return (
    <span className={`attach-chip ${failed ? 'warn' : ''}`}>
      <button
        type="button"
        className="attach-open"
        onClick={onOpen}
        title={failed ? 'تعذّر استخراج النصّ من هذا الملف. يبقى مرفقاً يُفتح ويُنزَّل، ولا يبلغ نصُّه المساعد.' : undefined}
      >
        <Icon.attachment size={ICON_SM} aria-hidden />
        <bdi className="attach-name">{attachment.filename}</bdi>
      </button>

      {/* حالٌ واحدة تُقال في كل مرّة، ولا وسمَ على النجاح: شارةٌ بلا وسمٍ
          تعني أن نصّ الملف بلغ المساعد. */}
      {parsing && (
        <span className="attach-state" role="status">
          <span className="spinner" /> جارٍ استخراج النصّ
        </span>
      )}
      {failed && (
        <span className="attach-state warn">
          <Icon.failed size={ICON_SM} aria-hidden /> تعذّر استخراج النصّ
        </span>
      )}

      {onRemove && (
        <button type="button" className="attach-remove" onClick={onRemove} title="حذف المرفق" aria-label="حذف المرفق">
          <Icon.delete size={ICON_SM} aria-hidden />
        </button>
      )}
    </span>
  );
}
