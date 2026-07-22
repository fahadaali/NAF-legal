// عميل API للواجهة
export interface User {
  id: string;
  email: string;
  role: 'user' | 'admin';
  name?: string;
  must_change_password?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  consultation_type: string | null;
  folder_id?: string | null;
  tags_json?: string | null;
  created_at: number;
  updated_at: number;
}

export interface Folder {
  id: string;
  name: string;
  color: string;
  count: number;
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

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
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
  logout: () => req('/auth/logout', { method: 'POST' }),
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
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'فشل الرفع');
    return data;
  },
  exportUrl: (messageId: string, format: 'docx' | 'txt') => `/api/files/export/${messageId}?format=${format}`,

  // الإدارة
  kbDocuments: () => req<{ documents: any[] }>('/kb/documents'),
  deleteKbDocument: (id: string) => req(`/kb/documents/${id}`, { method: 'DELETE' }),
  reingestKbDocument: (id: string) => req(`/kb/documents/${id}/reingest`, { method: 'POST' }),
  kbVersions: (id: string) => req<{ versions: any[] }>(`/kb/documents/${id}/versions`),
  tracking: () => req<{ needs_update: any[]; new_suggested: any[] }>('/admin/tracking'),
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
  analytics: () => req<any>('/admin/analytics'),
  settings: () => req<{ settings: Record<string, string> }>('/admin/settings'),
  saveSettings: (s: Record<string, string>) => req('/admin/settings', { method: 'POST', body: JSON.stringify(s) }),
  news: () => req<{ news: any[] }>('/admin/news'),
  scanNews: () => req<{ found: number }>('/admin/news/scan', { method: 'POST' }),
  ingestNews: (id: string) => req(`/admin/news/${id}/ingest`, { method: 'POST' }),

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

  // الأدوات القانونية
  compare: (text_a: string, text_b: string) =>
    req<{ result: string }>('/tools/compare', { method: 'POST', body: JSON.stringify({ text_a, text_b }) }),
  deadlines: (payload: any) => req<{ result: string }>('/tools/deadlines', { method: 'POST', body: JSON.stringify(payload) }),
  transcribe: async (blob: Blob) => {
    const res = await fetch('/api/tools/transcribe', { method: 'POST', body: blob, credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'فشل التفريغ');
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
        else if (event === 'done') handlers.onDone?.();
      } catch {}
    }
  }
  handlers.onDone?.();
}
