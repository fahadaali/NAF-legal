/* ============================================================
   إعدادات الأدوار — شاشة مدير المنصة.

   المصادقة مركزية والصلاحيات موزّعة: الأعضاء يصلون من المركز، والدور
   يُقرَّر هنا ولا شأن للمركز به. والمركز لا يُبلَّغ إلا بالتعطيل، ليظهر
   السبب للعضو في شبكته.

   كل نصّ هنا من naf-terms.md §١٠ «أعضاء المنصة وصلاحياتهم»، وكل أيقونة
   من naf-icons.md عبر خريطة lib/icons.
   ============================================================ */

import { useEffect, useState } from 'react';
import { api, Member, PlatformRole, ROLE_LABELS } from '../lib/api';
import { formatDate } from '../lib/format';
import { Icon, ICON_SM, ICON_MD } from '../lib/icons';

const ROLES = Object.keys(ROLE_LABELS) as PlatformRole[];

/**
 * سبب التعطيل. نافذةٌ بنمط المنصة لا `window.prompt`: الأخيرة نافذة
 * متصفح تفلت من الثيم والاتجاه ومن حالة التركيز الظاهرة، ولا وجود لها
 * في السجلّ. والسبب يُعرض للعضو في شبكة المركز كما كُتب، فلا يُرسَل فارغاً.
 */
function DeactivateModal({
  member,
  onCancel,
  onConfirm,
}: {
  member: Member;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  // الإغلاق بمفتاح الهروب — النافذة لا تحتجز المستخدم
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onCancel]);

  const submit = () => {
    if (!reason.trim()) {
      setError('اكتب سبب التعطيل — يُعرض للعضو في شبكته');
      return;
    }
    onConfirm(reason.trim());
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card intake" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          {/* التأكيد يسمّي الفعل والمفعول به، ولا يكتفي بسؤال عام */}
          <span className="modal-title">
            <Icon.disabled size={ICON_MD} aria-hidden /> تعطيل {member.display_name ?? member.email ?? ''}
          </span>
          <button className="modal-close" onClick={onCancel} title="إغلاق">
            <Icon.close size={ICON_MD} aria-hidden />
          </button>
        </div>

        <div className="modal-body intake-body">
          {error && (
            <div className="error-box" role="alert">
              <Icon.failed size={ICON_SM} aria-hidden />
              <span>{error}</span>
            </div>
          )}
          <div className="field">
            <label htmlFor="deactivate-reason">السبب</label>
            <textarea
              id="deactivate-reason"
              className="intake-textarea"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn-sm" onClick={onCancel}>
            إلغاء
          </button>
          {/* زرّ التأكيد يحمل اسم الفعل لا «نعم» */}
          <button className="btn-sm primary" onClick={submit}>
            تعطيل
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Members() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingOff, setPendingOff] = useState<Member | null>(null);

  const load = () => {
    setLoading(true);
    api
      .members()
      .then((r) => setMembers(r.members))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const changeRole = async (m: Member, role: PlatformRole) => {
    setError('');
    setBusy(m.user_id);
    try {
      await api.setMemberRole(m.user_id, role);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggleActive = async (m: Member, reason = '') => {
    setError('');
    setPendingOff(null);
    setBusy(m.user_id);
    try {
      const r = await api.setMemberActive(m.user_id, !m.is_active, reason);
      if (r.reported === false) {
        setError('عُطّل العضو في هذه المنصة، ولم يبلغ التعطيل المركز. أعد المحاولة');
      }
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="center-load">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="admin-inner">
      {pendingOff && (
        <DeactivateModal
          member={pendingOff}
          onCancel={() => setPendingOff(null)}
          onConfirm={(reason) => toggleActive(pendingOff, reason)}
        />
      )}

      <div className="section-title">
        <Icon.members size={ICON_SM} aria-hidden /> الأعضاء
      </div>

      {error && (
        <div className="error-box" role="alert">
          <Icon.failed size={ICON_SM} aria-hidden />
          <span>{error}</span>
        </div>
      )}

      {members.length === 0 ? (
        <div className="empty-state">لا أعضاء بعد. يظهر العضو هنا بعد أول دخول له.</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>الاسم</th>
              <th>البريد الإلكتروني</th>
              <th>الصلاحية</th>
              <th>الحالة</th>
              <th>آخر نشاط</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.user_id}>
                <td>{m.display_name ?? '—'}</td>
                {/* البريد لاتيني داخل صفحة عربية — يُعزل أو انقلب ترتيبه */}
                <td>
                  <bdi>{m.email ?? '—'}</bdi>
                </td>
                <td>
                  <select
                    className="folder-select"
                    value={m.role}
                    disabled={busy === m.user_id || m.is_self}
                    onChange={(e) => changeRole(m, e.target.value as PlatformRole)}
                    aria-label="الصلاحية"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {/* أيقونة ونصّ — لا حالة تُبلَّغ باللون وحده */}
                  {m.is_active ? (
                    <span className="pill ready">
                      <Icon.enabled size={ICON_SM} aria-hidden /> مفعّل
                    </span>
                  ) : (
                    <span className="pill pending">
                      <Icon.disabled size={ICON_SM} aria-hidden /> معطّل
                    </span>
                  )}
                </td>
                <td>{m.last_seen_at ? <bdi>{formatDate(m.last_seen_at)}</bdi> : '—'}</td>
                <td>
                  {!m.is_self && (
                    <button
                      className="btn-sm"
                      disabled={busy === m.user_id}
                      onClick={() => (m.is_active ? setPendingOff(m) : toggleActive(m))}
                    >
                      {m.is_active ? (
                        <>
                          <Icon.disabled size={ICON_SM} aria-hidden /> تعطيل
                        </>
                      ) : (
                        <>
                          <Icon.reactivate size={ICON_SM} aria-hidden /> تفعيل
                        </>
                      )}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
