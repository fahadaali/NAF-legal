import { useEffect, useState } from 'react';
import { shareApi, type SharedDraft, type ShareComment } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { labelFor } from '../lib/consultations';
import { formatDate, formatTime } from '../lib/format';
import { ICON_MD, ICON_SM, Icon } from '../lib/icons';
import NafMark from './NafMark';

/**
 * صفحة مراجعة مسوّدة — يفتحها المراجِع برابط الرمز، **وله حساب في المنصة**.
 *
 * وكانت «بلا حساب»: أُخضع المساران للدخول الموحّد بقرارٍ موصوف في
 * `audit/sso-report.md`، ولم تُحدَّث هذه الشاشة بعده. فبقيت تنادي عبر
 * `fetch` خامٍ يقرأ `.json()` على صفحة دخولٍ HTML، ويُرفض وعدُه بلا
 * مُمسِك — فتدور دوّارةُ الانتظار بلا نهاية عند كل من فتح الرابط.
 *
 * والآن: النداء عبر `req`، والحال الثلاث معروضة — جارٍ، وتعذّر بسببه،
 * ومعروض. ومن لا حساب له يبلغه وسيطُ الدخول قبل أن تُركَّب هذه الشاشة أصلاً.
 */
export default function ReviewPage({ token }: { token: string }) {
  const [data, setData] = useState<SharedDraft | null>(null);
  const [comments, setComments] = useState<ShareComment[]>([]);
  const [author, setAuthor] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    shareApi
      .get(token)
      .then((r) => {
        setData(r.share);
        setComments(r.comments ?? []);
        setError('');
      })
      /* رسالةُ الخادم إن جاءت — «رابط غير صالح» تقول ما وقع. والعامّة
         تقول ما العمل. وبلا هذا المُمسِك كانت الشاشة تدور إلى الأبد. */
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'تعذّر فتح المراجعة. أعد المحاولة بعد قليل'));
  };
  useEffect(load, [token]);

  const addComment = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await shareApi.comment(token, author || 'المراجِع', body);
      setBody('');
      load();
    } catch (e: any) {
      setError(e?.message ?? 'تعذّر حفظ الملاحظة. أعد المحاولة بعد قليل');
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: string) => {
    setBusy(true);
    try {
      await shareApi.decision(token, decision, author || 'المراجِع');
      load();
    } catch (e: any) {
      setError(e?.message ?? 'تعذّر حفظ القرار. أعد المحاولة بعد قليل');
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) return <div className="center-load"><div className="error-box" role="alert">{error}</div></div>;
  if (!data) return <div className="center-load"><div className="spinner" style={{ width: 30, height: 30 }} /></div>;

  const statusLabel: Record<string, string> = {
    pending: 'بانتظار المراجعة',
    approved: 'معتمد',
    changes_requested: 'مطلوب تعديلات',
  };

  return (
    <div className="review-wrap">
      <div className="review-card">
        <div className="review-header">
          <div className="brand"><NafMark /><div>
            <div className="brand-name">مراجعة مسودّة — مستشار ناف</div>
            <div className="brand-sub">{data.title} · {labelFor(data.consultation_type)}</div>
          </div></div>
          <span className={`pill ${data.status === 'approved' ? 'active' : data.status === 'pending' ? 'pending' : 'warn'}`}>
            {statusLabel[data.status]}
          </span>
        </div>

        {/* خطأٌ وقع بعد أن عُرضت المسوّدة — تعليقٌ لم يُحفظ أو قرارٌ لم يصل.
            يُعرض فوق الصفحة ولا يمحوها: ما بلغه المراجع من قراءةٍ يبقى. */}
        {error && <div className="error-box" role="alert" style={{ marginBottom: 16 }}>{error}</div>}

        <div className="msg-content review-doc" dangerouslySetInnerHTML={{ __html: renderMarkdown(data.content) }} />

        <div className="review-section">
          <h3>التعليقات (<bdi>{comments.length}</bdi>)</h3>
          {comments.map((c, i) => (
            <div key={i} className="review-comment">
              <div className="rc-head"><strong>{c.author}</strong> · <bdi>{formatDate(c.created_at)} {formatTime(c.created_at)}</bdi></div>
              <div>{c.body}</div>
            </div>
          ))}

          <div className="field" style={{ marginTop: 16 }}>
            <input placeholder="اسمك (اختياري)" value={author} onChange={(e) => setAuthor(e.target.value)} />
          </div>
          <div className="composer-box" style={{ background: 'var(--card)' }}>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="اكتب ملاحظتك على المسودّة…"
              rows={2}
              style={{ flex: 1, border: 'none', background: 'none', resize: 'none', color: 'var(--foreground)', fontFamily: 'inherit', fontSize: '0.875rem', outline: 'none' }}
            />
            <button className="send-btn" onClick={addComment} disabled={busy || !body.trim()} aria-label="إرسال">
              <Icon.send size={ICON_MD} aria-hidden />
            </button>
          </div>

          <div className="review-actions">
            <button className="btn-primary" style={{ background: 'var(--success)', color: 'var(--success-foreground)' }} onClick={() => decide('approved')} disabled={busy}>
              <Icon.approved size={ICON_MD} aria-hidden /> اعتماد المسودّة
            </button>
            <button className="btn-sm" onClick={() => decide('changes_requested')} disabled={busy}>
              <Icon.changesRequested size={ICON_SM} aria-hidden /> طلب تعديلات
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
