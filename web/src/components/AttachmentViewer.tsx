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

/** كيف يُعرض الملفّ نفسه: إطارٌ للـ PDF، وصورةٌ للصور، ونصٌّ لما عداهما. */
type ViewKind = 'pdf' | 'image' | 'text';

/**
 * منظرا النافذة.
 *
 * **والثاني ليس تكراراً للأوّل.** الملفّ يُعرض كما هو وهذا ما يعرفه صاحبُه؛
 * والنصُّ المستخرَج هو **ما بلغ المساعد فعلاً**، وقد يخالف ما تراه العين —
 * صفحةٌ ممسوحة ضوئياً تبدو كاملةً ونصُّها ناقص، أو جدولٌ يخرج مبعثراً. ومن
 * يقرأ جواباً لا يفسّره الملف يحتاج أن يرى ما قُرئ لا ما رأى.
 */
type Pane = 'file' | 'text';

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
  /* الملفّ هو المنظر الأوّل: من يفتح مرفقاً يريد أن يراه، وبدءُ النافذة بالنصّ
     يجعله يظنّ الملفَّ ضائعاً. وما لا يُعرض في المتصفّح — docx وغيره — منظرُه
     الوحيد نصُّه، فلا تُعرض له مبدّلةٌ بمنظرٍ لا وجود له. */
  const showsFile = kind !== 'text';
  const [pane, setPane] = useState<Pane>(showsFile ? 'file' : 'text');
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(!showsFile);

  useEffect(() => {
    if (pane !== 'text' || text !== null) return;
    setLoading(true);
    fetch(api.attachmentTextUrl(attachment.id), { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((t) => setText(t))
      .catch(() => setText(''))
      .finally(() => setLoading(false));
  }, [attachment.id, pane, text]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* ملفٌّ لا نصَّ له يُعرض بالسطر المسجَّل لا بنافذةٍ خاوية.
     والسطر يقول ما بقي عاملاً — يُفتح ويُنزَّل — لأن «تعذّر استخراج النصّ»
     وحدها تُقرأ فشلاً في الرفع كلِّه. */
  const noText = pane === 'text' && !loading && !text?.trim();

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
            {/* المبدّلة لِما له منظران فقط. وهي أزرارٌ لا تبويبات: لوحان لا
                شاشتان، والمحتوى تحتها يتبدّل في مكانه. */}
            {showsFile && (
              <div className="pane-switch" role="group" aria-label="المرفق">
                <button
                  type="button"
                  className={`btn-sm ${pane === 'file' ? 'on' : ''}`}
                  aria-pressed={pane === 'file'}
                  onClick={() => setPane('file')}
                >
                  الملف
                </button>
                <button
                  type="button"
                  className={`btn-sm ${pane === 'text' ? 'on' : ''}`}
                  aria-pressed={pane === 'text'}
                  onClick={() => setPane('text')}
                >
                  النصّ المستخرَج
                </button>
              </div>
            )}
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
          {pane === 'file' && kind === 'pdf' && (
            <iframe className="modal-frame" src={api.attachmentFileUrl(attachment.id)} title={attachment.filename} />
          )}
          {pane === 'file' && kind === 'image' && (
            <div className="modal-imgwrap">
              <img src={api.attachmentFileUrl(attachment.id)} alt={attachment.filename} />
            </div>
          )}
          {pane === 'text' &&
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
