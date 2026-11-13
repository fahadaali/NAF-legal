/* ============================================================
   ربط أداة ذكاءٍ اصطناعي — بابا الدخول وشاشة الإذن.

   تفتح الأداةُ `/oauth/authorize` فيُحوَّل صاحبها إلى `/connect/{الطلب}`:
   بابان، والعضو لا يمرّ بالثاني أبداً (naf-terms.md §١٥ «الدخول إلى الربط»).

   - **الباب** (`ConnectDoor`) عامٌّ بلا جلسة: يفتحه الضيف ولا حساب له.
     ومنه يذهب العضو إلى `/connect-member/{الطلب}` — خارج المسارات العامة،
     فيمرّ بوسيط الدخول ويدخل من المركز قبل أن يرى الإذن.
   - **الإذن** (`ConnectConsent`) للعضو بعد دخوله.

   والشاشتان تقولان الحدود قبل «سماح» لا بعده. والقارئ في الأداة قدرتُه
   قدرةُ الضيف بالضبط (`src/mcp/conversations.ts`)، فتُعرض له جملتا الضيف
   المسجّلتان لا جملةٌ ثالثة.

   ولا ترويسة ولا شريط: هي صفحةُ بابٍ في `auth-wrap` كصفحة الرفض.
   ============================================================ */

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Icon, ICON_SM, ICON_LG } from '../lib/icons';
import NafMark from './NafMark';

const T = {
  memberCan:
    'ستبحث الأداة في الأنظمة واللوائح وتصنيفاتها ومكتبة البنود، وتحفظ ما تنتجه من إجابات في محادثاتك على المنصة.',
  guestCan: 'ستبحث الأداة في الأنظمة واللوائح وتصنيفاتها ومكتبة البنود. لا يُحفظ شيءٌ في المنصة.',
  memberCannot: 'لا تصل الأداة إلى القضايا ولا الملفات ولا قاعدة المعرفة الداخلية، ولا تعدّل شيئاً سوى محادثاتك.',
  guestCannot: 'لا تصل الأداة إلى شيءٍ سوى الأنظمة واللوائح ومكتبة البنود.',
  revokeLater: 'تستطيع إلغاء الربط في أي وقت من «أدوات الذكاء الاصطناعي» في إعداداتك.',
  expired: 'انتهت مهلة طلب الربط. ابدأ الربط من أداتك من جديد.',
  serverError: 'حدث خطأ في النظام. أعد المحاولة بعد قليل',
};

/** «ربط ‹الأداة› بمستشار ناف» — والاسم المجهول يسقط إلى «أداتك» (§١٥). */
function Title({ name }: { name: string | null }) {
  return (
    <h1 className="connect-title">
      ربط {name ? <bdi>{name}</bdi> : 'أداتك'} بمستشار ناف
    </h1>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-wrap">
      <div className="auth-card connect-card">
        <div className="auth-brand">
          <NafMark />
        </div>
        {children}
      </div>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="error-box" role="alert">
      <Icon.failed size={ICON_SM} aria-hidden />
      <span>{message}</span>
    </div>
  );
}

/** ما تستطيعه الأداة وما لا تستطيعه — قبل «سماح». */
function Scope({ can, cannot, extra }: { can: string; cannot: string; extra?: string }) {
  return (
    <div className="connect-scope">
      <p>{can}</p>
      <p className="connect-muted">{cannot}</p>
      {extra && <p className="connect-muted">{extra}</p>}
    </div>
  );
}

/** خطأُ ردٍّ من الخادم: نصُّه المسجّل إن جاء، وإلا جملة خطأ النظام. */
async function readError(res: Response): Promise<{ message: string; expired: boolean; member: boolean }> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; expired?: boolean; member?: boolean };
  return { message: body.error || T.serverError, expired: !!body.expired, member: !!body.member };
}

/** يعيد صاحبه إلى أداته — والردّ يكتب «تم الربط» لمن بقي على الصفحة. */
function Done({ name, redirect }: { name: string | null; redirect: string }) {
  useEffect(() => {
    window.location.assign(redirect);
  }, [redirect]);
  return (
    <p className="connect-done" role="status">
      <Icon.connected size={ICON_SM} aria-hidden /> تم الربط. عُد إلى {name ? <bdi>{name}</bdi> : 'أداتك'} لتبدأ.
    </p>
  );
}

