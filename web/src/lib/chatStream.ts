/**
 * الدور الجاري — خارج الشاشة التي بدأته.
 *
 * كان البثّ يعيش داخل `ChatView`: حالتُه في `useState` واستدعاؤه في دالةٍ
 * تُغلق على تلك الحالة. والشاشة تُهدَم عند كل انتقال — `key={activeConv}` في
 * `App.tsx` يهدمها عند تبديل المحادثة، والعرضُ المشروط يهدمها عند فتح
 * الأدوات أو لوحة الإدارة — فيذهب معها كلُّ ما وصل: النصُّ المتراكم،
 * والمصادر، ونقاطُ الانتظار. فيقرأ المحامي أن خروجه من المحادثة أطفأ
 * النموذج.
 *
 * (والاتصال نفسه لم يكن ينقطع بالهدم: لا `AbortController` هنا ولا كان.
 * الذي كان يذهب هو من يستمع، والأثرُ واحد عند من يرى الشاشة.)
 *
 * وهذه الوحدة تُخرج الدور من الشاشة إلى الوحدة نفسها: خريطةٌ تعيش ما عاشت
 * الصفحة، تُكتب فيها الأحداث كما تصل، وتشترك فيها الشاشة متى رُكّبت. فتبديل
 * المحادثة أو الشاشة لا يمسّ الدور، والعودةُ إليه تُريه من حيث بلغ.
 *
 * وما وراء الصفحة — إغلاقُ التبويب وإعادةُ التحميل — يعالجه الخادم: التوليد
 * يجري في `waitUntil` والردّ يُحفظ على أي حال، وعلامةُ «دورٌ يجري» تقول
 * للعائد أن ينتظر. انظر `src/routes/chat.ts` و`src/lib/generating.ts`.
 */
import { streamChat, type Citation } from './api';

export interface ChatStream {
  conversationId: string;
  /**
   * نصُّ رسالة المستخدم التي بدأت الدور.
   *
   * تُقابَل به آخرُ رسالةٍ في القاعدة عند العودة: الخادم يحفظ رسالة المستخدم
   * قبل أن يبدأ التوليد، فمن عاد إلى المحادثة وجدها محفوظة — ولو أضافتها
   * الشاشة من هنا أيضاً لظهرت مرّتين.
   */
  userText: string;
  startedAt: number;
  /** معرّف فقاعة الردّ: محليٌّ يثبت طوال البثّ، ثم معرّف الخادم عند الحفظ. */
  messageId: string;
  text: string;
  citations?: Citation[];
  clarifying?: boolean;
  verification?: { verified: boolean; unsupported: string[]; note: string } | null;
  missingRegulations?: string[];
  /** البحث في المصادر جارٍ ولم تصل أوّل كلمة بعد. */
  searching: boolean;
  streaming: boolean;
  /** سببُ انقطاعٍ يُذيَّل به ما وصل — لا يمحوه. */
  error?: string;
  /** عنوان المحادثة إن صيغ في هذا الدور. */
  title?: string;
}

type Listener = (s: ChatStream | undefined) => void;

const streams = new Map<string, ChatStream>();
const listeners = new Map<string, Set<Listener>>();
/**
 * مستمعو دورة الحياة — البدء والعنوان والختام.
 *
 * منفصلون عن مستمعي المحادثة عمداً: `App` يحدّث الشريط الجانبي عندهم، ولو
 * نُبِّه مع كل مقطعٍ من النصّ لأعاد بناء الشريط عشرات المرّات في الدور الواحد.
 */
const activityListeners = new Set<() => void>();

function emit(conversationId: string) {
  const s = streams.get(conversationId);
  for (const l of listeners.get(conversationId) ?? []) l(s);
}

function emitActivity() {
  for (const l of activityListeners) l();
}

function patch(conversationId: string, change: Partial<ChatStream>) {
  const current = streams.get(conversationId);
  // دورٌ مُسح بينما كان حدثُه في الطريق: لا يُبعث من جديد.
  if (!current) return;
  streams.set(conversationId, { ...current, ...change });
  emit(conversationId);
}

/** الدور الجاري في محادثةٍ بعينها، أو آخرُ دورٍ لم يُمسح بعد. */
export function getChatStream(conversationId: string | null): ChatStream | undefined {
  return conversationId ? streams.get(conversationId) : undefined;
}

/* وأُسقطت هنا `isChatStreaming`: كانت تجيب عن محادثةٍ واحدة ولم يناديها
   أحد. ومن أراد الجواب يقرأ `getChatStream(id)?.streaming` — والمشتركون
   يقرؤونه أصلاً في الحالة التي تصلهم. */

/** المحادثات التي يجري فيها دورٌ الآن — للشريط الجانبي. */
export function streamingConversationIds(): string[] {
  return Array.from(streams.values())
    .filter((s) => s.streaming)
    .map((s) => s.conversationId);
}

