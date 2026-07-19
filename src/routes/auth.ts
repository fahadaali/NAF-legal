// مسارات المصادقة: تسجيل، دخول، خروج، الحساب الحالي
import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { hashPassword, verifyPassword, signJwt, uuid } from '../lib/crypto';
import { requireAuth, SESSION_COOKIE } from '../lib/auth';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function setSession(c: any, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/register', async (c) => {
  const { email, password, name } = await c.req.json().catch(() => ({}));
  if (!email || !EMAIL_RE.test(email)) return c.json({ error: 'بريد إلكتروني غير صالح' }, 400);
  if (!password || password.length < 8) return c.json({ error: 'كلمة المرور يجب ألا تقل عن 8 أحرف' }, 400);

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return c.json({ error: 'البريد الإلكتروني مسجّل مسبقًا' }, 409);

  // أول مستخدم في النظام يصبح مسؤولًا تلقائيًا
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  const role = count && count.n === 0 ? 'admin' : 'user';

  const id = uuid();
  const hash = await hashPassword(password);
  await c.env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, role, name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(id, email, hash, role, name ?? null, Date.now())
    .run();

  const token = await signJwt({ sub: id, email, role, name }, c.env.JWT_SECRET);
  setSession(c, token);
  return c.json({ user: { id, email, role, name } });
});

app.post('/login', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}));
  if (!email || !password) return c.json({ error: 'البيانات ناقصة' }, 400);

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string; email: string; password_hash: string; role: string; name: string | null }>();

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: 'بيانات الدخول غير صحيحة' }, 401);
  }

  const token = await signJwt(
    { sub: user.id, email: user.email, role: user.role, name: user.name ?? undefined },
    c.env.JWT_SECRET
  );
  setSession(c, token);
  return c.json({ user: { id: user.id, email: user.email, role: user.role, name: user.name } });
});

app.post('/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

app.get('/me', requireAuth, (c) => {
  return c.json({ user: c.get('user') });
});

export default app;
