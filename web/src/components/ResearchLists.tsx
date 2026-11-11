// ما يراجعه المحامون قبل أن يقرأه المحرّك: خريطة الإسناد، وقائمة المسائل.
//
// كلتاهما مسودّةٌ كتبها النموذج، والمحرّك لا يقرأ منهما إلا المعتمد: مدخلٌ في خريطة
// الإسناد يستكمل طبقةً في كل بحثٍ في مجاله، ومسألةٌ معتمدة توسَم بها الموادّ ويُحصر
// بها البحث. فالاعتماد هنا قرارٌ يغيّر ما يُسترجع، ويُسجَّل باسم من اتخذه.
//
// والمراجعة اعتمادٌ أو أرشفة أو تراجع — والتعديل في نصّ المدخل من المسار نفسه
// (`PATCH`) حين يُطلب؛ والنصوص الجديدة في `lib/researchTerms.ts`.
import { useEffect, useState } from 'react';
import { api, type GroundingEntry, type LegalIssue, type ReviewListStatus } from '../lib/api';
import { formatNumber } from '../lib/format';
import { Icon, ICON_SM } from '../lib/icons';
import { RT, LAYER_LABELS, untaggedUnit } from '../lib/researchTerms';

function StatusPill({ status }: { status: ReviewListStatus }) {
  if (status === 'approved') {
    return (
      <span className="pill success">
        <Icon.approved size={ICON_SM} aria-hidden /> معتمد
      </span>
    );
  }
  if (status === 'retired') {
    return (
      <span className="pill pending">
        <Icon.archived size={ICON_SM} aria-hidden /> مؤرشف
      </span>
    );
  }
  return (
    <span className="pill pending">
      <Icon.draft size={ICON_SM} aria-hidden /> مسودة
    </span>
  );
}

/**
 * أفعالُ المراجعة بحسب الحال: المسودّة تُعتمد أو تُؤرشف، والمعتمد يُتراجع عنه، والمؤرشف يُعتمد.
 * نصوصٌ بلا أيقونات كأزرار طابور مراجعة الموادّ (`LegalReview`): الحالُ تحمل أيقونتها في شارتها.
 */
function ReviewActions({
  status,
  busy,
  onSet,
}: {
  status: ReviewListStatus;
  busy: boolean;
  onSet: (s: ReviewListStatus) => void;
}) {
  return (
    <div className="review-list-actions">
      {status !== 'approved' && (
        <button type="button" className="btn-sm" disabled={busy} onClick={() => onSet('approved')}>
          اعتماد
        </button>
      )}
      {status === 'draft' && (
        <button type="button" className="btn-sm" disabled={busy} onClick={() => onSet('retired')}>
          أرشفة
        </button>
      )}
      {status === 'approved' && (
        <button type="button" className="btn-sm" disabled={busy} onClick={() => onSet('draft')}>
          تراجع
        </button>
      )}
    </div>
  );
}

function Counts({ items }: { items: { status: ReviewListStatus }[] }) {
  const n = (s: ReviewListStatus) => items.filter((i) => i.status === s).length;
  return (
    <div className="review-list-counts">
      <span className="pill pending">
        <Icon.draft size={ICON_SM} aria-hidden /> مسودة <bdi>{formatNumber(n('draft'))}</bdi>
      </span>
      <span className="pill success">
        <Icon.approved size={ICON_SM} aria-hidden /> معتمد <bdi>{formatNumber(n('approved'))}</bdi>
      </span>
      <span className="pill pending">
        <Icon.archived size={ICON_SM} aria-hidden /> مؤرشف <bdi>{formatNumber(n('retired'))}</bdi>
      </span>
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="research-memo-error" role="alert">
      <Icon.failed size={ICON_SM} aria-hidden /> {error}
    </p>
  );
}

const NETWORK_ERROR = 'تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة';

export function GroundingMapTab() {
  const [entries, setEntries] = useState<GroundingEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .groundingMap()
      .then((r) => setEntries(r.entries))
      .catch((e: any) => setError(e?.message ?? NETWORK_ERROR));
  useEffect(() => {
    void load();
  }, []);

  const set = async (id: string, status: ReviewListStatus) => {
    setBusy(id);
    setError(null);
    try {
      await api.setGroundingStatus(id, status);
      await load();
    } catch (e: any) {
      setError(e?.message ?? NETWORK_ERROR);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="section-title">{RT.groundingMap}</div>
      <p className="source-note">{RT.groundingMapNote}</p>
      <ErrorLine error={error} />
      {!entries ? (
        <p className="typing-note">
          <Icon.running size={ICON_SM} aria-hidden className="icon-spin" /> جارٍ التحميل
        </p>
      ) : (
        <>
          <Counts items={entries} />
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{RT.domainCol}</th>
                  <th>{RT.layerCol}</th>
                  <th>النظام</th>
                  <th>الحالة</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td>{e.domain}</td>
                    <td>{LAYER_LABELS[e.layer] ?? e.layer}</td>
                    <td>
                      <bdi>{e.law_title}</bdi>
                      {!e.law_id && (
                        <span className="review-list-warn">
                          <Icon.warning size={ICON_SM} aria-hidden /> غير موجود في قاعدة المعرفة
                        </span>
                      )}
                    </td>
                    <td>
                      <StatusPill status={e.status} />
                    </td>
                    <td>
                      <ReviewActions status={e.status} busy={busy === e.id} onSet={(s) => set(e.id, s)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export function IssuesTab() {
  const [issues, setIssues] = useState<LegalIssue[] | null>(null);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .legalIssues()
      .then((r) => {
        setIssues(r.issues);
        setPending(r.pending_articles);
      })
      .catch((e: any) => setError(e?.message ?? NETWORK_ERROR));
  useEffect(() => {
    void load();
  }, []);

  const set = async (key: string, status: ReviewListStatus) => {
    setBusy(key);
    setError(null);
    try {
      await api.setIssueStatus(key, status);
      await load();
    } catch (e: any) {
      setError(e?.message ?? NETWORK_ERROR);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="section-title">{RT.issuesList}</div>
      <p className="source-note">{RT.issuesNote}</p>
      <ErrorLine error={error} />
      {!issues ? (
        <p className="typing-note">
          <Icon.running size={ICON_SM} aria-hidden className="icon-spin" /> جارٍ التحميل
        </p>
      ) : (
        <>
          <Counts items={issues} />
          {issues.some((i) => i.status === 'approved') && pending > 0 && (
            <p className="typing-note">
              <Icon.running size={ICON_SM} aria-hidden className="icon-spin" />
              <bdi>{formatNumber(pending)}</bdi> {untaggedUnit}
            </p>
          )}
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{RT.issueCol}</th>
                  <th>{RT.layerCol}</th>
                  <th>الوصف</th>
                  <th>{RT.taggedCol}</th>
                  <th>الحالة</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {issues.map((i) => (
                  <tr key={i.key}>
                    <td className="review-list-strong">{i.label}</td>
                    <td>{LAYER_LABELS[i.layer] ?? i.layer}</td>
                    <td>{i.description}</td>
                    <td>
                      <bdi>{formatNumber(i.articles)}</bdi>
                    </td>
                    <td>
                      <StatusPill status={i.status} />
                    </td>
                    <td>
                      <ReviewActions status={i.status} busy={busy === i.key} onSet={(s) => set(i.key, s)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
