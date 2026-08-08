// عميل API للواجهة

/** أدوار هذه المنصة، وألفاظها في naf-terms.md §١٠. لا رابع لها. */
export type PlatformRole = 'admin' | 'editor' | 'viewer';

/**
 * الألفاظ المسجَّلة للأدوار. مصدرها واحد هنا لا في كل شاشة تعرض دوراً:
 * لفظان لمعنى واحد هما الانحراف الذي يمنعه السجلّ.
 *
 * `admin` و `viewer` من naf-terms.md §٢ «تسميات الحقول والأعمدة»، و«مدير»
 * ممنوعة هناك صراحةً للـ Administrator. و`editor` من §١٠، وهو الوحيد الذي
 * لم يكن له مقابل مسجَّل قبل أدوار الدخول الموحّد.
 */
export const ROLE_LABELS: Record<PlatformRole, string> = {
  admin: 'مسؤول',
  editor: 'محرّر',
  viewer: 'مستخدم (اطّلاع)',
};

export interface User {
  id: string;
  email: string;
  role: PlatformRole;
  name?: string;
  must_change_password?: boolean;
}

/** عضو في هذه المنصة — سجلّه المحلي مقابلَ هويته في المركز. */
export interface Member {
  user_id: string;
  display_name: string | null;
  email: string | null;
  role: PlatformRole;
  is_active: boolean;
  last_seen_at: number | null;
  created_at: number | null;
  /** صفّ القارئ نفسه: لا يعطّل نفسه ولا يغيّر صلاحيته. */
  is_self: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  consultation_type: string | null;
  folder_id?: string | null;
  created_at: number;
  updated_at: number;
}

export interface Folder {
  id: string;
  name: string;
  color: string;
  count: number;
}

export type FieldType = 'text' | 'number' | 'textarea';
export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
}
export interface FileRequest {
  enabled: boolean;
  label: string;
  required: boolean;
  allow_text: boolean;
}
export interface ConsultConfig {
  key: string;
  label: string;
  system_prompt?: string;
  file: FileRequest;
  fields: FieldDef[];
}

// طلب إضافة نظام غير موجود في قاعدة المعرفة
export type RegulationRequestStatus = 'pending' | 'approved' | 'rejected';

export interface RegulationRequestInput {
  name: string;
  url?: string;
  has_bylaw: boolean;
  bylaw_url?: string;
  note?: string;
  source: 'chat' | 'support';
  conversation_id?: string | null;
}

export interface RegulationRequest {
  id: string;
  name: string;
  url: string | null;
  has_bylaw: number;
  bylaw_url: string | null;
  note: string | null;
  source: 'chat' | 'support';
  status: RegulationRequestStatus;
  admin_note: string | null;
  created_at: number;
  handled_at: number | null;
  requester_email?: string;
  requester_name?: string | null;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata_json?: string;
  created_at: number;
}

/**
 * قالب المستند — الخط والأحجام ونطاق الكتابة.
 *
 * مصدرٌ واحد لقالبَي Word والطباعة معاً: ما يُصدَّر وما يُطبع مستندٌ واحد.
 * والقيم تُضبط داخل حدودها في الخادم، فما يصل هنا صالحٌ للاستعمال كما هو.
 */
export interface DocTemplate {
  fontFamily: string;
  headingPt: number;
  bodyPt: number;
  marginTopMm: number;
  marginBottomMm: number;
  marginSideMm: number;
}

export interface Attachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
  created_at: number;
}

/* ============================================================
   شكل الردّ يتبع طبيعة الطلب — والفرعان كلاهما لازم.

   منذ `naf-auth@v3.0.0` يفرّق الوسيط بين تصفّحٍ ونداءٍ برمجي بطبيعة الطلب،
   فنداء `fetch` بلا جلسة يأخذ 401 ومعه `login`، والعضو الموقوف يأخذ 403
   ومعه `denied`. وبدون قراءة الفرعين هنا:

     انتهاء الرمز  → خطأ شبكة مبهم (الرمز يعيش ربع ساعة، فهذا يقع كثيراً)
     إيقاف العضو   → شاشة خاوية بلا سبب

   ولا يُكتفى بإعادة تحميل الصفحة عند 401: التحميل يعيد الطلب على الوسيط
   تنقّلَ متصفحٍ فيحوّل — لكنه يفقد ما كان القارئ يفعله، ويدور بلا نهاية إن
   كان سبب الردّ رفضاً لا انتهاء جلسة.
   ============================================================ */

/**
 * وجهة العودة تُصحَّح من موضع المتصفّح.
 *
 * الوسيط يبني `next` من مسار الطلب — وهو مسار برمجي (`/api/auth/me` مثلاً).
 * فالعودة بعده تضع القارئ أمام ردّ JSON خام. والمتصفّح وحده يعرف موضعه
 * الحقيقي، فمنه تُؤخذ الوجهة.
 *
 * ومسار الرفض يُستثنى: وضعُه وجهةً يعيد القارئ إلى الرفض بعد الدخول، فتدور
 * الحلقة ولا تُقرأ الرسالة أصلاً.
 */
