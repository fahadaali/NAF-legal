// وسيط المصادقة والصلاحيات
import type { Context, Next } from 'hono';
import type { Env, Variables } from '../types';

export const SESSION_COOKIE = 'naf_session';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

// المصادقة صارت مركزية: وسيط الدخول الموحّد (`lib/sso.ts`) يعمل على كل
// المسارات قبل هذه الدالة، ويحقن المستخدم في السياق أو يردّ بنفسه تحويلاً
// أو رفضاً. فلم يبقَ لهذا الحارس إلا التأكد من وجود المحقون.
//
// ولا تُقرأ هنا جلسةٌ محلية ولا يُتحقَّق من `JWT_SECRET`: جلسةٌ تجدّد نفسها
// من كوكي محلي تُبقي الموقوفَ مركزياً داخلاً حتى انتهاء كوكيه.
export async function requireAuth(c: Ctx, next: Next) {
  const user = c.get('user');
  if (!user) return c.json({ error: 'غير مصرّح' }, 401);
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
