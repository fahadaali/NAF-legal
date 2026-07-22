import { useEffect, useState } from 'react';
import { publicApi } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { labelFor } from '../lib/consultations';
import { Aurora } from '../App';

// صفحة المراجعة العامة (بلا حساب) — يفتحها المحامي عبر رابط الرمز
export default function ReviewPage({ token }: { token: string }) {
  const [data, setData] = useState<any>(null);
  const [comments, setComments] = useState<any[]>([]);
  const [author, setAuthor] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    publicApi.getShare(token).then((r) => {
      if (r.error) setError(r.error);
      else {
        setData(r.share);
        setComments(r.comments ?? []);
      }
    });
  };
  useEffect(load, [token]);

  const addComment = async () => {
    if (!body.trim()) return;
    setBusy(true);
    await publicApi.comment(token, author || 'المراجِع', body);
    setBody('');
    setBusy(false);
    load();
  };

  const decide = async (decision: string) => {
    setBusy(true);
    await publicApi.decision(token, decision, author || 'المراجِع');
    setBusy(false);
    load();
  };

  if (error) return <div className="center-load"><div className="error-box">{error}</div></div>;
  if (!data) return <div className="center-load"><div className="spinner" style={{ width: 30, height: 30 }} /></div>;

  const statusLabel: Record<string, string> = {
    pending: 'بانتظار المراجعة',
    approved: 'مُعتمَد ✅',
    changes_requested: 'مطلوب تعديلات ✏️',
  };

  return (
    <div className="review-wrap">
      <Aurora />
      <div className="review-card">
        <div className="review-header">
          <div className="brand"><img className="brand-logo-img" src="/logo.jpeg" alt="ناف" /><div>
            <div className="brand-name">مراجعة مسودّة — مستشار ناف</div>
            <div className="brand-sub">{data.title} · {labelFor(data.consultation_type)}</div>
          </div></div>
          <span className={`pill ${data.status === 'approved' ? 'active' : data.status === 'pending' ? 'pending' : 'warn'}`}>
            {statusLabel[data.status]}
          </span>
        </div>

        <div className="msg-content review-doc" dangerouslySetInnerHTML={{ __html: renderMarkdown(data.content) }} />

        <div className="review-section">
          <h3>التعليقات ({comments.length})</h3>
          {comments.map((c, i) => (
            <div key={i} className="review-comment">
              <div className="rc-head"><strong>{c.author}</strong> · {new Date(c.created_at).toLocaleString('ar-SA')}</div>
              <div>{c.body}</div>
            </div>
          ))}

          <div className="field" style={{ marginTop: 14 }}>
            <input placeholder="اسمك (اختياري)" value={author} onChange={(e) => setAuthor(e.target.value)} />
          </div>
          <div className="composer-box" style={{ background: 'var(--surface)' }}>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="اكتب ملاحظتك على المسودّة…"
              rows={2}
              style={{ flex: 1, border: 'none', background: 'none', resize: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 14, outline: 'none' }}
            />
            <button className="send-btn" onClick={addComment} disabled={busy || !body.trim()}>➤</button>
          </div>

          <div className="review-actions">
            <button className="btn-primary" style={{ background: '#0f766e' }} onClick={() => decide('approved')} disabled={busy}>
              ✅ اعتماد المسودّة
            </button>
            <button className="btn-sm" onClick={() => decide('changes_requested')} disabled={busy}>
              ✏️ طلب تعديلات
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
