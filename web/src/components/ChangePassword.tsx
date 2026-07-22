import { useState } from 'react';
import { api } from '../lib/api';
import { Aurora } from '../App';

// شاشة تعيين كلمة مرور جديدة عند أول دخول (كلمة المرور الافتراضية 1234)
export default function ChangePassword({
  onDone,
  theme,
  onToggleTheme,
}: {
  onDone: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}) {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (pw.length < 6) return setError('كلمة المرور يجب ألا تقل عن 6 أحرف');
    if (pw !== confirm) return setError('كلمتا المرور غير متطابقتين');
    setBusy(true);
    try {
      await api.changePassword(pw);
      onDone();
    } catch (err: any) {
      setError(err.message ?? 'حدث خطأ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <Aurora />
      <button className="theme-toggle floating" onClick={onToggleTheme} title="تبديل السمة">
        {theme === 'dark' ? '☀️' : '🌙'}
      </button>
      <div className="auth-card">
        <div className="auth-brand">
          <img className="brand-logo-img" src="/logo.jpeg" alt="ناف" />
          <h1>تعيين كلمة مرور جديدة</h1>
          <p>لأول دخول، يرجى اختيار كلمة مرور جديدة تحلّ محل الافتراضية.</p>
        </div>

        {error && <div className="error-box">{error}</div>}

        <form onSubmit={submit}>
          <div className="field">
            <label>كلمة المرور الجديدة</label>
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="٦ أحرف على الأقل" required />
          </div>
          <div className="field">
            <label>تأكيد كلمة المرور</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="أعد إدخال كلمة المرور" required />
          </div>
          <button className="btn-primary" disabled={busy}>
            {busy ? '...' : 'حفظ والمتابعة'}
          </button>
        </form>
      </div>
    </div>
  );
}