function withCurrentNext(login: string): string {
  try {
    const url = new URL(login, window.location.origin);
    if (window.location.pathname === '/denied') url.searchParams.delete('next');
    else url.searchParams.set('next', window.location.pathname + window.location.search);
    return url.toString();
  } catch {
    return login;
  }
}

/**
 * يقرأ فرعَي المنع. يعيد `true` إن بدأ تحويل — وعندها لا يُكمل النداء ولا
 * يُظهر خطأً: الصفحة على وشك أن تُغادر، ورسالةُ خطأ تومض قبلها ضجيج.
 */
function handleAuthRedirect(res: Response, data: unknown): boolean {
  const body = (data ?? {}) as { login?: string; denied?: string };

  if (res.status === 401 && body.login) {
    window.location.href = withCurrentNext(body.login);
    return true;
  }
  if (res.status === 403 && body.denied) {
    window.location.href = body.denied;
    return true;
  }
  return false;
}

/** وعدٌ لا يُحلّ: التحويل جارٍ، فلا نتيجة بعده ولا خطأ. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/** حالة المحتوى النظامي المستورد. */
export interface LegalStats {
  chunks: number;
  effective: number;
  repealed: number;
  laws: number;
  pending_embeddings: number;
  vectorize: boolean;
  /** محجوبٌ عن الاسترجاع حتى يعتمده إنسان. */
  needs_review: number;
  /** مادةٌ عُدِّلت ونصُّها المعروض أصليّ — تُعرض مع تنبيهها. */
  amendment_pending: number;
}

/** نتيجة البحث في المنصة، مقسّمةً بمواضعها. */
export interface PlatformSearch {
  chats: {
    conversation_id: string;
    title: string | null;
    message_id: string;
    role: string;
    created_at: number;
    snippet: string;
  }[];
  outputs: {
    id: string;
    message_id: string;
    version: number;
    note: string | null;
    created_at: number;
    conversation_id: string;
    title: string | null;
    snippet: string;
  }[];
  kb: {
    articles: LegalArticle[];
    documents: { id: string; title: string; category: string | null; source_authority: string | null; status: string }[];
  };
  mode: string;
}

/** نظامٌ مستورد وحالُ مواده. */
export interface LegalLaw {
  law_id: string;
  law_title: string | null;
  parent_law_id: string | null;
  doc_type: string | null;
  /** نوع أداة الإصدار: مرسوم ملكي، قرار مجلس الوزراء… */
  instrument: string | null;
  instrument_no: string | null;
  /** الجهة صاحبة النظام. */
  authority: string | null;
  issue_date: string | null;
  issue_date_hijri: string | null;
  source_url: string | null;
  chunks: number;
  effective: number;
  repealed: number;
}

/** مادةٌ كما تُعرض — `text` وحده، ولا أثر لـ`embed_text`. */
export interface LegalArticle {
  id: string;
  /** حالُ الاسترجاع: `effective` · `effective_warning` · `repealed`. */
  retrievalStatus?: string;
  /** نصّ التحذير جاهزاً — يأتي من طبقة الاسترجاع لا يُركَّب في الشاشة. */
  retrievalWarning?: string | null;
  hasDefect?: boolean;
  defectKind?: string | null;
  lawId: string | null;
  articleNo: string | null;
  /** «المادة الخامسة والأربعون» — كما تُكتب في النظام. */
  articleLabel: string | null;
  /** عنوان المادة إن وُجد: «التعريفات». */
  articleTitle: string | null;
  book: string | null;
  chapter: string | null;
  section: string | null;
  lawTitle: string | null;
  instrument: string | null;
  instrumentNo: string | null;
  authority: string | null;
  status: string;
  isRepealed: boolean;
  issueDate: string | null;
  issueDateHijri: string | null;
  effectiveFrom: string | null;
  effectiveFromHijri: string | null;
  /** نفاذٌ مؤجَّل: تاريخ النفاذ لم يحلّ بعد، فالنصّ سابقٌ لأوانه. */
  effectivePending: boolean;
  sourceUrl: string | null;
  text: string;
  /** جزء المادة المقسّمة — أجزاءُ مادةٍ واحدة لا موادّ. */
  part: string | null;
  partsTotal: number | null;
  isDuplicate: boolean;
  duplicateOf: string | null;
  duplicateIndex: number | null;
  hasAmendments: boolean;
  amendmentKind: string | null;
  /** هل النصّ المعروض نافذ؟ `false` يعني أنه الأصلي رغم وجود تعديل. */
  amendmentApplied: boolean;
  needsReview: boolean;
  reviewedAt: number | null;
  /** `pending` · `approved` · `edited` · `rejected` · `deferred`. */
  reviewStatus: string;
  reviewNote: string | null;
  /** حُرِّر نصُّها، فأصلُ الاستيراد محفوظ ويمكن الرجوع إليه. */
  wasEdited: boolean;
  amendmentInstrument: string | null;
  amendedOn: string | null;
  amendmentsCount: number | null;
  amendNote: string | null;
}

