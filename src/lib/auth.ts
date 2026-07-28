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
  if (!user || user.role !== 'admin') return c.json({ error: 'هذه العملية تتطلب صلاحية مسؤول' }, 403);
  await next();
}

/* الطرق التي لا تغيّر شيئاً. وما عداها كتابة. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * مسارات كتابةٍ لا تمسّ محتوى المنصة، فتبقى مفتوحة للقارئ.
 *
 * مكتوبة صراحةً ومطابقتها تامّة — لا بادئة ولا نمط. وإضافة مسار إليها قرار
 * يُقرأ في السطر، والنسيانُ يجعله محمياً لا مكشوفاً.
 *
 * `‎/api/notifications/read` حالةُ قراءةٍ يخصّ صاحبَها وحده — من قرأ إشعاره
 * لم يكتب في المنصة شيئاً. ومنعُه يترك شارة القارئ لا تنطفئ أبداً، وهو
 * إزعاجٌ بلا مقابل: لا محتوى يُحمى بمنعه.
 */
const READER_WRITABLE_PATHS = new Set(['/api/notifications/read']);

/**
 * القارئ يقرأ ولا يكتب.
 *
 * المنصة كانت تعرض ثلاثة أدوار وتنفّذ اثنين: `requireAdmin` يفصل المسؤول
 * عن غيره، ولا فحص واحد يفرّق `editor` من `viewer`. فمن حمل «مستخدم
 * (اطّلاع)» كان ينشئ المحادثات ويرفع الملفات ويكتب المسوّدات والمواعيد —
 * والاسم يقول غير ذلك، ومسؤول المنصة يسنِده ظانّاً أنه يمنع الكتابة.
 *
 * **والحكم بالطريقة لا بقائمة المسارات.** قائمةٌ تُعدَّد فيها المسارات
 * الكاتبة تنسى واحداً أوّل ما يُضاف مسار جديد، ونسيانها يفتح ثغرة صامتة.
 * والطريقة تشمل ما لم يُكتب بعد: أي `POST` أو `PATCH` أو `PUT` أو `DELETE`
 * يُضاف غداً محميٌّ يوم يُضاف.
 *
 * ويُسجَّل على كل المسارات لا على الكاتبة وحدها، لأن الحارس نفسه هو الذي
 * يقرّر أيُّها كاتبة.
 *
 * ولا يمسّ المسؤول ولا المحرّر: الشرط على `viewer` وحده.
 */
export async function requireWriter(c: Ctx, next: Next) {
  const user = c.get('user');
  if (user?.role === 'viewer' && !READ_METHODS.has(c.req.method)) {
    if (!READER_WRITABLE_PATHS.has(new URL(c.req.url).pathname)) {
      /* §١٠ · رسائل الصلاحية — «تتطلب صلاحية تحرير» لا «صلاحية مسؤول».
         ما رُدّ عنه القارئُ هنا يفعله المحرّر ولا يحتاج مسؤولاً، فقولُ
         «مسؤول» له يدفعه إلى طلب ترقيةٍ لا يحتاجها ومراجعةِ من لا شأن له. */
      return c.json({ error: 'هذه العملية تتطلب صلاحية تحرير' }, 403);
    }
  }
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
