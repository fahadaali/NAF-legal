/* نافذةٌ عائمة تعرض مرفق المحادثة وتُنزِّله.
 *
 * **وهي جواب «مرفوعٌ في مكانٍ لا أعرفه».** كان الملف يُرفع إلى R2 ولا مسار في
 * المنصة يُخرجه منها: الشارة تقول إن ملفاً هناك، ولا سبيل إلى رؤيته ولا إلى
 * استعادته. فمن رفع عقداً ليسأل عنه لا يملك حتى أن يتحقّق أنه رفع الصحيح.
 *
 * **وهي أختُ `KbViewer` لا نسخةٌ منها.** تلك تعرض وثيقة قاعدة معرفة: تنسخ
 * نصَّها كاملاً وتفتحها في تبويب — أفعالُ مسؤولٍ يبني قاعدة. وهذه تعرض ملفَّ
 * محادثةٍ وتُنزِّله: فعلُ قارئٍ يستعيد ما أرسل. والفرق في الأزرار لا في
 * الإطار، فالطبقة والبطاقة والترويسة من `styles.css` نفسها.
 */
import { useEffect, useState } from 'react';
import { ICON_MD, ICON_SM, Icon } from '../lib/icons';
import { api, type Attachment } from '../lib/api';

/** ما تعرضه النافذة: إطارٌ للـ PDF، وصورةٌ للصور، ونصٌّ لما عداهما. */
type ViewKind = 'pdf' | 'image' | 'text';

function viewKind(a: Attachment): ViewKind {
  const ext = (a.filename.split('.').pop() ?? '').toLowerCase();
  if (a.mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if ((a.mime ?? '').startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image';
  // ‏docx وغيره: الملف نفسه لا يُعرض في المتصفّح، والمعروض نصُّه المستخرَج.
  return 'text';
}

export default function AttachmentViewer({
  attachment,
  onClose,
}: {
  attachment: Attachment;
  onClose: () => void;
}) {
  const kind = viewKind(attachment);
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(kind === 'text');

  useEffect(() => {
    if (kind !== 'text') return;
    setLoading(true);
    fetch(api.attachmentTextUrl(attachment.id), { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((t) => setText(t))
      .catch(() => setText(''))
      .finally(() => setLoading(false));
  }, [attachment.id, kind]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* ملفٌّ لا نصَّ له يُعرض بالسطر المسجَّل لا بنافذةٍ خاوية.
     والسطر يقول ما بقي عاملاً — يُفتح ويُنزَّل — لأن «تعذّر استخراج النصّ»
     وحدها تُقرأ فشلاً في الرفع كلِّه. */
  const noText = kind === 'text' && !loading && !text?.trim();

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label="المرفق"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">
            <Icon.attachment size={ICON_SM} aria-hidden /> <bdi>{attachment.filename}</bdi>
          </span>
          <div className="modal-actions">
            {/* التنزيل رابطٌ لا زرّ: الترويسة `attachment`، والمتصفّح يحفظه
                بلا مغادرة النافذة. و`download` تُبقي الاسم العربي كما هو. */}
            <a
              className="btn-sm"
              href={api.attachmentFileUrl(attachment.id, true)}
              download={attachment.filename}
            >
              <Icon.download size={ICON_SM} aria-hidden /> تنزيل
            </a>
            <button className="modal-close" onClick={onClose} title="إغلاق" aria-label="إغلاق">
              <Icon.close size={ICON_MD} aria-hidden />
            </button>
          </div>
        </div>

        <div className="modal-body">
          {kind === 'pdf' && (
            <iframe className="modal-frame" src={api.attachmentFileUrl(attachment.id)} title={attachment.filename} />
          )}
          {kind === 'image' && (
            <div className="modal-imgwrap">
              <img src={api.attachmentFileUrl(attachment.id)} alt={attachment.filename} />
            </div>
          )}
          {kind === 'text' &&
            (loading ? (
              <div className="empty-state"><span className="spinner" /></div>
            ) : noText ? (
              <p className="empty-state">
                تعذّر استخراج النصّ من هذا الملف. يبقى مرفقاً يُفتح ويُنزَّل، ولا يبلغ نصُّه المساعد.
              </p>
            ) : (
              <pre className="kb-text-view" dir="auto">{text}</pre>
            ))}
        </div>
      </div>
    </div>
  );
}
