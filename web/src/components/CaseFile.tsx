import { useEffect, useState } from 'react';
import { api, Folder } from '../lib/api';
import { labelFor } from '../lib/consultations';
import { formatDate } from '../lib/format';
import { Icon, ICON_SM } from '../lib/icons';

// ملف القضية: عرض مجمّع لكل ما يتعلق بقضية + تصدير حزمة
export default function CaseFile({ onOpenConversation }: { onOpenConversation: (id: string) => void }) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [active, setActive] = useState<string>('');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.folders().then((r) => {
      setFolders(r.folders);
      if (r.folders.length && !active) setActive(r.folders[0].id);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!active) return;
    setLoading(true);
    api.caseFile(active).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }, [active]);

  return (
    <div className="admin-wrap">
      <div className="admin-inner">
        <h1 style={{ fontSize: '1.5rem', marginTop: 0 }}>ملف القضية</h1>

        {folders.length === 0 ? (
          <div className="empty-state">لا قضايا بعد. أنشئ قضية من الشريط الجانبي (＋) واربط بها محادثاتك.</div>
        ) : (
          <>
            <div className="user-add-row">
              <select value={active} onChange={(e) => setActive(e.target.value)} style={{ minWidth: 260 }}>
                {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              {active && (
                <a href={api.caseExportUrl(active)} download>
                  <button className="btn-sm primary"><Icon.export size={ICON_SM} aria-hidden /> تصدير حزمة القضية (ZIP)</button>
                </a>
              )}
            </div>

            {loading ? (
              <div className="empty-state"><span className="spinner" /></div>
            ) : !data ? (
              <div className="empty-state">تعذّر تحميل القضية.</div>
            ) : (
              <>
                <div className="stat-row" style={{ marginTop: 16 }}>
                  <div className="stat-card"><div className="stat-val"><bdi>{data.conversations.length}</bdi></div><div className="stat-lbl">محادثة</div></div>
                  <div className="stat-card"><div className="stat-val"><bdi>{data.drafts.length}</bdi></div><div className="stat-lbl">مسودّة</div></div>
                  <div className="stat-card"><div className="stat-val"><bdi>{data.attachments.length}</bdi></div><div className="stat-lbl">مرفق</div></div>
                </div>

                <div className="section-title">المواعيد النظامية</div>
                {data.deadlines.length === 0 ? (
                  <div className="empty-state" style={{ padding: 20 }}>لا مواعيد مرتبطة.</div>
                ) : (
                  <table className="data-table">
                    <tbody>
                      {data.deadlines.map((d: any) => (
                        <tr key={d.id}>
                          <td style={{ fontWeight: 600 }}>{d.title}</td>
                          <td>{d.kind ?? '—'}</td>
                          <td dir="auto">{d.due_date}{d.due_hijri ? ` (${d.due_hijri})` : ''}</td>
                          <td><span className={`pill ${d.status === 'open' ? 'warn' : 'ready'}`}>{d.status === 'open' ? 'مفتوح' : 'منجز'}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <div className="section-title">المحادثات</div>
                {data.conversations.length === 0 ? (
                  <div className="empty-state" style={{ padding: 20 }}>لا محادثات مرتبطة بهذه القضية.</div>
                ) : (
                  <table className="data-table">
                    <tbody>
                      {data.conversations.map((cv: any) => (
                        <tr key={cv.id}>
                          <td style={{ fontWeight: 600 }}>{cv.title}</td>
                          <td>{labelFor(cv.consultation_type)}</td>
                          <td><bdi>{formatDate(cv.updated_at)}</bdi></td>
                          <td><button className="btn-sm" onClick={() => onOpenConversation(cv.id)}>فتح</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <div className="section-title">المسوّدات</div>
                {data.drafts.length === 0 ? (
                  <div className="empty-state" style={{ padding: 20 }}>لا مسوّدات.</div>
                ) : (
                  <table className="data-table">
                    <tbody>
                      {data.drafts.map((d: any) => (
                        <tr key={d.id}>
                          <td>{labelFor(d.consultation_type)}</td>
                          <td style={{ fontSize: '0.875rem', color: 'var(--muted-foreground)' }}>{d.excerpt}…</td>
                          <td>{d.approved_at ? <span className="pill ready">معتمَدة</span> : <span className="pill pending">مسودّة</span>}</td>
                          <td><a href={api.exportUrl(d.id, 'docx')} download><button className="btn-sm">Word</button></a></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <div className="section-title">المرفقات</div>
                {data.attachments.length === 0 ? (
                  <div className="empty-state" style={{ padding: 20 }}>لا مرفقات.</div>
                ) : (
                  <table className="data-table">
                    <tbody>
                      {data.attachments.map((a: any) => (
                        <tr key={a.id}>
                          <td><Icon.attachment size={ICON_SM} aria-hidden /> <bdi>{a.filename}</bdi></td>
                          <td>{Math.round((a.size ?? 0) / 1024)} كيلوبايت</td>
                          <td><bdi>{formatDate(a.created_at)}</bdi></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
