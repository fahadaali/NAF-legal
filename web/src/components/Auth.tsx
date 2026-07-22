import { useState } from 'react';
import { api, User } from '../lib/api';
import { Aurora } from '../App';

export default function Auth({ onAuth, theme, onToggleTheme }: { onAuth: (u: User) => void; theme: 'light' | 'dark'; onToggleTheme: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = mode === 'login' ? await api.login(email, password) : await api.register(email, password, name);
      onAuth(r.user);
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
          <h1>مستشار ناف</h1>
          <p>منصة الاستشارات القانونية الذكية</p>
        </div>

        {error && <div className="error-box">{error}</div>}

        <form onSubmit={submit}>
          {mode === 'register' && (
            <div className="field">
              <label>الاسم</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="الاسم الكامل" />
            </div>
          )}
          <div className="field">
            <label>البريد الإلكتروني</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              required
              dir="ltr"
              style={{ textAlign: 'right' }}
            />
          </div>
          <div className="field">
            <label>كلمة المرور</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="٨ أحرف على الأقل"
              required
            />
          </div>
          <button className="btn-primary" disabled={busy}>
            {busy ? '...' : mode === 'login' ? 'تسجيل الدخول' : 'إنشاء حساب'}
          </button>
        </form>

        <div className="auth-switch">
          {mode === 'login' ? (
            <>
              الحسابات يُنشئها مسؤول النظام. لأول تهيئة فقط:{' '}
              <button onClick={() => { setMode('register'); setError(''); }}>إنشاء حساب المسؤول الأول</button>
            </>
          ) : (
            <>
              لديك حساب بالفعل؟{' '}
              <button onClick={() => { setMode('login'); setError(''); }}>سجّل الدخول</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
