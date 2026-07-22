import { useEffect, useState } from 'react';

export type ViewKind = 'pdf' | 'image' | 'text';

export interface ViewerTarget {
  title: string;
  kind: ViewKind;
  fileUrl: string; // للـ PDF/الصورة
  textUrl: string; // للنص
}

// يحدّد نوع العرض من امتداد ملف R2
export function fileKind(r2key: string | null | undefined): ViewKind {
  const ext = (r2key ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image';
  return 'text'; // نص · docx · بلا ملف → نعرض النص المستخرَج
}

// نافذة منبثقة لتصفّح محتوى قاعدة المعرفة داخل الموقع
export default function KbViewer({ target, onClose }: { target: ViewerTarget; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(target.kind === 'text');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (target.kind !== 'text') return;
    setLoading(true);
    fetch(target.textUrl, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((t) => setText(t))
      .catch(() => setText('تعذّر تحميل النص.'))
      .finally(() => setLoading(false));
  }, [target.textUrl, target.kind]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copyAll = async () => {
    if (text) {
      await navigator.clipboard.writeText(text).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">
            {target.kind === 'pdf' ? '📕 ' : target.kind === 'image' ? '🖼 ' : '📄 '}
            {target.title}
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {target.kind === 'text' && (
              <button className="btn-sm" onClick={copyAll}>{copied ? '✓ نُسخ' : 'نسخ الكل'}</button>
            )}
            <a href={target.kind === 'text' ? target.textUrl : target.fileUrl} target="_blank" rel="noopener">
              <button className="btn-sm">فتح في تبويب</button>
            </a>
            <button className="modal-close" onClick={onClose} title="إغلاق">×</button>
          </div>
        </div>

        <div className="modal-body">
          {target.kind === 'pdf' && <iframe className="modal-frame" src={target.fileUrl} title={target.title} />}
          {target.kind === 'image' && (
            <div className="modal-imgwrap"><img src={target.fileUrl} alt={target.title} /></div>
          )}
          {target.kind === 'text' &&
            (loading ? (
              <div className="empty-state"><span className="spinner" /></div>
            ) : (
              <pre className="kb-text-view" dir="auto">{text}</pre>
            ))}
        </div>
      </div>
    </div>
  );
}
