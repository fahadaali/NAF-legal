// المستخدمون والصلاحيات — شاشة مسؤول المنصة
//
// «كل ما بعد الباب تقرّره هذه المنصة من إعداداتها.» فالمركز لا يُسأل عن دور
// ولا يُخبَر به؛ ولا يُبلَّغ إلا بسحب الوصول، ليظهر السبب للعضو في شبكته.
//
// والمفردات من naf-terms.md §١٠: «سحب» و«منح» زوجٌ واحد، و«تعطيل العضو»
// ممنوعة هناك صراحةً — «معطّل» تصف حالة العضوية لا الفعل الذي أنتجها.

import { Hono } from 'hono';
import { requireAuth, requireAdmin, audit } from '../lib/auth';
import { reportAccessChange } from 'naf-auth';
import { ssoConfig } from '../lib/sso';
import type { Env, Variables, PlatformRole } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', requireAuth, requireAdmin);

const ROLES: PlatformRole[] = ['admin', 'editor', 'viewer'];

/** الوقت في `members` بالثواني — وهذا موضع التحويل الوحيد (هجرة 0009). */
function toMillis(seconds: number | null): number | null {
  return seconds == null ? null : seconds * 1000;
}

interface MemberRow {
  user_id: string;
  display_name: string | null;
  email: string | null;
  role: string;
  is_active: number;
  last_seen_at: number | null;
  created_at: number;
  local_user_id: string | null;
}

app.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT user_id, display_name, email, role, is_active, last_seen_at, created_at, local_user_id
     FROM members ORDER BY created_at DESC LIMIT 500`
  ).all<MemberRow>();

  const me = c.get('user');
  return c.json({
    members: (rows.results ?? []).map((m) => ({
      user_id: m.user_id,
      display_name: m.display_name,
      email: m.email,
      role: m.role,
      is_active: !!m.is_active,
      last_seen_at: toMillis(m.last_seen_at),
      created_at: toMillis(m.created_at),
      // ليعرف العميل أيّ صفٍّ هو صفّ القارئ نفسه فيمنع عنه أزرار السحب
      is_self: m.user_id === me.memberId,
    })),
  });
});

app.patch('/:id/role', async (c) => {
  const id = c.req.param('id');
  const { role } = await c.req.json<{ role?: string }>().catch(() => ({ role: undefined }));

  if (!role || !ROLES.includes(role as PlatformRole)) {
    return c.json({ error: 'الصلاحية غير معروفة' }, 400);
  }

  const me = c.get('user');
  // مسؤول ينزع صلاحيته عن نفسه يقفل الباب على المنصة كلها إن كان الوحيد.
  if (id === me.memberId && role !== 'admin') {
    return c.json({ error: 'لا يمكنك تغيير صلاحيتك بنفسك' }, 400);
  }

  const res = await c.env.DB.prepare('UPDATE members SET role = ? WHERE user_id = ?')
    .bind(role, id)
    .run();
  if (!res.meta.changes) return c.json({ error: 'لا عضو بهذا المعرّف' }, 404);

  await audit(c, 'member.role_change', id, { role });
  return c.json({ ok: true });
});

app.patch('/:id/active', async (c) => {
  const id = c.req.param('id');
  const body = await c.req
    .json<{ is_active?: boolean; reason?: string }>()
    .catch(() => ({ is_active: undefined, reason: undefined }));

  if (typeof body.is_active !== 'boolean') return c.json({ error: 'البيانات ناقصة' }, 400);

  const me = c.get('user');
  if (id === me.memberId && !body.is_active) {
    return c.json({ error: 'لا يمكنك سحب وصولك بنفسك' }, 400);
  }

  const reason = (body.reason ?? '').trim();
  // السبب يُعرض للعضو في شبكة المركز، فلا يُرسَل فارغاً عند السحب.
  if (!body.is_active && !reason) {
    return c.json({ error: 'اكتب سبب السحب — يُعرض للعضو في شبكته' }, 400);
  }

  // البريد يُقرأ قبل الكتابة: المركز يفتّش به لا بالمعرّف المركزي.
  const member = await c.env.DB.prepare('SELECT email FROM members WHERE user_id = ?')
    .bind(id)
    .first<{ email: string | null }>();
  if (!member) return c.json({ error: 'لا عضو بهذا المعرّف' }, 404);

  const res = await c.env.DB.prepare('UPDATE members SET is_active = ? WHERE user_id = ?')
    .bind(body.is_active ? 1 : 0, id)
    .run();
  if (!res.meta.changes) return c.json({ error: 'لا عضو بهذا المعرّف' }, 404);

  await audit(c, body.is_active ? 'member.grant' : 'member.revoke', id, { reason });

  // التغيير يسري محلياً فور كتابته: الوسيط يقرأ `is_active` في كل طلب،
  // فالعضو ممنوع من هذه المنصة سواء بلغ التبليغُ المركزَ أم لم يبلغ.
  // ولذلك يُكتب أولاً ثم يُبلَّغ — والعكس يترك ثغرة بين النداء والكتابة.
  //
  // ويُبلَّغ الطرفان لا السحب وحده: المركز يقبل `granted` و `revoked`، وترك
  // المنح بلا تبليغ يُبقي بطاقةً مرفوضةً في شبكة عضوٍ أُعيد وصولُه.
  const email = member.email?.trim();
  if (!email) {
    // عضو بلا بريد لا يمكن تبليغه: المركز يفتّش بالبريد وحده.
    return c.json({ ok: true, reported: false });
  }

  try {
    await reportAccessChange(c.env, ssoConfig(c.env), {
      email,
      state: body.is_active ? 'granted' : 'revoked',
      reason,
    });
  } catch {
    // لا يُرفَع الاستثناء إلى المستخدم: نصّه قد يحمل تفصيلاً تقنياً.
    // والقرار قائم محلياً، والناقص موافقةُ جدول المركز له وحدها.
    return c.json({ ok: true, reported: false });
  }

  return c.json({ ok: true, reported: true });
});

export default app;
