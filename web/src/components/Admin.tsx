import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

type Tab = 'kb' | 'tracking' | 'users' | 'audit';

export default function Admin() {
  const [tab, setTab] = useState<Tab>('kb');
  return (
    <div className="admin-wrap">
      <div className="admin-inner">
        <h1 style={{ fontSize: 24, marginTop: 0 }}>لوحة الإدارة</h1>
        <div className="admin-tabs">
          <button className={`admin-tab ${tab === 'kb' ? 'active' : ''}`} onClick={() => setTab('kb')}>
            قاعدة المعرفة
          </button>
          <button className={`admin-tab ${tab === 'tracking' ? 'active' : ''}`} onClick={() => setTab('tracking')}>
            تتبّع الأنظمة
          </button>
          <button className={`admin-tab ${tab === 'users' ? 'active' : ''}`} onClick={() => setTab('users')}>
            المستخدمون
          </button>
          <button className={`admin-tab ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>
            سجل التدقيق
          </button>
        </div>
        {tab === 'kb' && <KbTab />}
        {tab === 'tracking' && <TrackingTab />}
        {tab === 'users' && <UsersTab />}
        {tab === 'audit' && <AuditTab />}
      </div>
    </div>
  );
}

function statusPill(s: string) {
  const map: Record<string, [string, string]> = {
    active: ['active', 'ساري'],
    amended: ['warn', 'معدَّل'],
    repealed: ['error', 'ملغى'],
    ready: ['ready', 'جاهز'],
    pending: ['pending', 'قيد المعالجة'],
    processing: ['pending', 'جارٍ'],
    error: ['error', 'خطأ'],
  };
  const [cls, label] = map[s] ?? ['pending', s];
  return <span className={`pill ${cls}`}>{label}</span>;
}

function KbTab() {
  const [docs, setDocs] = useState<any[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = () => api.kbDocuments().then((r) => setDocs(r.documents)).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 5000); // تحديث حالة التضمين
    return () => clearInterval(t);
  }, []);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        const fd = new FormData();
        fd.append('file', f);
        const res = await fetch('/api/kb/documents', { method: 'POST', body: fd, credentials: 'same-origin' });
        if (!res.ok) throw new Error((await res.json()).error);
      }
      load();
    } catch (e: any) {
      alert(e.message ?? 'فشل الرفع');
    } finally {
      setUploading(false);
    }
  };

  const del = async (id: string) => {
    if (!confirm('حذف هذه الوثيقة ومتجهاتها؟')) return;
    await api.deleteKbDocument(id);
    load();
  };

  return (
    <div>
      <input
        ref={fileInput}
        type="file"
        hidden
        multiple
        accept=".pdf,.docx,.txt,.md"
        onChange={(e) => {
          upload(e.target.files);
          e.target.value = '';
        }}
      />
      <div className="dropzone" onClick={() => fileInput.current?.click()}>
        {uploading ? (
          <>
            <span className="spinner" /> جارٍ الرفع والتصنيف…
          </>
        ) : (
          <>📤 ارفع وثيقة نظام/لائحة — سيُصنَّف محتواها ويُضمَّن تلقائيًا</>
        )}
      </div>

      {docs.length === 0 ? (
        <div className="empty-state">لا توجد وثائق في قاعدة المعرفة بعد</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>النظام</th>
              <th>التصنيف</th>
              <th>الجهة</th>
              <th>الحالة</th>
              <th>التضمين</th>
              <th>المقاطع</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <td style={{ fontWeight: 600 }}>
                  {d.title}
                  {d.needs_update ? <span className="pill warn" style={{ marginInlineStart: 6 }}>يحتاج مراجعة</span> : null}
                </td>
                <td>{d.category ?? '—'}</td>
                <td>{d.source_authority ?? '—'}</td>
                <td>{statusPill(d.status)}</td>
                <td>{statusPill(d.ingest_status)}</td>
                <td>{d.chunk_count ?? 0}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn-sm" onClick={() => api.reingestKbDocument(d.id).then(load)}>
                    إعادة تضمين
                  </button>{' '}
                  <button className="btn-sm" onClick={() => del(d.id)}>
                    حذف
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TrackingTab() {
  const [data, setData] = useState<{ needs_update: any[]; new_suggested: any[] }>({ needs_update: [], new_suggested: [] });
  const [scanning, setScanning] = useState(false);

  const load = () => api.tracking().then(setData).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  const scan = async () => {
    setScanning(true);
    try {
      const r = await api.scanTracking();
      alert(`اكتمل الفحص: فُحص ${r.checked} نظامًا، وُضِعت علامة على ${r.flagged}.`);
      load();
    } catch (e: any) {
      alert(e.message ?? 'فشل الفحص');
    } finally {
      setScanning(false);
    }
  };

  return (
    <div>
      <div className="admin-actions">
        <button className="btn-sm primary" onClick={scan} disabled={scanning}>
          {scanning ? <><span className="spinner" /> جارٍ الفحص…</> : '🔄 تشغيل فحص التتبّع الآن'}
        </button>
      </div>

      <div className="section-title">أنظمة تحتاج تحديثًا</div>
      {data.needs_update.length === 0 ? (
        <div className="empty-state">لا توجد تنبيهات — كل الأنظمة محدَّثة.</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>النظام</th>
              <th>ملخّص التغيير المكتشَف</th>
              <th>آخر فحص</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.needs_update.map((t) => (
              <tr key={t.id}>
                <td style={{ fontWeight: 600 }}>{t.title}</td>
                <td>{t.change_summary}</td>
                <td>{t.last_checked ? new Date(t.last_checked).toLocaleDateString('ar-SA') : '—'}</td>
                <td>
                  <button className="btn-sm" onClick={() => api.resolveTracking(t.id).then(load)}>
                    اعتمدت المراجعة
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="section-title">أنظمة جديدة مقترَح إضافتها</div>
      {data.new_suggested.length === 0 ? (
        <div className="empty-state">لا توجد اقتراحات حاليًا.</div>
      ) : (
        <table className="data-table">
          <tbody>
            {data.new_suggested.map((t) => (
              <tr key={t.id}>
                <td>{t.change_summary}</td>
                <td>
                  <button className="btn-sm" onClick={() => api.resolveTracking(t.id).then(load)}>
                    تجاهل
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function UsersTab() {
  const [users, setUsers] = useState<any[]>([]);
  const load = () => api.users().then((r) => setUsers(r.users)).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>الاسم</th>
          <th>البريد</th>
          <th>الدور</th>
          <th>تاريخ الإنشاء</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {users.map((u) => (
          <tr key={u.id}>
            <td>{u.name ?? '—'}</td>
            <td dir="ltr" style={{ textAlign: 'right' }}>{u.email}</td>
            <td>
              <span className={`pill ${u.role === 'admin' ? 'active' : 'pending'}`}>
                {u.role === 'admin' ? 'مسؤول' : 'مستخدم'}
              </span>
            </td>
            <td>{new Date(u.created_at).toLocaleDateString('ar-SA')}</td>
            <td>
              <button
                className="btn-sm"
                onClick={() => api.setRole(u.id, u.role === 'admin' ? 'user' : 'admin').then(load)}
              >
                {u.role === 'admin' ? 'إلغاء المسؤولية' : 'ترقية لمسؤول'}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AuditTab() {
  const [entries, setEntries] = useState<any[]>([]);
  useEffect(() => {
    api.audit().then((r) => setEntries(r.entries)).catch(() => {});
  }, []);

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>الفاعل</th>
          <th>الفعل</th>
          <th>الهدف</th>
          <th>الوقت</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id}>
            <td dir="ltr" style={{ textAlign: 'right' }}>{e.actor_email ?? e.actor_id ?? '—'}</td>
            <td><code>{e.action}</code></td>
            <td style={{ fontSize: 12, color: 'var(--muted)' }}>{e.target}</td>
            <td>{new Date(e.created_at).toLocaleString('ar-SA')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
