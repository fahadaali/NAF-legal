/**
 * ربط أدوات الذكاء الاصطناعي — ما يحتاج هويّة العضو أو صلاحية المسؤول.
 *
 * خلف وسيط الدخول الموحّد (`/api/*`): السماحُ يقع من عضوٍ دخل من المركز، فهويّته
 * من الوسيط لا من الطلب. وشاشتا «أدوات الذكاء الاصطناعي» في الإعدادات ولوحة
 * الإدارة تقرآن من هنا (`naf-terms.md` §١٥).
 *
 * **والقارئ يسمح ويُلغي.** الربط للقراءة عنده، وإلغاءُ ربطه لا يكتب في محتوى
 * المنصة شيئاً — فمساراهما في `READER_WRITABLE_PATHS` بـ`lib/auth.ts`، مطابقةً
 * تامّة لا بادئة. وأدوات الكتابة لا تظهر له في الأداة أصلاً (`mcp/conversations.ts`).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { requireAuth, requireAdmin, audit } from '../lib/auth';
import { uuid } from '../lib/crypto';
import { approveMember, describeRequest, revokeConnection, normalizeEmail, looksLikeEmail } from '../mcp/oauth';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

const EXPIRED = 'انتهت مهلة طلب الربط. ابدأ الربط من أداتك من جديد.';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

interface ConnectionRow {
  id: string;
  client_name: string | null;
  subject_kind: string;
  member_id: string | null;
  guest_id: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number;
  revoked_at: number | null;
  owner_name?: string | null;
  owner_email?: string | null;
}

/** «مربوط» أو «غير مربوط» — الحالتان المسجّلتان وحدهما (§١٥). */
function withStatus(r: ConnectionRow) {
  const connected = !r.revoked_at && r.expires_at > Date.now();
  return { ...r, status: connected ? 'connected' : 'not_connected' };
}

// ── شاشة الإذن للعضو ──

app.get('/connect/:id', async (c) => {
  const r = await describeRequest(c.env, c.req.param('id'));
  if (!r) return c.json({ error: EXPIRED, expired: true }, 410);
  const user = c.get('user');
  return c.json({ client_name: r.clientName, can_save: user.role !== 'viewer' });
});

app.post('/connect/approve', async (c: Ctx) => {
  const { request_id } = (await c.req.json().catch(() => ({}))) as { request_id?: unknown };
  const user = c.get('user');
  if (typeof request_id !== 'string' || !user.memberId) return c.json({ error: EXPIRED, expired: true }, 410);
  const r = await approveMember(c.env, request_id, user.memberId, new URL(c.req.url).origin);
  if (r.ok) return c.json({ ok: true, redirect: r.redirect });
  if (r.reason === 'inactive') return c.json({ error: 'وصولك إلى المنصة مسحوب، فلا يمكن الربط. راجع مسؤول المنصة.' }, 403);
  return c.json({ error: EXPIRED, expired: true }, 410);
});

// ── أدوات العضو ──

app.get('/connections', async (c) => {
  const user = c.get('user');
  const rows = await c.env.DB.prepare(
    `SELECT id, client_name, subject_kind, member_id, guest_id, created_at, last_used_at, expires_at, revoked_at
     FROM mcp_connections WHERE member_id = ? ORDER BY created_at DESC LIMIT 100`
  )
    .bind(user.memberId ?? '')
    .all<ConnectionRow>();
  return c.json({ connections: (rows.results ?? []).map(withStatus) });
});

app.post('/connections/revoke', async (c) => {
  const { id } = (await c.req.json().catch(() => ({}))) as { id?: unknown };
  const user = c.get('user');
  const own = typeof id === 'string'
    ? await c.env.DB.prepare('SELECT id FROM mcp_connections WHERE id = ? AND member_id = ?').bind(id, user.memberId ?? '').first()
    : null;
  // ربطُ غيره كربطٍ لا وجود له — لا يُقال له إنه موجود لأحد.
  if (!own) return c.json({ error: 'غير موجود' }, 404);
  await revokeConnection(c.env, id as string, 'owner');
  return c.json({ ok: true });
});

