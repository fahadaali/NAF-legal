// مسارات المصادقة: تهيئة أول مسؤول، دخول، خروج، تغيير كلمة المرور، الحساب الحالي
// النموذج: المسؤول يضيف المستخدمين من لوحة التحكم بكلمة مرور افتراضية 1234،
// ويُطلب من المستخدم تغييرها عند أول دخول.
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

// تهيئة أول مسؤول فقط (حين تكون قاعدة المستخدمين فارغة). بعدها التسجيل الذاتي مغلق
// وتُنشأ الحسابات من لوحة الإدارة.
app.post('/register', async (c) => {
  if (!c.env.JWT_SECRET) {
    return c.json({ error: 'الخادم غير مهيّأ: لم يُضبط JWT_SECRET في إعدادات Cloudflare.' }, 503);
  }
  const { email, password, name } = await c.req.json().catch(() => ({}));
  if (!email || !EMAIL_RE.test(email)) return c.json({ error: 'بريد إلكتروني غير صالح' }, 400);
  if (!password || password.length < 8) return c.json({ error: 'كلمة المرور يجب ألا تقل عن 8 أحرف' }, 400);

  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  if (count && count.n > 0) {
    return c.json({ error: 'التسجيل الذاتي مغلق. تواصل مع مسؤول النظام لإنشاء حسابك.' }, 403);
  }

  const id = uuid();
  const hash = await hashPassword(password);
  await c.env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, role, name, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
  )
    .bind(id, email, hash, 'admin', name ?? null, Date.now())
    .run();

  const token = await signJwt({ sub: id, email, role: 'admin', name }, c.env.JWT_SECRET);
  setSession(c, token);
  return c.json({ user: { id, email, role: 'admin', name, must_change_password: false } });
});

app.post('/login', async (c) => {
  if (!c.env.JWT_SECRET) {
    return c.json({ error: 'الخادم غير مهيّأ: لم يُضبط JWT_SECRET في إعدادات Cloudflare.' }, 503);
  }
  const { email, password } = await c.req.json().catch(() => ({}));
  if (!email || !password) return c.json({ error: 'البيانات ناقصة' }, 400);

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string; email: string; password_hash: string; role: string; name: string | null; must_change_password: number }>();

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: 'بيانات الدخول غير صحيحة' }, 401);
  }

  const token = await signJwt(
    { sub: user.id, email: user.email, role: user.role, name: user.name ?? undefined },
    c.env.JWT_SECRET
  );
  setSession(c, token);
  return c.json({
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      must_change_password: !!user.must_change_password,
    },
  });
});

// تغيير كلمة المرور (يُستخدم في أول دخول أو أي وقت). يتطلّب جلسة سارية.
app.post('/change-password', requireAuth, async (c) => {
  const user = c.get('user');
  const { new_password, current_password } = await c.req.json().catch(() => ({}));
  if (!new_password || new_password.length < 6) {
    return c.json({ error: 'كلمة المرور الجديدة يجب ألا تقل عن 6 أحرف' }, 400);
  }

  const row = await c.env.DB.prepare('SELECT password_hash, must_change_password FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ password_hash: string; must_change_password: number }>();
  if (!row) return c.json({ error: 'الحساب غير موجود' }, 404);

  // إن لم يكن في وضع الإجبار على التغيير، نتحقّق من كلمة المرور الحالية
  if (!row.must_change_password) {
    if (!current_password || !(await verifyPassword(current_password, row.password_hash))) {
      return c.json({ error: 'كلمة المرور الحالية غير صحيحة' }, 401);
    }
  }

  const hash = await hashPassword(new_password);
  await c.env.DB.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .bind(hash, user.id)
    .run();
  return c.json({ ok: true });
});

app.post('/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

app.get('/me', requireAuth, async (c) => {
  const u = c.get('user');
  // نقرأ حالة الإجبار على التغيير من قاعدة البيانات (تبقى صحيحة بعد إعادة التحميل)
  const row = await c.env.DB.prepare('SELECT must_change_password FROM users WHERE id = ?')
    .bind(u.id)
    .first<{ must_change_password: number }>();
  return c.json({ user: { ...u, must_change_password: !!row?.must_change_password } });
});

export default app;
