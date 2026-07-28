/* ============================================================
   المستخدمون والصلاحيات — شاشة مسؤول المنصة.

   المصادقة مركزية والصلاحيات موزّعة: الأعضاء يصلون من المركز، والصلاحية
   تُقرَّر هنا ولا شأن للمركز بها. والمركز لا يُبلَّغ إلا بسحب الوصول،
   ليظهر السبب للعضو في شبكته.

   كل نصّ هنا من naf-terms.md §١٠ «أعضاء المنصة»، وكل أيقونة من
   naf-icons.md عبر خريطة lib/icons. و«سحب» لا «تعطيل»: الأخيرة ممنوعة
   هناك صراحةً — «معطّل» تصف حالة العضوية لا الفعل الذي أنتجها.
   ============================================================ */

import { useEffect, useState } from 'react';
import { api, Member, PlatformRole, ROLE_LABELS } from '../lib/api';
import { formatDate } from '../lib/format';
import { Icon, ICON_SM, ICON_MD } from '../lib/icons';

const ROLES = Object.keys(ROLE_LABELS) as PlatformRole[];

/**
 * سبب سحب الوصول. نافذةٌ بنمط المنصة لا `window.prompt`: الأخيرة نافذة
 * متصفح تفلت من الثيم والاتجاه ومن حالة التركيز الظاهرة، ولا وجود لها
 * في السجلّ. والسبب يُعرض للعضو في شبكة المركز كما كُتب، فلا يُرسَل فارغاً.
 */
function RevokeModal({
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
      setError('اكتب سبب السحب — يُعرض للعضو في شبكته');
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
            سحب الوصول
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
          <p style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-sm)', marginTop: 0 }}>
            {member.display_name ?? member.email ?? ''}
          </p>
          <div className="field">
            <label htmlFor="revoke-reason">السبب</label>
            <textarea
              id="revoke-reason"
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
            سحب
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
  const [pendingRevoke, setPendingRevoke] = useState<Member | null>(null);

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
    setPendingRevoke(null);
    setBusy(m.user_id);
    try {
      const r = await api.setMemberActive(m.user_id, !m.is_active, reason);
      // النصّ المسجَّل في naf-terms.md §«شاشة أعضاء المنصة» للسحب وحده،
      // و`m.is_active` هي الحال قبل التبديل — فصدقُها هنا يعني أننا نسحب.
      //
      // وإعادة التفعيل صارت تُبلَّغ كذلك (انظر `routes/members.ts`)، ولا نصّ
      // مسجَّل لتعذّر تبليغها بعد. فلا يُعرض نصّ السحب في غير موضعه ولا
      // يُؤلَّف نصّ محلي — والمصطلح يُسجَّل في السجلّ أولاً.
      if (r.reported === false && m.is_active) {
        setError('سُحب الوصول في هذه المنصة، ولم يبلغ السحبُ المركزَ. أعد المحاولة');
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
      {pendingRevoke && (
        <RevokeModal
          member={pendingRevoke}
          onCancel={() => setPendingRevoke(null)}
          onConfirm={(reason) => toggleActive(pendingRevoke, reason)}
        />
      )}

      <div className="section-title">
        <Icon.permissions size={ICON_SM} aria-hidden /> المستخدمون والصلاحيات
      </div>
      <p style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-sm)', marginTop: 0 }}>
        العضوية تأتي من نظام الدخول الموحّد، والصلاحية تُقرّر هنا
      </p>

      {error && (
        <div className="error-box" role="alert">
          <Icon.failed size={ICON_SM} aria-hidden />
          <span>{error}</span>
        </div>
      )}

      {members.length === 0 ? (
        <div className="empty-state">لا أعضاء بعد. يظهر العضو هنا بعد أول دخول له.</div>
      ) : (
        <>
        <div className="section-title">
          <Icon.members size={ICON_SM} aria-hidden /> أعضاء المنصة
        </div>
        <p style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-sm)', marginTop: 0 }}>
          «مسؤول» يملك كل الصلاحيات · «محرّر» يعمل دون إدارة الأعضاء · «مستخدم (اطّلاع)» يطّلع فقط.
        </p>
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
                      onClick={() => (m.is_active ? setPendingRevoke(m) : toggleActive(m))}
                    >
                      {/* «منح» و«سحب» لا أيقونة لهما في naf-icons.md، فلا
                          تُختار لهما واحدة بالشبه. النصّ وحده — والشارة
                          المجاورة تحمل حالةَ العضو بأيقونتها المسجّلة. */}
                      {m.is_active ? 'سحب' : 'منح'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </>
      )}
    </div>
  );
}
