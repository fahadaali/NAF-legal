// مسارات المسؤول: المستخدمون، سجل التدقيق، تتبّع الأنظمة — §2, §7
import { Hono } from 'hono';
import { requireAuth, requireAdmin, audit } from '../lib/auth';
import { runTrackingScan } from '../cron';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth, requireAdmin);

// إدارة المستخدمين
app.get('/users', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, email, role, name, created_at FROM users ORDER BY created_at DESC LIMIT 500'
  ).all();
  return c.json({ users: rows.results });
});

app.patch('/users/:id/role', async (c) => {
  const id = c.req.param('id');
  const { role } = await c.req.json().catch(() => ({}));
  if (!['user', 'admin'].includes(role)) return c.json({ error: 'دور غير صالح' }, 400);
  await c.env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, id).run();
  await audit(c, 'user.role_change', id, { role });
  return c.json({ ok: true });
});

// سجل التدقيق
app.get('/audit', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.actor_id, u.email AS actor_email, a.action, a.target, a.details_json, a.created_at
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     ORDER BY a.created_at DESC LIMIT 200`
  ).all();
  return c.json({ entries: rows.results });
});

// لوحة تتبّع الأنظمة: القائمتان (تحتاج تحديثًا / جديدة مقترحة) — §7
app.get('/tracking', async (c) => {
  const needsUpdate = await c.env.DB.prepare(
    `SELECT t.id, t.change_summary, t.last_checked, t.status, d.id AS doc_id, d.title, d.category
     FROM regulation_tracking t JOIN kb_documents d ON d.id = t.kb_document_id
     WHERE t.status = 'needs_review' ORDER BY t.last_checked DESC`
  ).all();
  const newSuggested = await c.env.DB.prepare(
    `SELECT id, change_summary, last_checked, status FROM regulation_tracking
     WHERE status = 'new_suggested' ORDER BY last_checked DESC`
  ).all();
  return c.json({ needs_update: needsUpdate.results, new_suggested: newSuggested.results });
});

// اعتماد مراجعة: مسح العلامة وتحديث تاريخ التحقّق
app.post('/tracking/:id/resolve', async (c) => {
  const id = c.req.param('id');
  const track = await c.env.DB.prepare('SELECT kb_document_id FROM regulation_tracking WHERE id = ?')
    .bind(id)
    .first<{ kb_document_id: string | null }>();
  await c.env.DB.prepare("UPDATE regulation_tracking SET status = 'ok', change_detected = 0 WHERE id = ?")
    .bind(id)
    .run();
  if (track?.kb_document_id) {
    await c.env.DB.prepare('UPDATE kb_documents SET needs_update = 0, last_verified = ? WHERE id = ?')
      .bind(Date.now(), track.kb_document_id)
      .run();
  }
  await audit(c, 'tracking.resolve', id, {});
  return c.json({ ok: true });
});

// تشغيل فحص التتبّع يدويًا (بدل انتظار الـ Cron)
app.post('/tracking/scan', async (c) => {
  const result = await runTrackingScan(c.env);
  await audit(c, 'tracking.manual_scan', 'all', { ...result });
  return c.json(result);
});

export default app;
