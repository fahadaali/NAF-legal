import { useEffect, useState } from 'react';
import { api } from '../lib/api';

// لوحة المواعيد النظامية: إضافة · متابعة · إنجاز
export default function Deadlines() {
  const [items, setItems] = useState<any[]>([]);
  const [status, setStatus] = useState('open');
  const [form, setForm] = useState({ title: '', kind: 'اعتراض', base_date: '', days: '', due_date: '', notes: '' });
  const [busy, setBusy] = useState(false);

  const load = () => api.deadlinesList(status).then((r) => setItems(r.deadlines)).catch(() => {});
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const add = async () => {
    if (!form.title.trim()) return alert('أدخل عنوان الموعد');
    if (!form.due_date && !(form.base_date && form.days)) {
      return alert('أدخل تاريخ الاستحقاق، أو تاريخ التبليغ مع عدد الأيام');
    }
    setBusy(true);
    try {
      await api.createDeadline(form);
      setForm({ title: '', kind: 'اعتراض', base_date: '', days: '', due_date: '', notes: '' });
      load();
    } catch (e: any) {
      alert(e.message ?? 'فشل الحفظ');
    } finally {
      setBusy(false);
    }
  };

  const daysLeft = (due: string) =>
    Math.ceil((new Date(due + 'T00:00:00Z').getTime() - new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime()) / 86400000);

  return (
    <div className="admin-wrap">
      <div className="admin-inner">
        <h1 style={{ fontSize: '1.5rem', marginTop: 0 }}>المواعيد النظامية</h1>
        <p className="source-note">
          تُحفظ المواعيد بالتقويمين الميلادي والهجري (أم القرى)، ويُنبّهك النظام تلقائيًا قبل ٧ و٣ ويوم واحد من الاستحقاق، وعند فوات الميعاد.
        </p>

        <div className="section-title">إضافة موعد</div>
        <div className="user-add-row">
          <input placeholder="العنوان (مثال: اعتراض على الحكم رقم…)" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={{ minWidth: 260 }} />
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {['اعتراض', 'استئناف', 'جلسة', 'تسليم مذكرة', 'أخرى'].map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <input placeholder="تاريخ التبليغ (هجري/ميلادي)" value={form.base_date} onChange={(e) => setForm({ ...form, base_date: e.target.value })} />
          <input placeholder="عدد الأيام" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} style={{ minWidth: 110 }} />
          <span style={{ color: 'var(--muted-foreground)', fontSize: '0.875rem' }}>أو</span>
          <input placeholder="تاريخ الاستحقاق مباشرة" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
          <button className="btn-sm primary" onClick={add} disabled={busy}>{busy ? '…' : '＋ إضافة'}</button>
        </div>

        <div className="admin-tabs" style={{ marginTop: 16 }}>
          {[['open', 'المفتوحة'], ['done', 'المنجزة'], ['all', 'الكل']].map(([v, l]) => (
            <button key={v} className={`admin-tab ${status === v ? 'active' : ''}`} onClick={() => setStatus(v)}>{l}</button>
          ))}
        </div>

        {items.length === 0 ? (
          <div className="empty-state">لا مواعيد.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr><th>العنوان</th><th>النوع</th><th>الاستحقاق</th><th>المتبقّي</th><th>القضية</th><th></th></tr>
            </thead>
            <tbody>
              {items.map((d) => {
                const left = daysLeft(d.due_date);
                return (
                  <tr key={d.id}>
                    <td style={{ fontWeight: 600 }}>{d.title}</td>
                    <td>{d.kind ?? '—'}</td>
                    <td dir="auto">{d.due_date}{d.due_hijri ? ` (${d.due_hijri})` : ''}</td>
                    <td>
                      {d.status !== 'open' ? <span className="pill pending">—</span>
                        : left < 0 ? <span className="pill error">فات بـ {Math.abs(left)} يوم</span>
                        : left === 0 ? <span className="pill warn">اليوم</span>
                        : left <= 3 ? <span className="pill warn">{left} يوم</span>
                        : <span className="pill ready">{left} يوم</span>}
                    </td>
                    <td>{d.folder_name ?? '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {d.status === 'open' && (
                        <button className="btn-sm" onClick={() => api.setDeadlineStatus(d.id, 'done').then(load)}>إنجاز</button>
                      )}{' '}
                      <button className="btn-sm" onClick={() => confirm('حذف الموعد؟') && api.deleteDeadline(d.id).then(load)}>حذف</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
