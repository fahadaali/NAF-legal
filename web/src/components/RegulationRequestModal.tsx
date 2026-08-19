import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Icon, ICON_MD } from '../lib/icons';
import { modalCardProps, useModalDismiss } from '../lib/modal';

// نافذة طلب إضافة نظام غير موجود في قاعدة المعرفة.
// تُفتح من موضعين بالبيانات نفسها: من داخل المحادثة حين يتبيّن أن الإسناد
// يتطلّب نظامًا غير موجود، ومن صفحة الدعم ابتداءً.
// اسم النظام وحده مطلوب، وكل ما عداه اختياري، والنافذة تُغلق في أي وقت.
export default function RegulationRequestModal({
  initialName = '',
  source,
  conversationId,
  onClose,
  onDone,
}: {
  initialName?: string;
  source: 'chat' | 'support';
  conversationId?: string | null;
  onClose: () => void;
  onDone?: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [url, setUrl] = useState('');
  const [hasBylaw, setHasBylaw] = useState<boolean | null>(null);
  const [bylawUrl, setBylawUrl] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useModalDismiss(onClose);

  const submit = async () => {
    if (!name.trim()) {
      setError('هذا الحقل مطلوب');
      return;
    }
    setError('');
    setBusy(true);
    try {
      await api.createRegulationRequest({
        name: name.trim(),
        url: url.trim() || undefined,
        has_bylaw: hasBylaw === true,
        bylaw_url: hasBylaw === true ? bylawUrl.trim() || undefined : undefined,
        note: note.trim() || undefined,
        source,
        conversation_id: conversationId ?? undefined,
      });
      onDone?.();
      onClose();
    } catch (e: any) {
      setError(e.message ?? 'تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة');
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card intake" {...modalCardProps}>
        <div className="modal-head">
          <span className="modal-title">طلب إضافة نظام إلى قاعدة المعرفة</span>
          <button className="modal-close" onClick={onClose} title="إغلاق">
            <Icon.close size={ICON_MD} aria-hidden />
          </button>
        </div>

        <div className="modal-body intake-body">
          {error && <div className="error-box">{error}</div>}

          <p style={{ color: 'var(--muted-foreground)', fontSize: '0.875rem', marginTop: 0 }}>
            يصل الطلب إلى مسؤول النظام لرفع النظام إلى قاعدة المعرفة. اسم النظام وحده مطلوب، وبقيّة الحقول اختيارية.
          </p>

          <div className="field">
            <label>
              اسم النظام <span style={{ color: 'var(--destructive)' }}>*</span>
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="مثال: نظام المعاملات المدنية"
              autoFocus
            />
          </div>

          <div className="field">
            <label>هل يوجد له لائحة تنفيذية؟</label>
            <div className="intake-toggle">
              <button className={`seg ${hasBylaw === true ? 'on' : ''}`} onClick={() => setHasBylaw(true)}>
                نعم
              </button>
              <button
                className={`seg ${hasBylaw === false ? 'on' : ''}`}
                onClick={() => {
                  setHasBylaw(false);
                  setBylawUrl('');
                }}
              >
                لا
              </button>
            </div>
          </div>

          <div className="field">
            <label>رابط النظام (اختياري)</label>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" dir="ltr" style={{ textAlign: 'end' }} />
          </div>

          {hasBylaw === true && (
            <div className="field">
              <label>رابط اللائحة (اختياري)</label>
              <input
                value={bylawUrl}
                onChange={(e) => setBylawUrl(e.target.value)}
                placeholder="https://"
                dir="ltr"
                style={{ textAlign: 'end' }}
              />
            </div>
          )}

          <div className="field">
            <label>ملاحظة (اختياري)</label>
            <textarea
              className="intake-textarea"
              style={{ minHeight: 90 }}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="سبب الحاجة إليه أو المادة المطلوبة تحديدًا…"
            />
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn-sm" onClick={onClose}>
            إلغاء
          </button>
          <button
            className="btn-primary"
            style={{ width: 'auto', padding: '11px 26px' }}
            onClick={submit}
            disabled={busy}
          >
            {busy ? 'جارٍ الإرسال…' : 'إرسال الطلب'}
          </button>
        </div>
      </div>
    </div>
  );
}
