/* ============================================================
   أدوات الذكاء الاصطناعي — قسم العضو، وتبويبُ لوحة الإدارة.

   العضو يربط أداته (Claude، ChatGPT…) برابط الربط، فتبحث في أنظمة المنصة
   وتحفظ إجاباتها في محادثاته. وهنا يجد الرابط، ويرى أدواته، ويلغي ربطها.
   والمسؤول يضيف الضيوف ويرى كلَّ ربطٍ ويلغيه.

   كل نصٍّ هنا من naf-terms.md §١٥، وكل أيقونة من naf-icons.md عبر خريطة
   lib/icons: `aiTool` (Plug) للأداة، و`guest` (UserRound) للضيف، و
   `connected`/`disconnected` لحالها — الحالتان المسجّلتان وحدهما.
   ============================================================ */

import { useEffect, useState } from 'react';
import { api, McpConnection, McpGuest } from '../lib/api';
import { formatDate } from '../lib/format';
import { Icon, ICON_SM, ICON_MD } from '../lib/icons';
import { modalCardProps, useModalDismiss } from '../lib/modal';
import ErrorBox from './ErrorBox';

/** «مربوط» أو «غير مربوط» — أيقونة ونصّ، لا لونٌ وحده (§6). */
function StatusPill({ status }: { status: 'connected' | 'not_connected' }) {
  return status === 'connected' ? (
    <span className="pill ready">
      <Icon.connected size={ICON_SM} aria-hidden /> مربوط
    </span>
  ) : (
    <span className="pill pending">
      <Icon.disconnected size={ICON_SM} aria-hidden /> غير مربوط
    </span>
  );
}

/** اسمُ الأداة بيانات لا مصطلح — كما أعلنته عن نفسها، معزولاً. */
function ToolName({ name }: { name: string | null }) {
  return (
    <span className="mcp-tool-name">
      <Icon.aiTool size={ICON_SM} aria-hidden />
      {name ? <bdi>{name}</bdi> : 'أداة مربوطة'}
    </span>
  );
}

const dateCell = (v: number | null) => (v ? <bdi>{formatDate(v)}</bdi> : '—');

/** رابط الربط مع زرّ نسخه — «نسخ الرابط» ثم «تم النسخ» (§١ و§١٥). */
function ConnectUrl() {
  const url = `${window.location.origin}/mcp`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* الحافظة محجوبة: الرابط ظاهرٌ في الحقل ويُحدَّد باليد. */
    }
  };
  return (
    <div className="mcp-url">
      <label className="mcp-url-label" htmlFor="mcp-url">
        رابط الربط
      </label>
      <div className="mcp-url-row">
        <div className="field mcp-url-field">
          <input id="mcp-url" value={url} readOnly dir="ltr" onFocus={(e) => e.currentTarget.select()} />
        </div>
        <button className="btn-sm primary" onClick={copy}>
          <Icon.copy size={ICON_SM} aria-hidden /> {copied ? 'تم النسخ' : 'نسخ الرابط'}
        </button>
      </div>
      <span className="sr-only" role="status">
        {copied ? 'تم النسخ' : ''}
      </span>
    </div>
  );
}

