import { useEffect, useRef, useState } from 'react';
import { api, Message, Attachment, Folder, streamChat } from '../lib/api';
import { CONSULTATIONS, labelFor } from '../lib/consultations';
import { renderMarkdown } from '../lib/markdown';

interface Props {
  conversationId: string | null;
  onConversationChange: (id: string) => void;
  onToggleSidebar: () => void;
}

interface UiMessage extends Message {
  citations?: any[];
  clarifying?: boolean;
  streaming?: boolean;
  verification?: { verified: boolean; unsupported: string[]; note: string } | null;
}

export default function ChatView({ conversationId, onConversationChange, onToggleSidebar }: Props) {
  const [convType, setConvType] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [convFolder, setConvFolder] = useState<string>('');
  const [feedback, setFeedback] = useState<Record<string, number>>({});
  const [input, setInput] = useState('');
  const [internet, setInternet] = useState(false);
  const [bilingual, setBilingual] = useState(false);
  const [sending, setSending] = useState(false);
  const [searching, setSearching] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  useEffect(() => {
    api.folders().then((r) => setFolders(r.folders)).catch(() => {});
  }, []);

  useEffect(() => {
    if (conversationId) {
      api.getConversation(conversationId).then((r) => {
        setConvType(r.conversation.consultation_type);
        setConvFolder((r.conversation as any).folder_id ?? '');
        const msgs = r.messages.map((m) => {
          let citations, clarifying, verification;
          try {
            const meta = m.metadata_json ? JSON.parse(m.metadata_json) : {};
            citations = meta.citations;
            clarifying = meta.clarifying;
            verification = meta.verification;
          } catch {}
          return { ...m, citations, clarifying, verification };
        });
        setMessages(msgs);
        setAttachments(r.attachments);
        // حمّل تقييمات المستخدم لرسائل المساعد لإبراز الحالة الحالية
        Promise.all(
          msgs
            .filter((m) => m.role === 'assistant')
            .map((m) => api.getFeedback(m.id).then((f) => [m.id, f.feedback?.rating] as const).catch(() => [m.id, undefined] as const))
        ).then((pairs) => {
          const map: Record<string, number> = {};
          for (const [id, r] of pairs) if (r) map[id] = r;
          setFeedback(map);
        });
      });
    } else {
      setConvType(null);
      setMessages([]);
      setAttachments([]);
    }
  }, [conversationId]);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const autoGrow = () => {
    const el = textarea.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    }
  };

  const startConsultation = async (type: string) => {
    const conv = await api.createConversation(type);
    setConvType(type);
    onConversationChange(conv.id);
  };

  const doUpload = async (files: FileList | null) => {
    if (!files?.length || !conversationId) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        const r = await api.uploadFile(conversationId, f);
        setAttachments((a) => [...a, { id: r.id, filename: r.filename, mime: r.mime, size: r.size, created_at: Date.now() }]);
      }
    } catch (e: any) {
      alert(e.message ?? 'فشل رفع الملف');
    } finally {
      setUploading(false);
    }
  };

  const send = async () => {
    if (!input.trim() || !conversationId || sending) return;
    const text = input.trim();
    setInput('');
    if (textarea.current) textarea.current.style.height = 'auto';

    const userMsg: UiMessage = { id: 'u' + Date.now(), role: 'user', content: text, created_at: Date.now() };
    const asstMsg: UiMessage = { id: 'a' + Date.now(), role: 'assistant', content: '', created_at: Date.now(), streaming: true };
    setMessages((m) => [...m, userMsg, asstMsg]);
    setSending(true);
    setSearching(false);

    let acc = '';
    let meta: any = {};
    let verification: any = null;
    await streamChat(conversationId, text, internet, bilingual, {
      onMeta: (m) => {
        meta = m;
        if (m.messageId) asstMsg.id = m.messageId;
      },
      onSearch: () => setSearching(true),
      onVerify: (v) => {
        verification = v;
      },
      onDelta: (t) => {
        acc += t;
        setSearching(false);
        setMessages((msgs) => {
          const copy = [...msgs];
          copy[copy.length - 1] = { ...asstMsg, id: meta.messageId ?? asstMsg.id, content: acc, streaming: true, citations: meta.citations, clarifying: meta.clarifying };
          return copy;
        });
      },
      onDone: () => {
        setMessages((msgs) => {
          const copy = [...msgs];
          copy[copy.length - 1] = { ...asstMsg, id: meta.messageId ?? asstMsg.id, content: acc, streaming: false, citations: meta.citations, clarifying: meta.clarifying, verification };
          return copy;
        });
        setSending(false);
        setSearching(false);
        onConversationChange(conversationId);
      },
      onError: (err) => {
        setMessages((msgs) => {
          const copy = [...msgs];
          copy[copy.length - 1] = { ...asstMsg, content: `⚠️ ${err}`, streaming: false };
          return copy;
        });
        setSending(false);
        setSearching(false);
      },
    });
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
      alert('تعذّر الوصول للميكروفون');
    }
  };

  // تصدير PDF عبر طباعة المتصفّح (يدعم العربية أصلًا) (§4)
  const exportPdf = (m: UiMessage) => {
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>مستشار ناف</title>
      <style>body{font-family:'Segoe UI',Tahoma,Arial,sans-serif;line-height:1.9;padding:40px;max-width:800px;margin:auto}
      h1,h2,h3{color:#0f766e}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px}
      .disc{margin-top:40px;font-size:12px;color:#888;border-top:1px solid #ddd;padding-top:10px}</style></head>
      <body>${renderMarkdown(m.content)}<div class="disc">هذا المحتوى مسودّة مساعِدة تتطلّب مراجعة محامٍ مختصّ قبل الاعتماد.</div>
      <script>window.onload=()=>window.print()</script></body></html>`);
    w.document.close();
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

          <div className="picker-group-title">⚖️ التقاضي</div>
          <div className="cards">
            {grouped.map((c) => (
              <button key={c.type} className="card" onClick={() => startConsultation(c.type)}>
                <div className="card-icon">{c.icon}</div>
                <div className="card-title">{c.label}</div>
                <div className="card-desc">{c.description}</div>
              </button>
            ))}
          </div>

          <div className="picker-group-title">خدمات أخرى</div>
          <div className="cards">
            {others.map((c) => (
              <button key={c.type} className="card" onClick={() => startConsultation(c.type)}>
                <div className="card-icon">{c.icon}</div>
                <div className="card-title">{c.label}</div>
                <div className="card-desc">{c.description}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── نافذة المحادثة ──
  return (
    <>
      <div className="chat-header">
        <button className="icon-btn" style={{ display: 'none' }} onClick={onToggleSidebar}>
          ☰
        </button>
        <span className="ch-title">{messages.find((m) => m.role === 'user')?.content.slice(0, 50) ?? 'محادثة جديدة'}</span>
        {folders.length > 0 && (
          <select className="folder-select" value={convFolder} onChange={(e) => assignFolder(e.target.value)} title="ربط بقضية">
            <option value="">📁 بدون قضية</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        )}
        {convType && <span className="ch-badge">{labelFor(convType)}</span>}
      </div>

      <div className="messages">
        <div className="messages-inner">
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              <div className="msg-avatar">{m.role === 'user' ? 'أنت' : 'ن'}</div>
              <div className="msg-body">
                <div className="msg-role">{m.role === 'user' ? 'أنت' : 'مستشار ناف'}</div>
                <div className="msg-content">
                  {m.streaming && !m.content ? (
                    <div className="typing-dots">
                      {searching && <span style={{ fontSize: 13, marginInlineEnd: 8 }}>🔎 يبحث في المصادر…</span>}
                      <span></span>
                      <span></span>
                      <span></span>
                    </div>
                  ) : (
                    <div dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
                  )}
                  {m.clarifying && <div className="clarify-note">⏸ بانتظار توضيحك للمتابعة</div>}
                  {m.verification && !m.streaming && (
                    <div className={`verify-badge ${m.verification.verified ? 'ok' : 'warn'}`}>
                      {m.verification.verified
                        ? '✓ تحقّق الإسناد: كل المواد المذكورة مسنودة في قاعدة المعرفة'
                        : `⚠ مواد بحاجة لتأكيد يدوي: ${m.verification.unsupported.join('، ')}`}
                    </div>
                  )}
                  {m.citations && m.citations.length > 0 && (
                    <div className="citations">
                      <span>المصادر:</span>
                      {m.citations.map((c: any, i: number) => (
                        <span key={i} className="citation-chip">
                          {c.title}
                          {c.ref ? ` — ${c.ref}` : ''}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {m.role === 'assistant' && !m.streaming && m.content && !m.clarifying && (
                  <div className="msg-actions">
                    <a href={api.exportUrl(m.id, 'docx')} download>
                      <button>⬇ Word</button>
                    </a>
                    <button onClick={() => exportPdf(m)}>⬇ PDF</button>
                    <a href={api.exportUrl(m.id, 'txt')} download>
                      <button>⬇ نص</button>
                    </a>
                    <button onClick={() => navigator.clipboard.writeText(m.content)}>نسخ</button>
                    <button onClick={() => shareDraft(m)}>🔗 مشاركة للمراجعة</button>
                    <button className={feedback[m.id] === 1 ? 'fb-on' : ''} onClick={() => sendFeedback(m, 1)} title="مفيد">👍</button>
                    <button className={feedback[m.id] === -1 ? 'fb-on' : ''} onClick={() => sendFeedback(m, -1)} title="يحتاج تحسين">👎</button>
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEnd} />
        </div>
      </div>

      <div className="composer">
        <div className="composer-inner">
          {attachments.length > 0 && (
            <div className="attachments-row">
              {attachments.map((a) => (
                <span key={a.id} className="attach-chip">
                  📎 {a.filename}
                </span>
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
              title="رفع ملف"
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
            >
              {uploading ? <span className="spinner" /> : '📎'}
            </button>
            <button
              className={`icon-btn ${internet ? 'on' : ''}`}
              title="البحث في الإنترنت"
              onClick={() => setInternet((v) => !v)}
            >
              🌐
            </button>
            <button
              className={`icon-btn ${recording ? 'on rec' : ''}`}
              title="إدخال صوتي (تفريغ عربي)"
              onClick={toggleRecording}
            >
              {recording ? '⏹' : '🎙'}
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
            <button className="send-btn" onClick={send} disabled={sending || !input.trim()}>
              {sending ? <span className="spinner" /> : '➤'}
            </button>
          </div>
          <div className="composer-hint">
            {internet ? '🌐 البحث في الإنترنت مُفعَّل' : 'يعتمد الرد على قاعدة المعرفة النظامية'}
          </div>
        </div>
      </div>
    </>
  );
}
