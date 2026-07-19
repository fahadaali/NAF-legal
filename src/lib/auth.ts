// وسيط المصادقة والصلاحيات
import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { verifyJwt } from './crypto';
import type { Env, Variables } from '../types';

export const SESSION_COOKIE = 'naf_session';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export async function requireAuth(c: Ctx, next: Next) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: 'غير مصرّح' }, 401);
  const payload = await verifyJwt(token, c.env.JWT_SECRET);
  if (!payload) return c.json({ error: 'جلسة منتهية أو غير صالحة' }, 401);
  c.set('user', {
    id: payload.sub,
    email: payload.email,
    role: payload.role as 'user' | 'admin',
    name: payload.name,
  });
  await next();
}

export async function requireAdmin(c: Ctx, next: Next) {
  const user = c.get('user');
  if (!user || user.role !== 'admin') return c.json({ error: 'يتطلب صلاحية مسؤول' }, 403);
  await next();
}

// تسجيل فعل إداري في سجل التدقيق (§2)
export async function audit(
  c: Ctx,
  action: string,
  target: string,
  details?: Record<string, unknown>
): Promise<void> {
  const user = c.get('user');
  await c.env.DB.prepare(
    'INSERT INTO audit_log (id, actor_id, action, target, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(crypto.randomUUID(), user?.id ?? null, action, target, details ? JSON.stringify(details) : null, Date.now())
    .run();
}