/** قرار المراجع على مادة. */
export type ReviewAction = 'approve' | 'edit' | 'exclude' | 'defer' | 'note' | 'undo';

/** مرشّحات الطابور: نظامٌ واحد، أو دفعة استيراد، أو نوع. */
export interface ReviewFilters {
  queue?: string | null;
  lawId?: string | null;
  capturedAt?: string | null;
  docType?: string | null;
}

function reviewQuery(f: ReviewFilters, offset?: number, limit?: number): string {
  const p = new URLSearchParams();
  if (f.queue) p.set('queue', f.queue);
  if (f.lawId) p.set('law_id', f.lawId);
  if (f.capturedAt) p.set('captured_at', f.capturedAt);
  if (f.docType) p.set('doc_type', f.docType);
  if (offset !== undefined) p.set('offset', String(offset));
  if (limit !== undefined) p.set('limit', String(limit));
  return p.toString();
}

/**
 * سقف المعرّفات في نداء الاعتماد الجملي الواحد.
 *
 * يقابل `BULK_LIMIT` في `src/lib/legal.ts`، وهو مكتوبٌ هنا ليقسّم المرسِل
 * تحديداً أكبر منه على دفعات قبل أن يرسل. واختلافُه عن سقف الخادم لا يمرّ
 * صامتاً: الخادم يردّ الزائد في `failed` بمعرّفه، ويردّ سقفه في `limit`.
 */
export const REVIEW_BULK_LIMIT = 50;

/** عدّاد طابورٍ واحد: المنجز من الإجمالي. */
export interface QueueCount {
  key: string;
  pending: number;
  done: number;
}

/** لوحة حال المراجعة. */
export interface ReviewDashboard {
  chunks: number;
  retrievable: number;
  in_queue: number;
  approved: number;
  edited: number;
  rejected: number;
  deferred: number;
  repealed: number;
  last_activity: number | null;
  queues: QueueCount[];
}

/** قيدٌ في سجلّ التدقيق: الحقل، وقيمتاه، وصاحبه، ووقته. */
export interface ReviewAuditEntry {
  id: string;
  chunk_id: string;
  law_id: string | null;
  field: string;
  old_value: string | null;
  new_value: string | null;
  actor_id: string | null;
  at: number;
  /** `single` قرارٌ فُتحت له المادة · `bulk` اعتُمدت ضمن محدَّدٍ جملةً. */
  via: string | null;
}

/** نافذة التعديلات الخام — تُقرأ بطلبٍ صريح ولا تأتي مع نتائج البحث. */
/** نسخةٌ في الخطّ الزمني — أوّلها الأصل وآخرها المعتمد. */
export interface TextVersion {
  seq: number;
  text: string;
  label: string | null;
  from_instrument: string | null;
  from_date: string | null;
  current: boolean;
}

/** حدثُ تعديلٍ مفكَّك: ما فُعل، وهل وقع، ولمَ لم يقع. */
export interface AmendmentEvent {
  seq: number;
  scope: string | null;
  op: string | null;
  targets: string[];
  instrument: string | null;
  instrument_no: string | null;
  date_hijri: string | null;
  effective_from: string | null;
  new_text: string | null;
  applied: boolean;
  text_after: string | null;
  result: string | null;
  reason: string | null;
  raw: string | null;
}

export interface LegalAmendment {
  id: string;
  amendment_kind: string | null;
  amendment_applied: number;
  amendment_instrument: string | null;
  amended_on: string | null;
  amendments_count: number | null;
  amendments_raw: string | null;
  amend_note: string | null;
  text_superseded: string | null;
  source_url: string | null;
  versions: TextVersion[];
  events: AmendmentEvent[];
}

/** مادةٌ تغيّر فيها شيء — القديم والجديد جنباً إلى جنب. */
export interface LegalChunkChange {
  id: string;
  fields: string[];
  old_article_no: string | null;
  new_article_no: string | null;
  old_status: string;
  new_status: string;
  old_text: string;
  new_text: string;
}

/** فرقُ ملفٍ عن القاعدة قبل أن يُكتب منه شيء. */
export interface LegalImportDiff {
  added: number;
  changed: number;
  unchanged: number;
  missing: number;
  missing_ids: string[];
  changes: LegalChunkChange[];
  changes_truncated: number;
  law_ids: string[];
}