/** «إلغاء» — يعيد الأداة برفضٍ صريح (`access_denied`) فلا تبقى تنتظر. */
async function deny(requestId: string): Promise<void> {
  const res = await fetch(`/oauth/connect/${encodeURIComponent(requestId)}/deny`, { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as { redirect?: string };
  if (body.redirect) window.location.assign(body.redirect);
  else window.location.assign('/');
}

/** البابان — عامّة بلا جلسة. */
export function ConnectDoor({ requestId }: { requestId: string }) {
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [path, setPath] = useState<'choose' | 'guest'>('choose');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [redirect, setRedirect] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/oauth/connect/${encodeURIComponent(requestId)}`)
      .then(async (res) => {
        if (!res.ok) {
          const e = await readError(res);
          if (e.expired) setExpired(true);
          else setError(e.message);
          return;
        }
        const body = (await res.json()) as { client_name: string | null };
        setName(body.client_name);
      })
      .catch(() => setError(T.serverError))
      .finally(() => setLoading(false));
  }, [requestId]);

  const post = (step: 'code' | 'verify', payload: Record<string, string>) =>
    fetch(`/oauth/connect/${encodeURIComponent(requestId)}/guest/${step}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

  const sendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await post('code', { email });
      if (!res.ok) {
        const err = await readError(res);
        if (err.expired) setExpired(true);
        setError(err.message);
        return;
      }
      const body = (await res.json()) as { message: string };
      setSent(body.message);
    } catch {
      setError(T.serverError);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await post('verify', { email, code });
      if (!res.ok) {
        const err = await readError(res);
        if (err.expired) setExpired(true);
        setError(err.message);
        return;
      }
      const body = (await res.json()) as { redirect: string };
      setRedirect(body.redirect);
    } catch {
      setError(T.serverError);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="center-load">
        <div className="spinner" />
      </div>
    );
  }

  if (expired) {
    return (
      <Shell>
        <Icon.failed size={ICON_LG} className="denied-icon" aria-hidden />
        <p className="denied-reason" role="status">
          {T.expired}
        </p>
      </Shell>
    );
  }

  if (redirect) {
    return (
      <Shell>
        <Title name={name} />
        <Done name={name} redirect={redirect} />
      </Shell>
    );
  }

  return (
    <Shell>
      <Title name={name} />
      <ErrorBox message={error} />

      {path === 'choose' ? (
        <div className="connect-doors">
          {/* تنقّلٌ كامل لا نداء: الوسيط يحوّله إلى المركز ثم يعيده إلى الإذن. */}
          <a className="btn-primary connect-door" href={`/connect-member/${encodeURIComponent(requestId)}`}>
            عضو في ناف — تسجيل الدخول
          </a>
          <button className="btn-sm connect-door" onClick={() => setPath('guest')}>
            <Icon.guest size={ICON_SM} aria-hidden /> ضيف — الدخول برمز التحقق
          </button>
          <button className="btn-sm connect-cancel" onClick={() => deny(requestId)}>
            إلغاء
          </button>
        </div>
      ) : (
        <>
          <Scope can={T.guestCan} cannot={T.guestCannot} />
          {!sent ? (
            <form onSubmit={sendCode}>
              <div className="field">
                <label htmlFor="connect-email">البريد الإلكتروني</label>
                <input
                  id="connect-email"
                  type="email"
                  dir="ltr"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div className="connect-actions">
                <button className="btn-sm" type="button" onClick={() => deny(requestId)}>
                  إلغاء
                </button>
                <button className="btn-sm primary" type="submit" disabled={busy || !email.trim()}>
                  إرسال الرمز
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={verify}>
              <p className="connect-muted" role="status">
                {sent}
              </p>
              <div className="field">
                <label htmlFor="connect-code">رمز التحقق</label>
                <input
                  id="connect-code"
                  className="connect-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  dir="ltr"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  required
                  autoFocus
                />
              </div>
              <div className="connect-actions">
                <button className="btn-sm" type="button" onClick={() => deny(requestId)}>
                  إلغاء
                </button>
                <button className="btn-sm" type="button" disabled={busy} onClick={(e) => sendCode(e as unknown as React.FormEvent)}>
                  إرسال الرمز
                </button>
                <button className="btn-sm primary" type="submit" disabled={busy || code.length !== 6}>
                  سماح
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </Shell>
  );
}

/** الإذن للعضو — بعد دخوله من المركز. */
export function ConnectConsent({ requestId }: { requestId: string }) {
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState<string | null>(null);
  const [canSave, setCanSave] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [redirect, setRedirect] = useState<string | null>(null);

  useEffect(() => {
    api
      .mcpConnectInfo(requestId)
      .then((r) => {
        setName(r.client_name);
        setCanSave(r.can_save);
      })
      .catch((e: Error & { status?: number }) => {
        if (e.message === T.expired) setExpired(true);
        else setError(e.message || T.serverError);
      })
      .finally(() => setLoading(false));
  }, [requestId]);

  const allow = async () => {
    setError('');
    setBusy(true);
    try {
      const r = await api.mcpApprove(requestId);
      setRedirect(r.redirect);
    } catch (e) {
      const message = (e as Error).message;
      if (message === T.expired) setExpired(true);
      else setError(message || T.serverError);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="center-load">
        <div className="spinner" />
      </div>
    );
  }

  if (expired) {
    return (
      <Shell>
        <Icon.failed size={ICON_LG} className="denied-icon" aria-hidden />
        <p className="denied-reason" role="status">
          {T.expired}
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <Title name={name} />
      {redirect ? (
        <Done name={name} redirect={redirect} />
      ) : (
        <>
          <ErrorBox message={error} />
          <Scope
            can={canSave ? T.memberCan : T.guestCan}
            cannot={canSave ? T.memberCannot : T.guestCannot}
            extra={T.revokeLater}
          />
          <div className="connect-actions">
            <button className="btn-sm" onClick={() => deny(requestId)}>
              إلغاء
            </button>
            <button className="btn-sm primary" disabled={busy} onClick={allow}>
              سماح
            </button>
          </div>
        </>
      )}
    </Shell>
  );
}
