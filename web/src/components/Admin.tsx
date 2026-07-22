import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

type Tab = 'kb' | 'tracking' | 'news' | 'analytics' | 'users' | 'settings' | 'audit';

const TABS: [Tab, string][] = [
  ['kb', 'قاعدة المعرفة'],
  ['tracking', 'تتبّع الأنظمة'],
  ['news', 'خلاصة الأخبار'],
  ['analytics', 'التحليلات'],
  ['users', 'المستخدمون'],
  ['settings', 'الإعدادات'],
  ['audit', 'سجل التدقيق'],
];

export default function Admin() {
  const [tab, setTab] = useState<Tab>('kb');
  return (
    <div className="admin-wrap">
      <div className="admin-inner">
        <h1 style={{ fontSize: 24, marginTop: 0 }}>لوحة الإدارة</h1>
        <div className="admin-tabs">
          {TABS.map(([t, label]) => (
            <button key={t} className={`admin-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </div>
        {tab === 'kb' && <KbTab />}
        {tab === 'tracking' && <TrackingTab />}
        {tab === 'news' && <NewsTab />}
        {tab === 'analytics' && <AnalyticsTab />}
        {tab === 'users' && <UsersTab />}
        {tab === 'settings' && <SettingsTab />}
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
  const [versionsFor, setVersionsFor] = useState<string | null>(null);
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
              <Fragment key={d.id}>
                <tr>
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
                    <VersionUpload docId={d.id} version={d.version} onDone={load} />{' '}
                    <button className="btn-sm" onClick={() => setVersionsFor(versionsFor === d.id ? null : d.id)}>
                      السجل{d.version > 1 ? ` (${d.version})` : ''}
                    </button>{' '}
                    <button className="btn-sm" onClick={() => api.reingestKbDocument(d.id).then(load)}>
                      إعادة تضمين
                    </button>{' '}
                    <button className="btn-sm" onClick={() => del(d.id)}>
                      حذف
                    </button>
                  </td>
                </tr>
                {versionsFor === d.id && (
                  <tr>
                    <td colSpan={7} style={{ background: 'var(--surface-2)' }}>
                      <VersionsList docId={d.id} />
                    </td>
                  </tr>
                )}
              </Fragment>
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
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('user');
  const [busy, setBusy] = useState(false);
  const load = () => api.users().then((r) => setUsers(r.users)).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  const addUser = async () => {
    if (!email.trim()) return alert('أدخل البريد الإلكتروني');
    setBusy(true);
    try {
      const r = await api.createUser(email.trim(), role, name.trim() || undefined);
      alert(`أُنشئ الحساب.\nكلمة المرور الافتراضية: ${r.default_password}\nسيُطلب من المستخدم تغييرها عند أول دخول.`);
      setEmail(''); setName(''); setRole('user');
      load();
    } catch (e: any) {
      alert(e.message ?? 'فشل إنشاء الحساب');
    } finally {
      setBusy(false);
    }
  };

  const reset = async (id: string) => {
    if (!confirm('إعادة تعيين كلمة المرور إلى 1234؟')) return;
    const r = await api.resetPassword(id);
    alert(`أُعيد التعيين. كلمة المرور الافتراضية: ${r.default_password}`);
    load();
  };

  const del = async (id: string) => {
    if (!confirm('حذف هذا المستخدم نهائيًا؟')) return;
    try { await api.deleteUser(id); load(); } catch (e: any) { alert(e.message); }
  };

  return (
    <div>
      <div className="section-title">إضافة مستخدم</div>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 0 }}>
        يُنشأ الحساب بكلمة المرور الافتراضية <strong>1234</strong>، ويُطلب من المستخدم تغييرها عند أول دخول.
      </p>
      <div className="user-add-row">
        <input placeholder="البريد الإلكتروني" value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" style={{ textAlign: 'right' }} />
        <input placeholder="الاسم (اختياري)" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="user">مستخدم</option>
          <option value="admin">مسؤول</option>
        </select>
        <button className="btn-sm primary" onClick={addUser} disabled={busy}>
          {busy ? '…' : '＋ إضافة'}
        </button>
      </div>

      <div className="section-title">المستخدمون</div>
      <table className="data-table">
        <thead>
          <tr>
            <th>الاسم</th>
            <th>البريد</th>
            <th>الدور</th>
            <th>الحالة</th>
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
              <td>
                {u.must_change_password
                  ? <span className="pill warn">بانتظار تغيير كلمة المرور</span>
                  : <span className="pill ready">نشط</span>}
              </td>
              <td>{new Date(u.created_at).toLocaleDateString('ar-SA')}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="btn-sm" onClick={() => api.setRole(u.id, u.role === 'admin' ? 'user' : 'admin').then(load)}>
                  {u.role === 'admin' ? 'إلغاء المسؤولية' : 'ترقية لمسؤول'}
                </button>{' '}
                <button className="btn-sm" onClick={() => reset(u.id)}>تصفير كلمة المرور</button>{' '}
                <button className="btn-sm" onClick={() => del(u.id)}>حذف</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// رفع نسخة جديدة من نظام (مع أرشفة القديمة) — §5
function VersionUpload({ docId, version, onDone }: { docId: string; version: number; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      fd.append('note', `النسخة ${version + 1}`);
      const res = await fetch(`/api/kb/documents/${docId}/versions`, { method: 'POST', body: fd, credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json()).error);
      onDone();
    } catch (e: any) {
      alert(e.message ?? 'فشل رفع النسخة');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <input ref={ref} type="file" hidden accept=".pdf,.docx,.txt,.md" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
      <button className="btn-sm" onClick={() => ref.current?.click()} disabled={busy} title="رفع نسخة أحدث وأرشفة الحالية">
        {busy ? '…' : '⬆ نسخة جديدة'}
      </button>
    </>
  );
}

// عرض سجل إصدارات نظام — §5
function VersionsList({ docId }: { docId: string }) {
  const [versions, setVersions] = useState<any[] | null>(null);
  useEffect(() => {
    api.kbVersions(docId).then((r) => setVersions(r.versions)).catch(() => setVersions([]));
  }, [docId]);
  if (versions === null) return <span className="spinner" />;
  if (!versions.length) return <span style={{ color: 'var(--muted)', fontSize: 13 }}>لا إصدارات سابقة — هذه النسخة الأولى.</span>;
  return (
    <div style={{ fontSize: 13 }}>
      <strong style={{ fontSize: 13.5 }}>سجل الإصدارات:</strong>
      <ul style={{ margin: '6px 0', paddingInlineStart: 18 }}>
        {versions.map((v) => (
          <li key={v.id} style={{ margin: '3px 0' }}>
            الإصدار {v.version}
            {v.effective_from ? ` · سريان من ${v.effective_from}` : ''}
            {v.effective_to ? ` · حتى ${v.effective_to}` : ' · (سارية)'}
            {v.note ? ` — ${v.note}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewsTab() {
  const [news, setNews] = useState<any[]>([]);
  const [scanning, setScanning] = useState(false);
  const load = () => api.news().then((r) => setNews(r.news)).catch(() => {});
  useEffect(() => { load(); }, []);
  const scan = async () => {
    setScanning(true);
    try { const r = await api.scanNews(); alert(`تم رصد ${r.found} عنصرًا جديدًا.`); load(); }
    catch (e: any) { alert(e.message ?? 'فشل'); } finally { setScanning(false); }
  };
  return (
    <div>
      <div className="admin-actions">
        <button className="btn-sm primary" onClick={scan} disabled={scanning}>
          {scanning ? <><span className="spinner" /> جارٍ الرصد…</> : '🔄 رصد أخبار جريدة أم القرى'}
        </button>
      </div>
      {news.length === 0 ? (
        <div className="empty-state">لا توجد عناصر خلاصة بعد. شغّل الرصد لجلب أحدث الأنظمة والتعديلات.</div>
      ) : (
        <table className="data-table">
          <thead><tr><th>العنوان</th><th>الملخّص</th><th>النوع</th><th></th></tr></thead>
          <tbody>
            {news.map((n) => (
              <tr key={n.id}>
                <td style={{ fontWeight: 600 }}>{n.url ? <a href={n.url} target="_blank" rel="noopener">{n.title}</a> : n.title}</td>
                <td style={{ fontSize: 12.5, color: 'var(--muted)' }}>{n.summary}</td>
                <td>{n.kind === 'new_regulation' ? 'نظام جديد' : n.kind === 'amendment' ? 'تعديل' : 'أخرى'}</td>
                <td><button className="btn-sm" onClick={() => api.ingestNews(n.id).then(() => alert('أُضيف لقاعدة المعرفة كمقترَح.'))}>استيعاب</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AnalyticsTab() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api.analytics().then(setData).catch(() => {}); }, []);
  if (!data) return <div className="empty-state"><span className="spinner" /></div>;
  const t = data.totals ?? {};
  const cost = (Number(t.cost) || 0).toFixed(2);
  return (
    <div>
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>آخر 30 يومًا</p>
      <div className="stat-row">
        <div className="stat-card"><div className="stat-val">{t.events ?? 0}</div><div className="stat-lbl">عملية</div></div>
        <div className="stat-card"><div className="stat-val">{((Number(t.in_tok) + Number(t.out_tok)) / 1000).toFixed(1)}k</div><div className="stat-lbl">إجمالي الرموز</div></div>
        <div className="stat-card"><div className="stat-val">${cost}</div><div className="stat-lbl">التكلفة التقديرية</div></div>
      </div>

      <div className="section-title">حسب نوع العملية</div>
      <table className="data-table">
        <thead><tr><th>العملية</th><th>العدد</th><th>التكلفة</th></tr></thead>
        <tbody>{(data.by_kind ?? []).map((k: any) => (
          <tr key={k.kind}><td>{k.kind}</td><td>{k.n}</td><td>${(Number(k.cost) || 0).toFixed(3)}</td></tr>
        ))}</tbody>
      </table>

      <div className="section-title">أكثر أنواع الاستشارات طلبًا</div>
      <table className="data-table">
        <thead><tr><th>النوع</th><th>العدد</th></tr></thead>
        <tbody>{(data.by_type ?? []).map((k: any) => (
          <tr key={k.consultation_type}><td>{k.consultation_type}</td><td>{k.n}</td></tr>
        ))}</tbody>
      </table>

      <div className="section-title">الاستهلاك حسب المستخدم</div>
      <table className="data-table">
        <thead><tr><th>المستخدم</th><th>العمليات</th><th>التكلفة</th></tr></thead>
        <tbody>{(data.by_user ?? []).map((u: any, i: number) => (
          <tr key={i}><td dir="ltr" style={{ textAlign: 'right' }}>{u.email ?? '—'}</td><td>{u.n}</td><td>${(Number(u.cost) || 0).toFixed(3)}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function SettingsTab() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [firmName, setFirmName] = useState('');
  const lhInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    api.settings().then((r) => { setSettings(r.settings); setFirmName(r.settings.firm_name ?? ''); }).catch(() => {});
  }, []);

  const saveFirm = async () => { await api.saveSettings({ firm_name: firmName }); alert('حُفظ.'); };

  const uploadLetterhead = async (f: File | undefined) => {
    if (!f) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await fetch('/api/admin/letterhead', { method: 'POST', body: fd, credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json()).error);
      alert('رُفعت رأسية الشركة. ستظهر في مخرجات Word.');
      api.settings().then((r) => setSettings(r.settings));
    } catch (e: any) { alert(e.message ?? 'فشل الرفع'); } finally { setUploading(false); }
  };

  return (
    <div style={{ maxWidth: 560 }}>
      <div className="section-title">اسم الشركة</div>
      <div className="field">
        <input value={firmName} onChange={(e) => setFirmName(e.target.value)} placeholder="شركة ناف القانونية" />
      </div>
      <button className="btn-sm primary" onClick={saveFirm}>حفظ</button>

      <div className="section-title">رأسية الشركة لقوالب Word (صورة A4)</div>
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>
        ارفع صورة رأسية (PNG/JPEG) لتظهر أعلى كل مستند Word مُصدَّر.
        {settings.letterhead_mime ? ' ✅ رأسية مرفوعة حاليًا.' : ' لا توجد رأسية بعد.'}
      </p>
      <input ref={lhInput} type="file" hidden accept="image/png,image/jpeg" onChange={(e) => { uploadLetterhead(e.target.files?.[0]); e.target.value = ''; }} />
      <button className="btn-sm primary" onClick={() => lhInput.current?.click()} disabled={uploading}>
        {uploading ? <><span className="spinner" /> جارٍ الرفع…</> : '📤 رفع صورة الرأسية'}
      </button>
    </div>
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