/** نسخةٌ أُزيحت من مادة، ومعها الجاري اليوم. */
export interface LegalChunkVersion {
  id: string;
  chunk_id: string;
  article_no: string | null;
  status: string;
  text: string;
  changed_fields: string;
  archived_at: number;
  /** تاريخ التعديل الهجري كما ورد — لا وقتُ اكتشافنا له. */
  amended_on: string | null;
  amendment_instrument: string | null;
  /** `amendment` تعديلٌ نظاميّ · `correction` تصحيحُ خطأٍ في سحبٍ سابق. */
  change_kind: string | null;
  origin: string | null;
  current_text: string | null;
  current_article_no: string | null;
}

/** دفعة استيراد كما سُجّلت. */
export interface LegalImportRecord {
  id: string;
  filename: string | null;
  lines: number;
  inserted: number;
  updated: number;
  failed: number;
  created_at: number;
  /** `correction` دفعةُ تصحيح بيانات · `import` استيرادٌ عاديّ. */
  kind: string | null;
}

/** سطرٌ رُفض، برقمه في الملف وسببه. */
export interface LegalLineError {
  line: number;
  code: string;
  error: string;
  id?: string;
  keys?: string[];
}

/** سببٌ واحد مجموعاً على الملف كلّه — لا على المعروض من أسطره. */
export interface LegalErrorGroup {
  code: string;
  error: string;
  count: number;
  lines: number[];
  keys?: string[];
}

/** تقرير دفعة استيراد — كما يردّه `/api/legal/import`. */
export interface LegalImportReport {
  ok: boolean;
  written?: boolean;
  lines?: number;
  accepted?: number;
  inserted?: number;
  updated?: number;
  failed?: number;
  error_summary?: LegalErrorGroup[];
  errors?: LegalLineError[];
  errors_truncated?: number;
  warnings?: string[];
  /** مواد أُرشِفت نسخُها القديمة قبل الكتابة فوقها. */
  archived?: number;
  /** نسخٌ دخلت سجلّ التحديث من `text_superseded` بتاريخ تعديلها. */
  superseded?: number;
  /** المقارنة: يُملأ في وضع `dry_run` وحده. */
  diff?: LegalImportDiff;
  embed_text_truncated?: number;
  embed_text_built?: number;
  /** موادّ ستُحجب عن الاسترجاع حتى تُراجَع. */
  needs_review?: number;
  /** موادّ عُدِّلت ونصُّها المعروض أصليّ. */
  amendment_pending?: number;
  pending_embeddings?: number;
  error?: string;
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (handleAuthRedirect(res, data)) return pending<T>();
  if (!res.ok) throw new Error((data as any).error ?? 'خطأ في الاتصال');
  return data as T;
}