// ── لوحة الإدارة ──

const admin = new Hono<{ Bindings: Env; Variables: Variables }>();
admin.use('*', requireAdmin);

admin.get('/connections', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.client_name, c.subject_kind, c.member_id, c.guest_id, c.created_at, c.last_used_at, c.expires_at, c.revoked_at,
            COALESCE(m.display_name, m.email, g.email) AS owner_name, COALESCE(m.email, g.email) AS owner_email
     FROM mcp_connections c
     LEFT JOIN members m ON m.user_id = c.member_id
     LEFT JOIN mcp_guests g ON g.id = c.guest_id
     ORDER BY c.created_at DESC LIMIT 500`
  ).all<ConnectionRow>();
  return c.json({ connections: (rows.results ?? []).map(withStatus) });
});

admin.post('/connections/revoke', async (c) => {
  const { id } = (await c.req.json().catch(() => ({}))) as { id?: unknown };
  if (typeof id !== 'string' || !(await revokeConnection(c.env, id, 'admin'))) return c.json({ error: 'غير موجود' }, 404);
  await audit(c, 'mcp.connection.revoke', id);
  return c.json({ ok: true });
});

admin.get('/guests', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT g.id, g.email, g.created_at,
            EXISTS (SELECT 1 FROM mcp_connections c WHERE c.guest_id = g.id AND c.revoked_at IS NULL AND c.expires_at > ?) AS connected
     FROM mcp_guests g ORDER BY g.created_at DESC LIMIT 500`
  )
    .bind(Date.now())
    .all<{ id: string; email: string; created_at: number; connected: number }>();
  return c.json({
    guests: (rows.results ?? []).map((g) => ({ ...g, status: g.connected ? 'connected' : 'not_connected' })),
  });
});

admin.post('/guests', async (c) => {
  const { email } = (await c.req.json().catch(() => ({}))) as { email?: unknown };
  const raw = typeof email === 'string' ? email.trim() : '';
  const norm = normalizeEmail(raw);
  if (!looksLikeEmail(norm)) return c.json({ error: 'البريد الإلكتروني غير صحيح. اكتبه كاملاً كما يصلك عليه البريد.' }, 400);
  // عضوٌ لا يُضاف ضيفاً: ربطُه ضيفاً يحرمه حفظ محادثاته (§١٥).
  const member = await c.env.DB.prepare('SELECT 1 AS x FROM members WHERE lower(email) = ? LIMIT 1').bind(norm).first();
  if (member) return c.json({ error: 'هذا البريد لعضوٍ في المنصة، فلا يُضاف ضيفاً.' }, 409);
  const id = uuid();
  const res = await c.env.DB.prepare(
    'INSERT INTO mcp_guests (id, email, email_norm, added_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email_norm) DO NOTHING'
  )
    .bind(id, raw, norm, c.get('user').id, Date.now())
    .run();
  if (!res.meta.changes) return c.json({ error: 'هذا البريد مضاف ضيفاً من قبل.' }, 409);
  await audit(c, 'mcp.guest.add', id, { email: norm });
  return c.json({ ok: true, id });
});

/** حذفُ الضيف يُلغي كلَّ ربطٍ له فوراً — والجملة التأكيدية تقول ذلك (§١٥). */
admin.delete('/guests/:id', async (c) => {
  const id = c.req.param('id');
  const guest = await c.env.DB.prepare('SELECT email_norm FROM mcp_guests WHERE id = ?').bind(id).first<{ email_norm: string }>();
  if (!guest) return c.json({ error: 'غير موجود' }, 404);
  const conns = await c.env.DB.prepare('SELECT id FROM mcp_connections WHERE guest_id = ? AND revoked_at IS NULL')
    .bind(id)
    .all<{ id: string }>();
  for (const r of conns.results ?? []) await revokeConnection(c.env, r.id, 'guest_removed');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM mcp_guest_codes WHERE guest_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM mcp_guests WHERE id = ?').bind(id),
  ]);
  await audit(c, 'mcp.guest.remove', id, { email: guest.email_norm });
  return c.json({ ok: true });
});

app.route('/admin', admin);

export default app;
