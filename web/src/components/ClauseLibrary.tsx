import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Clause {
  id: string;
  title: string;
  category?: string;
  body: string;
}

// بنك البنود: وضع الإدارة (تحرير) أو وضع الاختيار (إدراج في الصياغة)
export default function ClauseLibrary({
  mode,
  onPick,
  onClose,
}: {
  mode: 'admin' | 'pick';
  onPick?: (clause: Clause) => void;
  onClose?: () => void;
}) {
  const [items, setItems] = useState<Clause[]>([]);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Clause | null>(null);
  const [form, setForm] = useState({ title: '', category: '', body: '' });
  const [busy, setBusy] = useState(false);

  const load = () => api.clauses(q || undefined).then((r) => setItems(r.clauses)).catch(() => {});
  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const save = async () => {
    if (!form.title.trim() || !form.body.trim()) return alert('العنوان ونصّ البند مطلوبان');
    setBusy(true);
    try {
      if (editing) await api.updateClause(editing.id, form);
      else await api.createClause(form);
      setForm({ title: '', category: '', body: '' });
      setEditing(null);
      load();
    } catch (e: any) {
      alert(e.message ?? 'فشل الحفظ');
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (cl: Clause) => {
    setEditing(cl);
    setForm({ title: cl.title, category: cl.category ?? '', body: cl.body });
  };

  const body = (
    <>
      <div className="search-box" style={{ margin: '0 0 12px' }}>
        <input placeholder="بحث في البنود…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {mode === 'admin' && (
        <>
          <div className="section-title">{editing ? `تعديل: ${editing.title}` : 'إضافة بند'}</div>
          <div className="user-add-row">
            <input placeholder="عنوان البند" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={{ minWidth: 240 }} />
            <input placeholder="التصنيف (تحكيم، سرّية…)" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
          </div>
          <textarea className="cfg-prompt" style={{ minHeight: 120, marginTop: 8 }} placeholder="نصّ البند…" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          <div className="admin-actions" style={{ marginTop: 8 }}>
            <button className="btn-sm primary" onClick={save} disabled={busy}>{busy ? '…' : editing ? 'حفظ التعديل' : '＋ إضافة'}</button>
            {editing && <button className="btn-sm" onClick={() => { setEditing(null); setForm({ title: '', category: '', body: '' }); }}>إلغاء</button>}
          </div>
        </>
      )}

      <div className="section-title">البنود ({items.length})</div>
      {items.length === 0 ? (
        <div className="empty-state">لا بنود بعد.</div>
      ) : (
        items.map((cl) => (
          <div key={cl.id} className="version-row">
            <div>
              <strong>{cl.title}</strong>
              {cl.category && <span className="pill pending" style={{ marginInlineStart: 8 }}>{cl.category}</span>}
            </div>
            <div style={{ fontSize: '0.875rem', color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>{cl.body.slice(0, 260)}{cl.body.length > 260 ? '…' : ''}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {mode === 'pick' ? (
                <button className="btn-sm primary" onClick={() => onPick?.(cl)}>إدراج في الصياغة</button>
              ) : (
                <>
                  <button className="btn-sm" onClick={() => startEdit(cl)}>تعديل</button>
                  <button className="btn-sm" onClick={() => confirm('حذف البند؟') && api.deleteClause(cl.id).then(load)}>حذف</button>
                </>
              )}
            </div>
          </div>
        ))
      )}
    </>
  );

  if (mode === 'admin') return <div>{body}</div>;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card intake" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">📚 بنك البنود</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ padding: 18 }}>{body}</div>
      </div>
    </div>
  );
}
