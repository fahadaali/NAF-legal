import { useEffect, useRef, useState } from 'react';
import { api, Message, Attachment, Folder, ConsultConfig, streamChat } from '../lib/api';
import { CONSULTATIONS, labelFor } from '../lib/consultations';
import { renderMarkdown } from '../lib/markdown';
import IntakeModal from './IntakeModal';
import DraftEditor from './DraftEditor';
import ClauseLibrary from './ClauseLibrary';
import RegulationRequestModal from './RegulationRequestModal';
import { ConsultationIcon, Icon, ICON_SM, ICON_MD, ICON_LG } from '../lib/icons';

interface Props {
  conversationId: string | null;
  initialMessage?: string | null;
  onInitialConsumed?: () => void;
  onStartConversation?: (conversationId: string, message: string) => void;
  onConversationChange: (id: string) => void;
  onToggleSidebar: () => void;
}

interface UiMessage extends Message {
  citations?: any[];
  clarifying?: boolean;
  streaming?: boolean;
  verification?: { verified: boolean; unsupported: string[]; note: string } | null;
  // أنظمة يتطلّبها الإسناد ولا وجود لها في قاعدة المعرفة
  missingRegulations?: string[];
}

export default function ChatView({ conversationId, initialMessage, onInitialConsumed, onStartConversation, onConversationChange, onToggleSidebar }: Props) {
  const [convType, setConvType] = useState<string | null>(null);
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
        setAttachments((a) => [...a, { id: r.id, filename: r.filename, mime: r.mime, size: r.size, created_at: Date.now() }]);
      }
    } catch (e: any) {
      alert(e.message ?? 'فشل رفع الملف');
    } finally {
      setUploading(false);
    }
  };

  const send = async (explicit?: string) => {
    const text = (explicit ?? input).trim();
    if (!text || !conversationId || sending) return;
    if (!explicit) setInput('');
    if (textarea.current) textarea.current.style.height = 'auto';

    const userMsg: UiMessage = { id: 'u' + Date.now(), role: 'user', content: text, created_at: Date.now() };
    const asstMsg: UiMessage = { id: 'a' + Date.now(), role: 'assistant', content: '', created_at: Date.now(), streaming: true };
    setMessages((m) => [...m, userMsg, asstMsg]);
    setSending(true);
    setSearching(false);

    let acc = '';
    let meta: any = {};
    let verification: any = null;
    let failed = false; // حتى لا يمحو حدث done رسالة الخطأ
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
          copy[copy.length - 1] = { ...asstMsg, id: meta.messageId ?? asstMsg.id, content: acc, streaming: true, citations: meta.citations, clarifying: meta.clarifying, missingRegulations: meta.missing_regulations };
          return copy;
        });
      },
      onDone: () => {
        if (failed) return; // أُبلِغ الخطأ سابقًا
        setMessages((msgs) => {
          const copy = [...msgs];
          copy[copy.length - 1] = { ...asstMsg, id: meta.messageId ?? asstMsg.id, content: acc, streaming: false, citations: meta.citations, clarifying: meta.clarifying, verification, missingRegulations: meta.missing_regulations };
          return copy;
        });
        setSending(false);
        setSearching(false);
        onConversationChange(conversationId);
        // نظام يتطلّبه الإسناد وغير موجود: تُعرض النافذة مرّة واحدة لكل نظام،
        // ويبقى التنبيه أسفل الرد لفتحها متى شاء المستخدم بعد إغلاقها.
        const pending: string[] = (meta.missing_regulations ?? []).filter((n: string) => !autoAsked.current.has(n));
        if (pending.length) {
          autoAsked.current.add(pending[0]);
          setRegRequest(pending[0]);
        }
      },
      onError: (err) => {
        failed = true;
        setMessages((msgs) => {
          const copy = [...msgs];
          copy[copy.length - 1] = { ...asstMsg, content: err, streaming: false };
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
      alert('تعذّر الوصول للميكروفون. تحقّق من إذن المتصفّح وأعد المحاولة.');
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
        <button className="icon-btn" style={{ display: 'none' }} onClick={onToggleSidebar}>
          <Icon.menu size={ICON_MD} aria-hidden />
        </button>
        <span className="ch-title">{messages.find((m) => m.role === 'user')?.content.slice(0, 50) ?? 'محادثة جديدة'}</span>
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
                      {searching && <span style={{ fontSize: '0.875rem', marginInlineEnd: 8 }}><Icon.search size={ICON_SM} aria-hidden /> يبحث في المصادر…</span>}
                      <span></span>
                      <span></span>
                      <span></span>
                    </div>
                  ) : (
                    <div dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
                  )}
                  {m.clarifying && <div className="clarify-note"><Icon.awaitingClarification size={ICON_SM} aria-hidden /> بانتظار توضيحك للمتابعة</div>}
                  {m.verification && !m.streaming && (
                    <div className={`verify-badge ${m.verification.verified ? 'ok' : 'warn'}`}>
                      {m.verification.verified
                        ? 'تحقّق الإسناد: كل المواد المذكورة مسنودة في قاعدة المعرفة'
                        : `<Icon.warning size={ICON_SM} aria-hidden /> مواد بحاجة لتأكيد يدوي: ${m.verification.unsupported.join('، ')}`}
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
          <div ref={messagesEnd} />
        </div>
      </div>

      <div className="composer">
        <div className="composer-inner">
          {attachments.length > 0 && (
            <div className="attachments-row">
              {attachments.map((a) => (
                <span key={a.id} className="attach-chip">
                  <Icon.attachment size={ICON_SM} aria-hidden /> <bdi>{a.filename}</bdi>
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
            <button className="send-btn" onClick={() => send()} disabled={sending || !input.trim()}>
              {sending ? <span className="spinner" /> : <Icon.send size={ICON_MD} aria-hidden />}
            </button>
          </div>
          <div className="composer-hint">
            {internet ? <><Icon.webSearch size={ICON_SM} aria-hidden /> البحث في الإنترنت مُفعَّل</> : 'يعتمد الرد على قاعدة المعرفة النظامية'}
          </div>
        </div>
      </div>

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
    </>
  );
}
