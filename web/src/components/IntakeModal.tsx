import { useRef, useState } from 'react';
import { extractPdfText, readableLocally } from '../lib/extractText';
import { api, ConsultConfig } from '../lib/api';
import { Icon, ICON_SM, ICON_MD } from '../lib/icons';

// نافذة إدخال البيانات الأولية ورفع الملف قبل الدخول إلى المحادثة
export default function IntakeModal({
  config,
  onClose,
  onStart,
}: {
  config: ConsultConfig;
  onClose: () => void;
  /** ومعها معرِّفاتُ ما رُفع: تُختم برسالة البدء كما تُختم مرفقاتُ أيّ دور. */
  onStart: (conversationId: string, message: string, attachmentIds: string[]) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [pastedText, setPastedText] = useState('');
  const [useText, setUseText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const setVal = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 320) + 'px';
  };

  const submit = async () => {
    setError('');
    // تحقّق الحقول المطلوبة
    for (const f of config.fields) {
      if (f.required && !values[f.key]?.trim()) {
        setError(`الحقل مطلوب: ${f.label}`);
        return;
      }
    }
    // تحقّق الملف/النص
    if (config.file.enabled && config.file.required) {
      const hasFile = !!file;
      const hasText = config.file.allow_text && pastedText.trim().length > 0;
      if (!hasFile && !hasText) {
        setError(`مطلوب: ${config.file.label}${config.file.allow_text ? ' (ارفع ملفًا أو الصق النص)' : ''}`);
        return;
      }
    }

    setBusy(true);
    try {
      const conv = await api.createConversation(config.key);
      const ids: string[] = [];
      if (config.file.enabled && file) {
        /* الاستخراج هنا كما في صندوق الكتابة سواء — وإلا كان ملفُّ نافذة البدء
           وحده يمرّ على النموذج ويُكلِّف رموزاً لا يكلّفها الملفُّ نفسه لو
           أُرفق بعد سطرٍ واحد من المحادثة. */
        const local = readableLocally(file) ? await extractPdfText(file) : null;
        const r = await api.uploadFile(conv.id, file, local);
        ids.push(r.id);
      }
      onStart(conv.id, composeMessage(config, values, file, pastedText), ids);
    } catch (e: any) {
      setError(e.message ?? 'تعذّر البدء');
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card intake" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{config.label} — البيانات الأولية</span>
          <button className="modal-close" onClick={onClose} title="إغلاق"><Icon.close size={ICON_MD} aria-hidden /></button>
        </div>

        <div className="modal-body intake-body">
          {error && <div className="error-box">{error}</div>}

          {config.fields.map((f) => (
            <div className="field" key={f.key}>
              <label>
                {f.label} {f.required && <span style={{ color: 'var(--destructive)' }}>*</span>}
              </label>
              {f.type === 'textarea' ? (
                <textarea
                  className="intake-textarea"
                  value={values[f.key] ?? ''}
                  placeholder={f.placeholder ?? ''}
                  onChange={(e) => {
                    setVal(f.key, e.target.value);
                    grow(e.target);
                  }}
                />
              ) : (
                <input
                  type={f.type === 'number' ? 'number' : 'text'}
                  value={values[f.key] ?? ''}
                  placeholder={f.placeholder ?? ''}
                  onChange={(e) => setVal(f.key, e.target.value)}
                />
              )}
            </div>
          ))}

          {config.file.enabled && (
            <div className="field">
              <label>
                {config.file.label} {config.file.required && <span style={{ color: 'var(--destructive)' }}>*</span>}
              </label>

              {config.file.allow_text && (
                <div className="intake-toggle">
                  <button className={`seg ${!useText ? 'on' : ''}`} onClick={() => setUseText(false)}>رفع ملف</button>
                  <button className={`seg ${useText ? 'on' : ''}`} onClick={() => setUseText(true)}>لصق النص</button>
                </div>
              )}

              {!useText ? (
                <>
                  <input
                    ref={fileInput}
                    type="file"
                    hidden
                    accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                  <div className="dropzone" onClick={() => fileInput.current?.click()}>
                    {file
                      ? <><Icon.attachment size={ICON_SM} aria-hidden /> <bdi>{file.name}</bdi></>
                      : <><Icon.upload size={ICON_SM} aria-hidden /> اضغط لاختيار الملف (PDF · DOCX · صورة · نص)</>}
                  </div>
                </>
              ) : (
                <textarea
                  className="intake-textarea"
                  style={{ minHeight: 160 }}
                  value={pastedText}
                  placeholder="الصق نص المذكرة/اللائحة/الحكم هنا…"
                  onChange={(e) => setPastedText(e.target.value)}
                />
              )}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn-sm" onClick={onClose}>إلغاء</button>
          <button className="btn-primary" style={{ width: 'auto', padding: '11px 26px' }} onClick={submit} disabled={busy}>
            {busy ? 'جارٍ البدء…' : <>بدء الاستشارة <Icon.next size={ICON_SM} aria-hidden /></>}
          </button>
        </div>
      </div>
    </div>
  );
}

// يبني رسالة البدء من الحقول والملف/النص
function composeMessage(config: ConsultConfig, values: Record<string, string>, file: File | null, pastedText: string): string {
  const parts: string[] = [];
  for (const f of config.fields) {
    const v = values[f.key]?.trim();
    if (v) parts.push(`**${f.label}:**\n${v}`);
  }
  if (config.file.enabled) {
    if (file) parts.push(`**${config.file.label}:** (مرفق ملف: ${file.name})`);
    else if (config.file.allow_text && pastedText.trim()) {
      parts.push(`**${config.file.label} (نص):**\n${pastedText.trim()}`);
    }
  }
  const header = `أرجو إنجاز المطلوب (${config.label}) بناءً على البيانات التالية:`;
  return `${header}\n\n${parts.join('\n\n')}`;
}
