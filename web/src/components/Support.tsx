import { useEffect, useState } from 'react';
import { api, RegulationRequest, RegulationRequestStatus } from '../lib/api';
import { formatDate } from '../lib/format';
import RegulationRequestModal from './RegulationRequestModal';
import { Icon, ICON_SM, ICON_LG } from '../lib/icons';

// شارة حالة الطلب: لون + أيقونة + نص — لا لون وحده (CLAUDE.md §6)
export function RequestStatusPill({ status }: { status: RegulationRequestStatus }) {
  if (status === 'approved')
    return (
      <span className="pill active">
        <Icon.approved size={ICON_SM} aria-hidden /> معتمد
      </span>
    );
  if (status === 'rejected')
    return (
      <span className="pill error">
        <Icon.rejected size={ICON_SM} aria-hidden /> مرفوض
      </span>
    );
  return (
    <span className="pill warn">
      <Icon.pendingReview size={ICON_SM} aria-hidden /> بانتظار المراجعة
    </span>
  );
}

// صفحة الدعم: طلبات المستخدم إلى مسؤول النظام
export default function Support() {
  const [requests, setRequests] = useState<RegulationRequest[]>([]);
  const [asking, setAsking] = useState(false);

  const load = () => api.regulationRequests().then((r) => setRequests(r.requests)).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="admin-wrap">
      <div className="admin-inner">
        <h1 style={{ fontSize: '1.5rem', marginTop: 0 }}>الدعم</h1>

        <div className="cards">
          <button className="card" onClick={() => setAsking(true)}>
            <div className="card-icon">
              <Icon.support size={ICON_LG} aria-hidden />
            </div>
            <div className="card-title">طلب إضافة نظام</div>
            <div className="card-desc">
              نظام أو لائحة تحتاجها في عملك وغير موجودة في قاعدة المعرفة. يصل الطلب إلى مسؤول النظام.
            </div>
          </button>
        </div>

        <div className="section-title">طلباتي</div>
        {requests.length === 0 ? (
          <div className="empty-state">لم ترفع أي طلب بعد. ابدأ بطلب إضافة أول نظام.</div>
        ) : (
          <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>النظام</th>
                <th>اللائحة التنفيذية</th>
                <th>الحالة</th>
                <th>ملاحظة مسؤول النظام</th>
                <th>تاريخ الطلب</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600 }}>
                    {r.url ? (
                      <a href={r.url} target="_blank" rel="noopener">
                        {r.name}
                      </a>
                    ) : (
                      r.name
                    )}
                  </td>
                  <td>
                    {r.has_bylaw ? (
                      r.bylaw_url ? (
                        <a href={r.bylaw_url} target="_blank" rel="noopener">
                          نعم
                        </a>
                      ) : (
                        'نعم'
                      )
                    ) : (
                      'لا'
                    )}
                  </td>
                  <td>
                    <RequestStatusPill status={r.status} />
                  </td>
                  <td style={{ color: 'var(--muted-foreground)' }}>{r.admin_note ?? '—'}</td>
                  <td>
                    <bdi>{formatDate(r.created_at)}</bdi>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {asking && (
        <RegulationRequestModal
          source="support"
          onClose={() => setAsking(false)}
          onDone={load}
        />
      )}
    </div>
  );
}
