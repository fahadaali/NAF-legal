// عميل API للواجهة
export interface User {
  id: string;
  email: string;
  role: 'user' | 'admin';
  name?: string;
}

export interface Conversation {
  id: string;
  title: string;
  consultation_type: string | null;
  created_at: number;
  updated_at: number;
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

  // المحادثات
  listConversations: (q?: string) =>
    req<{ conversations: Conversation[] }>(`/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`),
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
  tracking: () => req<{ needs_update: any[]; new_suggested: any[] }>('/admin/tracking'),
  resolveTracking: (id: string) => req(`/admin/tracking/${id}/resolve`, { method: 'POST' }),
  scanTracking: () => req<{ checked: number; flagged: number }>('/admin/tracking/scan', { method: 'POST' }),
  users: () => req<{ users: User[] }>('/admin/users'),
  setRole: (id: string, role: string) =>
    req(`/admin/users/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  audit: () => req<{ entries: any[] }>('/admin/audit'),
};

// بثّ المحادثة (SSE عبر fetch)
export interface StreamHandlers {
  onMeta?: (meta: any) => void;
  onDelta?: (text: string) => void;
  onSearch?: () => void;
  onDone?: () => void;
  onError?: (err: string) => void;
}

export async function streamChat(
  conversationId: string,
  message: string,
  forceInternet: boolean,
  handlers: StreamHandlers
): Promise<void> {
  const res = await fetch(`/api/chat/${conversationId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ message, force_internet: forceInternet }),
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
        else if (event === 'done') handlers.onDone?.();
      } catch {}
    }
  }
  handlers.onDone?.();
}
