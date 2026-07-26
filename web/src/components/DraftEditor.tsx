import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { formatDate, formatTime } from '../lib/format';

interface Version {
  id: string;
  version: number;
  content: string;
  note?: string;
  created_at: number;
}
interface Approval {
  approved_at: number;
  approver?: string;
  note?: string;
}

// محرّر المسودّة داخل الموقع: تحرير · سجل النُسخ · مقارنة · اعتماد
export default function DraftEditor({
  messageId,
  title,
  onClose,
  onSaved,
}: {
  messageId: string;
  title: string;
  onClose: () => void;
  onSaved: (content: string) => void;
}) {
  const [tab, setTab] = useState<'edit' | 'preview' | 'versions'>('edit');
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [versions, setVersions] = useState<Version[]>([]);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [compareWith, setCompareWith] = useState<Version | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);

  const load = () =>
    api.draftVersions(messageId).then((r) => {
      setContent(r.current);
      setOriginal(r.current);
      setVersions(r.versions);
      setApproval(r.approval);
      setLoading(false);
    });

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId]);

  const dirty = content !== original;

  const save = async () => {
    setBusy(true);
    try {
      await api.saveDraft(messageId, content);
      setOriginal(content);
      onSaved(content);
      await load();
      alert('حُفظت نسخة جديدة من المسودّة.');
    } catch (e: any) {
      alert(e.message ?? 'فشل الحفظ');
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (dirty) return alert('احفظ التعديلات أولًا قبل الاعتماد.');
    setBusy(true);
    try {
      await api.approveDraft(messageId);
      await load();
    } catch (e: any) {
      alert(e.message ?? 'فشل الاعتماد');
    } finally {
      setBusy(false);
    }
  };

  const unapprove = async () => {
    setBusy(true);
    try {
      await api.unapproveDraft(messageId);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const proofread = async () => {
    if (!confirm('تدقيق لغوي للنص الحالي؟ ستُستبدل النسخة في المحرّر (احفظها بعدها).')) return;
    setBusy(true);
    try {
      const r = await api.proofread(content);
      setContent(r.result);
      setTab('edit');
    } catch (e: any) {
      alert(e.message ?? 'فشل التدقيق');
    } finally {
      setBusy(false);
    }
  };

  const alternative = async () => {
    const instruction = prompt('توجيه إضافي للصياغة البديلة (اختياري):') ?? undefined;
    setBusy(true);
    try {
      await api.draftAlternative(messageId, instruction);
      await load();
      setTab('versions');
      alert('أُنشئت صياغة بديلة — قارنها في تبويب النُسخ واسترجعها إن أعجبتك.');
    } catch (e: any) {
      alert(e.message ?? 'فشل التوليد البديل');
    } finally {
      setBusy(false);
    }
  };

  const restore = async (v: Version) => {
    if (!confirm(`استرجاع النسخة ${v.version}؟ ستُحفظ كنسخة أحدث.`)) return;
    setBusy(true);
    try {
      const r = await api.restoreDraft(messageId, v.id);
      setContent(r.content);
      setOriginal(r.content);
      onSaved(r.content);
      await load();
      setTab('edit');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">✎ {title}</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {approval ? (
              <span className="pill ready" title={`اعتمدها ${approval.approver ?? ''}`}>معتمَدة ✅</span>
            ) : (
              <span className="pill pending">غير معتمَدة</span>
            )}
            <button className="modal-close" onClick={onClose} title="إغلاق">×</button>
          </div>
        </div>

        <div className="admin-tabs" style={{ margin: '0 16px' }}>
          <button className={`admin-tab ${tab === 'edit' ? 'active' : ''}`} onClick={() => setTab('edit')}>تحرير</button>
          <button className={`admin-tab ${tab === 'preview' ? 'active' : ''}`} onClick={() => setTab('preview')}>معاينة</button>
          <button className={`admin-tab ${tab === 'versions' ? 'active' : ''}`} onClick={() => setTab('versions')}>
            النُسخ (<bdi>{versions.length}</bdi>)
          </button>
        </div>

        <div className="modal-body" style={{ padding: 16 }}>
          {loading ? (
            <div className="empty-state"><span className="spinner" /></div>
          ) : tab === 'edit' ? (
            <textarea
              ref={ta}
              className="draft-textarea"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              dir="auto"
            />
          ) : tab === 'preview' ? (
            <div className="msg-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
          ) : (
            <div>
              {versions.length === 0 && <div className="empty-state">لا نُسخ محفوظة.</div>}
              {versions.map((v) => (
                <div key={v.id} className="version-row">
                  <div>
                    <strong>النسخة {v.version}</strong>
                    <span style={{ color: 'var(--muted-foreground)', fontSize: '0.875rem', marginInlineStart: 8 }}>
                      <bdi>{formatDate(v.created_at)} {formatTime(v.created_at)}</bdi> {v.note ? `— ${v.note}` : ''}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn-sm" onClick={() => setCompareWith(compareWith?.id === v.id ? null : v)}>
                      {compareWith?.id === v.id ? 'إخفاء المقارنة' : 'مقارنة بالحالية'}
                    </button>
                    <button className="btn-sm" onClick={() => restore(v)}>استرجاع</button>
                  </div>
                  {compareWith?.id === v.id && <DiffView oldText={v.content} newText={content} />}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn-sm" onClick={proofread} disabled={busy}>✍ تدقيق لغوي</button>
          <button className="btn-sm" onClick={alternative} disabled={busy}>🔀 صياغة بديلة</button>
          {approval ? (
            <button className="btn-sm" onClick={unapprove} disabled={busy}>إلغاء الاعتماد</button>
          ) : (
            <button className="btn-sm" onClick={approve} disabled={busy}>✅ اعتماد المسودّة</button>
          )}
          <button className="btn-sm" onClick={onClose}>إغلاق</button>
          <button className="btn-primary" style={{ width: 'auto', padding: '11px 24px' }} onClick={save} disabled={busy || !dirty}>
            {busy ? '…' : dirty ? 'حفظ نسخة جديدة' : 'لا تغييرات'}
          </button>
        </div>
      </div>
    </div>
  );
}

// مقارنة سطرية بسيطة بين نسختين
function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const setB = new Set(b);
  const setA = new Set(a);
  const rows: { kind: 'same' | 'removed' | 'added'; text: string }[] = [];
  for (const line of a) rows.push({ kind: setB.has(line) ? 'same' : 'removed', text: line });
  for (const line of b) if (!setA.has(line)) rows.push({ kind: 'added', text: line });
  return (
    <div className="diff-view">
      {rows
        .filter((r) => r.kind !== 'same' || r.text.trim() === '')
        .filter((r) => r.text.trim() !== '')
        .map((r, i) => (
          <div key={i} className={`diff-line ${r.kind}`}>
            {r.kind === 'removed' ? '−' : '+'} {r.text}
          </div>
        ))}
      {rows.every((r) => r.kind === 'same') && <div style={{ color: 'var(--muted-foreground)', fontSize: '0.875rem' }}>لا فروق.</div>}
    </div>
  );
}