export const api = {
  // المصادقة
  me: () => req<{ user: User }>('/auth/me'),
  login: (email: string, password: string) =>
    req<{ user: User }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: (email: string, password: string, name: string) =>
    req<{ user: User }>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, name }) }),
  // الخروج تنقّلُ متصفحٍ لا نداءُ `fetch`: يحذف الجلسة من KV ويُسقط الكوكي
  // ثم يحوّل — وثلاثتها تحتاج استجابةً يتّبعها المتصفح نفسه.
  //
  // والتحويلة تقصد المركز لا جذر هذه المنصة. والجذر كان يعيد الخارجَ إلى
  // شاشته في الحال: هو محميّ، فيحوّله الوسيط إلى المركز، وجلسة المركز لم
  // تُمسّ فتُصدر رمزاً جديداً. فيقرأ المستخدم أن الزرّ لا يعمل.
  //
  // و`POST` بنموذجٍ لا `location.href`: رابطٌ يُخرج صاحبَه بمجرّد فتحه تكفي
  // صورةٌ في صفحةٍ أجنبية لتشغيله — `<img src="…/auth/logout">` يُخرج قارئَها
  // من المنصة بلا علمه. والتنقّل يبقى تنقّلاً، فالردّ ٣٠٢ يتّبعه المتصفح كما
  // كان. وهو ما تفعله `naf-marketing` و`NAF-Accountant` أصلاً.
  logout: async () => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/auth/logout';
    document.body.appendChild(form);
    form.submit();
  },

  // الأعضاء والصلاحيات — لمدير المنصة
  members: () => req<{ members: Member[] }>('/members'),
  setMemberRole: (id: string, role: PlatformRole) =>
    req(`/members/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  setMemberActive: (id: string, is_active: boolean, reason?: string) =>
    req<{ ok: true; reported: boolean }>(`/members/${id}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active, reason }),
    }),
  changePassword: (new_password: string, current_password?: string) =>
    req('/auth/change-password', { method: 'POST', body: JSON.stringify({ new_password, current_password }) }),

  // المحادثات
  listConversations: (q?: string, folder?: string) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (folder) params.set('folder', folder);
    const qs = params.toString();
    return req<{ conversations: Conversation[] }>(`/conversations${qs ? `?${qs}` : ''}`);
  },
  createConversation: (consultation_type: string) =>
    req<Conversation>('/conversations', { method: 'POST', body: JSON.stringify({ consultation_type }) }),
  getConversation: (id: string) =>
    req<{ conversation: Conversation; messages: Message[]; attachments: Attachment[] }>(`/conversations/${id}`),
  renameConversation: (id: string, title: string) =>
    req(`/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteConversation: (id: string) => req(`/conversations/${id}`, { method: 'DELETE' }),

  // الملفات
  uploadFile: async (conversationId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`/api/files/upload/${conversationId}`, { method: 'POST', body: fd, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (handleAuthRedirect(res, data)) return pending<any>();
    if (!res.ok) throw new Error((data as any).error ?? 'فشل الرفع');
    return data;
  },
  exportUrl: (messageId: string, format: 'docx' | 'txt') => `/api/files/export/${messageId}?format=${format}`,
  /** قالب المستند وهل رُفعت رأسية — تقرأهما نافذة الطباعة قبل أن تبني الصفحة. */
  docTemplate: () => req<{ template: DocTemplate; letterhead: boolean }>('/files/doc-template'),
  /** صورة الرأسية كما رُفعت — متجهةً إن كانت متجهة. */
  letterheadUrl: () => '/api/files/letterhead',

  // الإدارة
  kbDocuments: () => req<{ documents: any[] }>('/kb/documents'),
  deleteKbDocument: (id: string) => req(`/kb/documents/${id}`, { method: 'DELETE' }),
  reingestKbDocument: (id: string) => req(`/kb/documents/${id}/reingest`, { method: 'POST' }),
  kbVersions: (id: string) => req<{ versions: any[] }>(`/kb/documents/${id}/versions`),
  kbTextUrl: (id: string) => `/api/kb/documents/${id}/text`,
  kbFileUrl: (id: string) => `/api/kb/documents/${id}/file`,
  kbVersionTextUrl: (id: string, vid: string) => `/api/kb/documents/${id}/versions/${vid}/text`,
  kbVersionFileUrl: (id: string, vid: string) => `/api/kb/documents/${id}/versions/${vid}/file`,
  // المحتوى النظامي المستورد — عقد الاستيراد في docs/legal-import.md
  legalStats: () => req<LegalStats>('/legal/stats'),
  legalLaws: () => req<{ laws: LegalLaw[] }>('/legal/laws'),
  /** بحث المسؤول في المحتوى النظامي — لفظيّ بلا نموذج تضمين. */
  legalSearch: (q: string, limit = 20) =>
    req<{ results: LegalArticle[]; count: number }>(
      `/legal/search?q=${encodeURIComponent(q)}&limit=${limit}&lexical=1`
    ),
  legalLaw: (lawId: string) =>
    req<{ law: LegalLaw; regulations: LegalLaw[] }>(`/legal/laws/${encodeURIComponent(lawId)}`),
  legalLawArticles: (lawId: string, offset = 0, limit = 25) =>
    req<{ articles: LegalArticle[]; total: number }>(
      `/legal/laws/${encodeURIComponent(lawId)}/articles?offset=${offset}&limit=${limit}`
    ),
  legalLawChanges: (lawId: string, offset = 0, limit = 25) =>
    req<{ changes: LegalChunkVersion[]; total: number }>(
      `/legal/laws/${encodeURIComponent(lawId)}/changes?offset=${offset}&limit=${limit}`
    ),
  legalImports: () => req<{ imports: LegalImportRecord[] }>('/legal/imports'),
  /** ما ينتظر المراجعة — هذا المسار وحده يراه، والبحث لا يصله. */
  legalReviewQueue: (filters: ReviewFilters = {}, offset = 0, limit = 25) =>
    req<{ articles: LegalArticle[]; total: number }>(`/legal/review?${reviewQuery(filters, offset, limit)}`),
  /** لوحة الحال وعدّادات الطوابير — استعلامٌ حيّ عند كل فتح. */
  legalReviewDashboard: (filters: ReviewFilters = {}) =>
    req<ReviewDashboard>(`/legal/review/dashboard?${reviewQuery(filters)}`),
  /** دفعات الاستيراد المتاحة للترشيح. */
  legalCaptureBatches: () =>
    req<{ batches: { captured_at: string; chunks: number }[] }>('/legal/review/batches'),
  /** سجلّ التدقيق: لمادةٍ بعينها أو لآخر ما وقع. */
  legalReviewAudit: (chunkId?: string | null, limit = 50) =>
    req<{ entries: ReviewAuditEntry[] }>(
      `/legal/review/audit?limit=${limit}${chunkId ? `&chunk_id=${encodeURIComponent(chunkId)}` : ''}`
    ),
  /**
   * معرّفات الطابور كلِّه — لتحديدٍ يشمله لا يشمل صفحته.
   *
   * تُجلب لتعود صريحةً إلى مسار القرار: العدد الذي يراه المراجع قبل التأكيد
   * هو العدد الذي يقع عليه القرار، وكلُّ اعتماد يبقى مقيَّداً وحده.
   */
  legalReviewQueueIds: (filters: ReviewFilters = {}) =>
    req<{ ids: string[]; total: number; truncated: number }>(`/legal/review/ids?${reviewQuery(filters)}`),
  /**
   * قرارٌ واحد على موادّ محدَّدة بأعيانها.
   *
   * بمعرّفاتها لا بشرط: كلُّ معرّفٍ يمرّ صريحاً، فيبقى القرار مقيَّداً وحده.
   * وما زاد على {@link REVIEW_BULK_LIMIT} في النداء الواحد يعود في `failed`،
   * فالمرسِل يقسّم على السقف ولا يعتمد على قصٍّ في الطرف الآخر.
   */
  legalReviewSelected: (ids: string[], action: Exclude<ReviewAction, 'edit'>, note?: string) =>
    req<{ ok: true; done: number; failed: { id: string; error: string }[]; limit: number }>(
      '/legal/review-selected',
      { method: 'POST', body: JSON.stringify({ ids, action, note }) }
    ),
  /** قرار المراجع: اعتماد · تحرير واعتماد · استبعاد · تأجيل · ملاحظة · تراجع. */
  legalReview: (id: string, action: ReviewAction, body: { text?: string; note?: string } = {}) =>
    req<{ ok: true; id: string; status: string; reembedded: boolean }>(
      `/legal/review/${encodeURIComponent(id)}`,
      { method: 'POST', body: JSON.stringify({ action, ...body }) }
    ),
  /** نافذة التعديلات الخام — تُطلب عند فتحها لا مع كل نتيجة. */
  legalAmendment: (id: string) =>
    req<{ amendment: LegalAmendment }>(`/legal/articles/${encodeURIComponent(id)}/amendment`),
  legalEmbedPending: (limit = 1000) =>
    req<{ embedded: number; remaining: number; skipped?: string }>(`/legal/embed-pending?limit=${limit}`, {
      method: 'POST',
    }),
  /**
   * يستورد دفعة أسطر JSONL.
   *
   * لا يرمي عند الرفض: تقرير الدفعة المرفوضة هو المطلوب عرضُه — أرقام
   * الأسطر وأسبابها — ورميُ رسالةٍ واحدة يضيّعه.
   */
  importLegal: async (
    lines: string[],
    filename: string,
    opts: { buildEmbed?: boolean; partial?: boolean; dryRun?: boolean; correction?: boolean } = {}
  ): Promise<LegalImportReport> => {
    const query = new URLSearchParams({
      filename,
      ...(opts.buildEmbed ? { build_embed_text: '1' } : {}),
      ...(opts.partial ? { partial: '1' } : {}),
      ...(opts.dryRun ? { dry_run: '1' } : {}),
      ...(opts.correction ? { correction: '1' } : {}),
    });
    const res = await fetch(`/api/legal/import?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: lines.join('\n'),
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (handleAuthRedirect(res, data)) return pending<LegalImportReport>();
    return { ...(data as LegalImportReport), ok: res.ok };
  },

  tracking: () => req<{ needs_update: any[] }>('/admin/tracking'),
  resolveTracking: (id: string) => req(`/admin/tracking/${id}/resolve`, { method: 'POST' }),
  scanTracking: () => req<{ checked: number; flagged: number }>('/admin/tracking/scan', { method: 'POST' }),
  users: () => req<{ users: User[] }>('/admin/users'),
  createUser: (email: string, role: string, name?: string) =>
    req<{ user: User; default_password: string }>('/admin/users', { method: 'POST', body: JSON.stringify({ email, role, name }) }),
  resetPassword: (id: string) =>
    req<{ default_password: string }>(`/admin/users/${id}/reset-password`, { method: 'POST' }),
  deleteUser: (id: string) => req(`/admin/users/${id}`, { method: 'DELETE' }),
  setRole: (id: string, role: string) =>
    req(`/admin/users/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  audit: () => req<{ entries: any[] }>('/admin/audit'),
  aiCheck: () => req<{ ok: boolean; model: string; dimensions?: number; ms?: number; error?: string }>('/admin/ai-check'),
  /** فحص Claude — يردّ ٢٠٠ ولو فشل، فالتقرير هو المطلوب لا رمز الخطأ. */
  claudeCheck: () =>
    req<{
      ok: boolean;
      checks: { model: string; ok: boolean; ms: number; served_by?: string; sample?: string; error?: string }[];
    }>('/admin/claude-check'),
  analytics: () => req<any>('/admin/analytics'),
  settings: () => req<{ settings: Record<string, string> }>('/admin/settings'),
  saveSettings: (s: Record<string, string>) => req('/admin/settings', { method: 'POST', body: JSON.stringify(s) }),
  news: () => req<{ news: any[] }>('/admin/news'),
  scanNews: () => req<{ found: number }>('/admin/news/scan', { method: 'POST' }),
  ingestNews: (id: string) => req(`/admin/news/${id}/ingest`, { method: 'POST' }),

  // طلبات إضافة الأنظمة
  regulationRequests: () => req<{ requests: RegulationRequest[] }>('/regulation-requests'),
  createRegulationRequest: (payload: RegulationRequestInput) =>
    req<{ id: string; duplicate: boolean }>('/regulation-requests', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  adminRegulationRequests: (status = 'all') =>
    req<{ requests: RegulationRequest[]; pending: number }>(`/admin/regulation-requests?status=${status}`),
  decideRegulationRequest: (id: string, status: RegulationRequestStatus, admin_note?: string) =>
    req(`/admin/regulation-requests/${id}`, { method: 'PATCH', body: JSON.stringify({ status, admin_note }) }),

  // التقييم
  getFeedback: (messageId: string) => req<{ feedback: { rating: number; comment?: string } | null }>(`/feedback/${messageId}`),
  sendFeedback: (messageId: string, rating: number, comment?: string) =>
    req(`/feedback/${messageId}`, { method: 'POST', body: JSON.stringify({ rating, comment }) }),

  // القضايا والوسوم
  folders: () => req<{ folders: Folder[] }>('/folders'),
  createFolder: (name: string) => req<Folder>('/folders', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteFolder: (id: string) => req(`/folders/${id}`, { method: 'DELETE' }),
  assignFolder: (conversation_id: string, folder_id: string | null) =>
    req('/folders/assign', { method: 'POST', body: JSON.stringify({ conversation_id, folder_id }) }),

  // المشاركة للمراجعة
  createShare: (message_id: string, reviewer_label?: string) =>
    req<{ token: string; url: string }>('/shares', { method: 'POST', body: JSON.stringify({ message_id, reviewer_label }) }),
  listShares: () => req<{ shares: any[] }>('/shares'),
  deleteShare: (id: string) => req(`/shares/${id}`, { method: 'DELETE' }),

  // البحث الدلالي
  /**
   * البحث في المنصة — لفظيٌّ بلا ذكاء اصطناعي.
   *
   * `scope` يحصره في موضع: `chats` أو `outputs` أو `kb`، و`all` يعمّها.
   */
  search: (q: string, scope: 'all' | 'chats' | 'outputs' | 'kb' = 'all') =>
    req<PlatformSearch>(`/search?q=${encodeURIComponent(q)}&scope=${scope}`),

  // بنك البنود
  clauses: (q?: string) => req<{ clauses: any[] }>(`/clauses${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  createClause: (payload: any) => req<any>('/clauses', { method: 'POST', body: JSON.stringify(payload) }),
  updateClause: (id: string, payload: any) => req(`/clauses/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteClause: (id: string) => req(`/clauses/${id}`, { method: 'DELETE' }),

  // ملف القضية
  caseFile: (folderId: string) => req<any>(`/cases/${folderId}`),
  caseExportUrl: (folderId: string) => `/api/cases/${folderId}/export`,

  // المواعيد النظامية
  deadlinesList: (status = 'open') => req<{ deadlines: any[] }>(`/deadlines?status=${status}`),
  createDeadline: (payload: any) => req<any>('/deadlines', { method: 'POST', body: JSON.stringify(payload) }),
  setDeadlineStatus: (id: string, status: string) =>
    req(`/deadlines/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  deleteDeadline: (id: string) => req(`/deadlines/${id}`, { method: 'DELETE' }),

  // الإشعارات
  notifications: () => req<{ notifications: any[]; unread: number }>('/notifications'),
  markNotificationsRead: (id?: string) => req('/notifications/read', { method: 'POST', body: JSON.stringify({ id }) }),

  // المسوّدات: النُسخ والتحرير والاعتماد
  draftVersions: (messageId: string) =>
    req<{ current: string; versions: any[]; approval: any | null }>(`/drafts/${messageId}/versions`),
  saveDraft: (messageId: string, content: string, note?: string) =>
    req<{ version: number }>(`/drafts/${messageId}`, { method: 'POST', body: JSON.stringify({ content, note }) }),
  draftAlternative: (messageId: string, instruction?: string) =>
    req<{ content: string }>(`/drafts/${messageId}/alternative`, { method: 'POST', body: JSON.stringify({ instruction }) }),
  proofread: (text: string) => req<{ result: string }>('/tools/proofread', { method: 'POST', body: JSON.stringify({ text }) }),
  restoreDraft: (messageId: string, versionId: string) =>
    req<{ content: string }>(`/drafts/${messageId}/restore/${versionId}`, { method: 'POST' }),
  approveDraft: (messageId: string, note?: string) =>
    req(`/drafts/${messageId}/approve`, { method: 'POST', body: JSON.stringify({ note }) }),
  unapproveDraft: (messageId: string) => req(`/drafts/${messageId}/approve`, { method: 'DELETE' }),

  // إعداد نماذج الاستشارات
  consultationConfigs: () => req<{ configs: ConsultConfig[] }>('/consultations/configs'),
  adminConsultationConfigs: () => req<{ configs: ConsultConfig[] }>('/admin/consultation-configs'),
  saveConsultationConfig: (key: string, config: ConsultConfig) =>
    req<{ config: ConsultConfig }>(`/admin/consultation-configs/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify(config) }),
  resetConsultationConfig: (key: string) =>
    req<{ config: ConsultConfig }>(`/admin/consultation-configs/${encodeURIComponent(key)}`, { method: 'DELETE' }),

  // الأدوات القانونية
  compare: (text_a: string, text_b: string) =>
    req<{ result: string }>('/tools/compare', { method: 'POST', body: JSON.stringify({ text_a, text_b }) }),
  deadlines: (payload: any) => req<{ result: string }>('/tools/deadlines', { method: 'POST', body: JSON.stringify(payload) }),
  transcribe: async (blob: Blob) => {
    const res = await fetch('/api/tools/transcribe', { method: 'POST', body: blob, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (handleAuthRedirect(res, data)) return pending<{ text: string }>();
    if (!res.ok) throw new Error((data as any).error ?? 'فشل التفريغ');
    return data as { text: string };
  },
};

// واجهات المراجعة العامة (بلا مصادقة)
export const publicApi = {
  getShare: (token: string) => fetch(`/api/shares/public/${token}`).then((r) => r.json()),
  comment: (token: string, author: string, body: string) =>
    fetch(`/api/shares/public/${token}/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author, body }),
    }).then((r) => r.json()),
  decision: (token: string, decision: string, author: string) =>
    fetch(`/api/shares/public/${token}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision, author }),
    }).then((r) => r.json()),
};

// بثّ المحادثة (SSE عبر fetch)
export interface StreamHandlers {
  onMeta?: (meta: any) => void;
  onDelta?: (text: string) => void;
  onSearch?: () => void;
  onVerify?: (v: any) => void;
  /** الأنظمة الغائبة — تصل بعد التوليد لا معه، فهي مصفّاة بالردّ نفسه. */
  onRegulations?: (missing: string[]) => void;
  /** عنوان المحادثة حين يُصاغ من موضوعها — أول ردّ وحده. */
  onTitle?: (title: string) => void;
  onDone?: () => void;
  onError?: (err: string) => void;
}

export async function streamChat(
  conversationId: string,
  message: string,
  forceInternet: boolean,
  bilingual: boolean,
  handlers: StreamHandlers
): Promise<void> {
  const res = await fetch(`/api/chat/${conversationId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ message, force_internet: forceInternet, bilingual }),
  });

  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: 'خطأ في الاتصال' }));
    // الجلسة تنتهي أثناء محادثة مفتوحة أكثر مما تنتهي بين نداءين: البثّ هو
    // أطول ما يبقى مفتوحاً. فيُقرأ فرعا المنع هنا كما يُقرآن في `req`.
    if (handleAuthRedirect(res, err)) return;
    handlers.onError?.((err as any).error ?? 'خطأ في التوليد');
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // حدث `done` يصل من الخادم، ويُستدعى ثانيةً عند انتهاء المجرى. والنداءان
  // معاً كانا يعيدان كتابة الفقاعة مرّتين على مصفوفةٍ قد تكون تغيّرت بينهما.
  //
  // و`done` يسبق «تحقّق الإسناد» و«الأنظمة الغائبة» و«العنوان»: الخادم يختم
  // الفقاعة أول ما يُحفظ الرد، ثم يُتبعها بما يُحسب عليه. فالقراءة تتواصل
  // بعد `done` ولا تتوقّف عنده.
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    handlers.onDone?.();
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop() ?? '';
    for (const evt of events) {
      const lines = evt.split('\n');
      const event = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? 'delta';
      const dataLine = lines.find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      try {
        const data = JSON.parse(dataLine.slice(6));
        if (event === 'meta') handlers.onMeta?.(data);
        else if (event === 'delta') handlers.onDelta?.(data.text ?? '');
        else if (event === 'search') handlers.onSearch?.();
        else if (event === 'verify') handlers.onVerify?.(data);
        else if (event === 'regulations') handlers.onRegulations?.(data.missing ?? []);
        else if (event === 'title') {
          if (data.title) handlers.onTitle?.(data.title);
        } else if (event === 'error') handlers.onError?.(data.error ?? 'تعذّر التوليد');
        else if (event === 'done') finish();
      } catch {}
    }
  }
  finish();
}