export function subscribeChatStream(conversationId: string, listener: Listener): () => void {
  let set = listeners.get(conversationId);
  if (!set) {
    set = new Set();
    listeners.set(conversationId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (!set!.size) listeners.delete(conversationId);
  };
}

export function subscribeChatActivity(listener: () => void): () => void {
  activityListeners.add(listener);
  return () => activityListeners.delete(listener);
}

/**
 * يمسح دوراً من الخريطة.
 *
 * يُستدعى بعد أن تُعيد الشاشة جلب المحادثة من القاعدة: عندها يكون الردّ
 * صفّاً محفوظاً بمعرّفه وبياناته الوصفية، وإبقاؤه هنا يجعله يُرسم مرّتين.
 *
 * **والدور المنقطع لا يُمسح تلقائياً.** نصُّه لم يُحفظ في القاعدة — لا شيء
 * يُجلب مكانه — ومحوُه يُضيّع على المحامي ما وصل من مسوّدةٍ وسببَ انقطاعها
 * معاً. يبقى معروضاً إلى أن يُرسل في المحادثة دورٌ جديد.
 */
export function clearChatStream(conversationId: string): void {
  if (!streams.delete(conversationId)) return;
  emit(conversationId);
  emitActivity();
}

export interface StartChatOptions {
  conversationId: string;
  message: string;
  internet: boolean;
  bilingual: boolean;
  /** معرِّفات المرفقات المرسَلة مع هذا الدور — تُختم برسالته في الخادم. */
  attachmentIds?: string[];
}

/**
 * يبدأ دوراً ويسجّله. ولا يُنتظر: الشاشة تتابعه بالاشتراك لا بانتظار وعد،
 * فهي قد تُهدَم قبل أن ينتهي — وذلك بالضبط ما تحتمله هذه الوحدة.
 */
export function startChatStream(opts: StartChatOptions): void {
  const { conversationId, message } = opts;
  // دورٌ يجري في المحادثة نفسها: لا يُبدأ عليه ثانٍ. زرُّ الإرسال معطَّل
  // أثناءه، لكن الحدّ يُوضع هنا أيضاً — الشاشة قد تُركَّب من جديد وزرُّها معها.
  if (streams.get(conversationId)?.streaming) return;

  const startedAt = Date.now();
  streams.set(conversationId, {
    conversationId,
    userText: message,
    startedAt,
    messageId: `a${startedAt}`,
    text: '',
    searching: false,
    streaming: true,
  });
  emit(conversationId);
  emitActivity();

  void run(conversationId, opts);
}

async function run(conversationId: string, opts: StartChatOptions) {
  const started = streams.get(conversationId)!;
  /** وسمُ الدور. حدثٌ متأخّر يصل بعد مسحِ دورِه لا يُكتب على الدور الذي بعده. */
  const token = started.startedAt;
  const localId = started.messageId;
  let acc = '';
  let meta: any = {};
  let failed = false; // حتى لا يمحو حدث done رسالة الخطأ

  const set = (change: Partial<ChatStream>) => {
    if (streams.get(conversationId)?.startedAt !== token) return;
    patch(conversationId, change);
  };

  try {
    await streamChat(conversationId, {
      message: opts.message,
      forceInternet: opts.internet,
      bilingual: opts.bilingual,
      attachmentIds: opts.attachmentIds,
    }, {
      onMeta: (m) => {
        meta = m;
      },
      onSearch: () => set({ searching: true }),
      onVerify: (v) => set({ verification: v }),
      onRegulations: (missing) => set({ missingRegulations: missing }),
      onTitle: (t) => {
        set({ title: t });
        emitActivity(); // القائمة الجانبية تحمل العنوان أيضاً
      },
      onDelta: (t) => {
        acc += t;
        set({
          text: acc,
          searching: false,
          streaming: true,
          citations: meta.citations,
          clarifying: meta.clarifying,
        });
      },
      onDone: () => {
        if (failed) return; // أُبلِغ الخطأ سابقاً
        set({
          messageId: meta.messageId ?? localId,
          text: acc,
          streaming: false,
          searching: false,
          citations: meta.citations,
          clarifying: meta.clarifying,
        });
      },
      onError: (err) => {
        failed = true;
        /* ردٌّ انقطع في منتصفه يبقى معروضاً ويُذيَّل بسببه: محوُه يُضيّع على
           المحامي ما وصل، وهو مسوّدة عملٍ لا سطرَ حالة. */
        set({ text: acc, error: err, streaming: false, searching: false });
      },
    });
  } catch {
    // انقطاعٌ قبل أن يصل أي حدث — لا يُترك القارئ أمام فقاعةٍ تنبض بلا نهاية.
    failed = true;
    set({
      text: acc,
      error: acc ? undefined : 'تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة',
      streaming: false,
      searching: false,
    });
  } finally {
    /* الصندوق يُفتح مهما كان المآل: أيُّ انقطاعٍ قبل `done` — شبكةٌ تسقط، أو
       جلسةٌ تنتهي فيُحوَّل الطلب — كان يترك `streaming` مرفوعاً إلى الأبد،
       فيبقى زرّ الإرسال معطَّلاً ولا سبيل إلى الكتابة إلا بإعادة التحميل. */
    const current = streams.get(conversationId);
    if (current?.startedAt === token && current.streaming) {
      patch(conversationId, { streaming: false, searching: false });
    }
    emitActivity();
  }
}
