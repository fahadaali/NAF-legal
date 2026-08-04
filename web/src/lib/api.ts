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
}

/** نظامٌ مستورد وحالُ مواده. */
export interface LegalLaw {
  law_id: string;
  law_title: string | null;
  parent_law_id: string | null;
  doc_type: string | null;
  instrument_no: string | null;
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
  articleNo: string | null;
  lawTitle: string | null;
  instrumentNo: string | null;
  status: string;
  isRepealed: boolean;
  issueDate: string | null;
  issueDateHijri: string | null;
  sourceUrl: string | null;
  text: string;
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
  embed_text_truncated?: number;
  embed_text_built?: number;
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
  legalLaw: (lawId: string) =>
    req<{ law: LegalLaw; regulations: LegalLaw[] }>(`/legal/laws/${encodeURIComponent(lawId)}`),
  legalLawArticles: (lawId: string, offset = 0, limit = 25) =>
    req<{ articles: LegalArticle[]; total: number }>(
      `/legal/laws/${encodeURIComponent(lawId)}/articles?offset=${offset}&limit=${limit}`
    ),
  legalImports: () => req<{ imports: LegalImportRecord[] }>('/legal/imports'),
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
    opts: { buildEmbed?: boolean; partial?: boolean } = {}
  ): Promise<LegalImportReport> => {
    const query = new URLSearchParams({
      filename,
      ...(opts.buildEmbed ? { build_embed_text: '1' } : {}),
      ...(opts.partial ? { partial: '1' } : {}),
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
  search: (q: string) => req<{ results: any[]; mode: string }>(`/search?q=${encodeURIComponent(q)}`),

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
        else if (event === 'error') handlers.onError?.(data.error ?? 'تعذّر التوليد');
        else if (event === 'done') handlers.onDone?.();
      } catch {}
    }
  }
  handlers.onDone?.();
}