/** قسم العضو: الرابط، وأدواته المربوطة، وإلغاء ربطها. */
export function AiToolsMember() {
  const [rows, setRows] = useState<McpConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api
      .mcpConnections()
      .then((r) => setRows(r.connections))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const revoke = async (id: string) => {
    setError('');
    setStatus('');
    setBusy(id);
    try {
      await api.mcpRevoke(id);
      setStatus('تم إلغاء الربط');
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="admin-wrap">
      <div className="admin-inner">
        <h1 className="admin-title">أدوات الذكاء الاصطناعي</h1>
        <p className="mcp-lead">
          انسخ رابط الربط والصقه في أداة الذكاء الاصطناعي التي تستعملها — في خانة الموصّلات المخصّصة أو خوادم{' '}
          <bdi>MCP</bdi> — لتبحث في أنظمة المنصة وتحفظ إجاباتها في محادثاتك.
        </p>
        <ConnectUrl />

        <ErrorBox message={error} />
        {status && (
          <p className="mcp-status" role="status">
            <Icon.approved size={ICON_SM} aria-hidden /> {status}
          </p>
        )}

        {loading ? (
          <div className="center-load">
            <div className="spinner" />
          </div>
        ) : rows.length === 0 ? (
          <div className="empty-state">لم تربط أداةً بعد. انسخ رابط الربط والصقه في أداتك لتبدأ.</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>الأداة</th>
                  <th>تاريخ الربط</th>
                  <th>آخر نشاط</th>
                  <th>الحالة</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <ToolName name={r.client_name} />
                    </td>
                    <td>{dateCell(r.created_at)}</td>
                    <td>{dateCell(r.last_used_at)}</td>
                    <td>
                      <StatusPill status={r.status} />
                    </td>
                    <td>
                      {r.status === 'connected' && (
                        <button className="btn-sm" disabled={busy === r.id} onClick={() => revoke(r.id)}>
                          إلغاء الربط
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** تأكيدُ حذف الضيف — يسمّي الأثر: كلُّ ربطٍ له يُلغى فوراً (§١٥). */
function RemoveGuestModal({ guest, onCancel, onConfirm }: { guest: McpGuest; onCancel: () => void; onConfirm: () => void }) {
  useModalDismiss(onCancel);
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card intake" {...modalCardProps}>
        <div className="modal-head">
          <span className="modal-title">حذف</span>
          <button className="modal-close" onClick={onCancel} title="إغلاق">
            <Icon.close size={ICON_MD} aria-hidden />
          </button>
        </div>
        <div className="modal-body intake-body">
          <p className="mcp-muted">
            <bdi>{guest.email}</bdi>
          </p>
          <p>سيُحذف بريد الضيف، ويُلغى كلُّ ربطٍ له فوراً.</p>
        </div>
        <div className="modal-foot">
          <button className="btn-sm" onClick={onCancel}>
            إلغاء
          </button>
          <button className="btn-sm primary" onClick={onConfirm}>
            حذف
          </button>
        </div>
      </div>
    </div>
  );
}

/** تبويبُ لوحة الإدارة: الضيوف، والأدوات المربوطة لكل الأعضاء والضيوف. */
export function AiToolsAdmin() {
  const [guests, setGuests] = useState<McpGuest[]>([]);
  const [rows, setRows] = useState<McpConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<McpGuest | null>(null);

  const load = () => {
    setLoading(true);
    Promise.all([api.mcpGuests(), api.mcpAdminConnections()])
      .then(([g, c]) => {
        setGuests(g.guests);
        setRows(c.connections);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setError('');
    setStatus('');
    setBusy(key);
    try {
      await fn();
      setStatus(done);
      load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await run('add', () => api.mcpAddGuest(email), 'تمت الإضافة')) setEmail('');
  };

  if (loading) {
    return (
      <div className="center-load">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div>
      {pendingRemove && (
        <RemoveGuestModal
          guest={pendingRemove}
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => {
            const g = pendingRemove;
            setPendingRemove(null);
            run(g.id, () => api.mcpRemoveGuest(g.id), 'تم الحذف');
          }}
        />
      )}

      <ErrorBox message={error} />
      {status && (
        <p className="mcp-status" role="status">
          <Icon.approved size={ICON_SM} aria-hidden /> {status}
        </p>
      )}

      <div className="section-title mcp-section">
        <Icon.guest size={ICON_SM} aria-hidden /> الضيوف
      </div>
      <p className="mcp-lead">
        الضيف يربط أداته ببريده ورمز تحقق، فيقرأ الأنظمة واللوائح ومكتبة البنود ولا يُحفظ له شيء. لا حساب له في المنصة.
      </p>
      <form className="mcp-guest-form" onSubmit={add}>
        <div className="field">
          <label htmlFor="mcp-guest-email">البريد الإلكتروني</label>
          <input
            id="mcp-guest-email"
            type="email"
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
            required
          />
        </div>
        <button className="btn-sm primary" type="submit" disabled={busy === 'add' || !email.trim()}>
          <Icon.add size={ICON_SM} aria-hidden /> إضافة ضيف
        </button>
      </form>

      {guests.length === 0 ? (
        <div className="empty-state">لا ضيوف بعد. أضف بريد من تريد أن يربط أداته بالمنصة.</div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>البريد الإلكتروني</th>
                <th>تاريخ الإضافة</th>
                <th>الحالة</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {guests.map((g) => (
                <tr key={g.id}>
                  <td>
                    <bdi>{g.email}</bdi>
                  </td>
                  <td>{dateCell(g.created_at)}</td>
                  <td>
                    <StatusPill status={g.status} />
                  </td>
                  <td>
                    <button className="btn-sm" disabled={busy === g.id} onClick={() => setPendingRemove(g)} title="حذف">
                      <Icon.delete size={ICON_SM} aria-hidden /> حذف
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="section-title mcp-section">
        <Icon.aiTool size={ICON_SM} aria-hidden /> الأدوات المربوطة
      </div>
      {rows.length === 0 ? (
        <div className="empty-state">لم يربط أحدٌ أداةً بعد.</div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>صاحب الربط</th>
                <th>الأداة</th>
                <th>تاريخ الربط</th>
                <th>آخر نشاط</th>
                <th>الحالة</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="mcp-tool-name">
                      {r.subject_kind === 'guest' && <Icon.guest size={ICON_SM} aria-label="ضيف" />}
                      <bdi>{r.owner_name ?? '—'}</bdi>
                    </span>
                  </td>
                  <td>
                    <ToolName name={r.client_name} />
                  </td>
                  <td>{dateCell(r.created_at)}</td>
                  <td>{dateCell(r.last_used_at)}</td>
                  <td>
                    <StatusPill status={r.status} />
                  </td>
                  <td>
                    {r.status === 'connected' && (
                      <button
                        className="btn-sm"
                        disabled={busy === r.id}
                        onClick={() => run(r.id, () => api.mcpAdminRevoke(r.id), 'تم إلغاء الربط')}
                      >
                        إلغاء الربط
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
