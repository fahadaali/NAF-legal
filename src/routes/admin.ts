// مسارات المسؤول: المستخدمون، سجل التدقيق، تتبّع الأنظمة — §2, §7
import { Hono } from 'hono';
import { requireAuth, requireAdmin, audit } from '../lib/auth';
import { runTrackingScan, runNewsDigest } from '../cron';
import { uuid } from '../lib/crypto';
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

// ── لوحة التحليلات (§4) ──
app.get('/analytics', async (c) => {
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000; // آخر 30 يومًا
  const totals = await c.env.DB.prepare(
    `SELECT COUNT(*) AS events, COALESCE(SUM(input_tokens),0) AS in_tok,
            COALESCE(SUM(output_tokens),0) AS out_tok, COALESCE(SUM(cost_usd),0) AS cost
     FROM usage_events WHERE created_at >= ?`
  )
    .bind(since)
    .first();
  const byKind = await c.env.DB.prepare(
    `SELECT kind, COUNT(*) AS n, COALESCE(SUM(cost_usd),0) AS cost FROM usage_events
     WHERE created_at >= ? GROUP BY kind ORDER BY cost DESC`
  )
    .bind(since)
    .all();
  const byType = await c.env.DB.prepare(
    `SELECT consultation_type, COUNT(*) AS n FROM usage_events
     WHERE created_at >= ? AND consultation_type IS NOT NULL GROUP BY consultation_type ORDER BY n DESC`
  )
    .bind(since)
    .all();
  const byUser = await c.env.DB.prepare(
    `SELECT u.email, COUNT(*) AS n, COALESCE(SUM(e.cost_usd),0) AS cost FROM usage_events e
     LEFT JOIN users u ON u.id = e.user_id WHERE e.created_at >= ? GROUP BY e.user_id ORDER BY cost DESC LIMIT 20`
  )
    .bind(since)
    .all();
  return c.json({ totals, by_kind: byKind.results, by_type: byType.results, by_user: byUser.results });
});

// ── الإعدادات ورأسية الشركة (§2 قوالب) ──
app.get('/settings', async (c) => {
  const rows = await c.env.DB.prepare('SELECT key, value FROM app_settings').all<{ key: string; value: string }>();
  const settings: Record<string, string> = {};
  for (const r of rows.results ?? []) settings[r.key] = r.value;
  return c.json({ settings });
});

app.post('/settings', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  for (const [key, value] of Object.entries(body)) {
    await c.env.DB.prepare(
      'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    )
      .bind(key, String(value), Date.now())
      .run();
  }
  await audit(c, 'settings.update', 'app_settings', body);
  return c.json({ ok: true });
});

// رفع صورة رأسية الشركة (A4) لاستخدامها في قوالب Word
app.post('/letterhead', async (c) => {
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ error: 'لم تُرفَق صورة' }, 400);
  if (!file.type.startsWith('image/')) return c.json({ error: 'يجب أن تكون صورة' }, 415);
  const r2Key = 'settings/letterhead';
  await c.env.R2.put(r2Key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  await c.env.DB.prepare(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  )
    .bind('letterhead_mime', file.type, Date.now())
    .run();
  await audit(c, 'settings.letterhead', r2Key, { mime: file.type });
  return c.json({ ok: true, mime: file.type });
});

// ── خلاصة أخبار جريدة أم القرى (§5) ──
app.get('/news', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM news_digest ORDER BY created_at DESC LIMIT 50').all();
  return c.json({ news: rows.results });
});

app.post('/news/scan', async (c) => {
  const result = await runNewsDigest(c.env);
  await audit(c, 'news.scan', 'umm_alqura', { ...result });
  return c.json(result);
});

// تحويل عنصر خلاصة إلى وثيقة قاعدة معرفة مقترحة (استيعاب تلقائي عند الاعتماد)
app.post('/news/:id/ingest', async (c) => {
  const id = c.req.param('id');
  const item = await c.env.DB.prepare('SELECT * FROM news_digest WHERE id = ?').bind(id).first<any>();
  if (!item) return c.json({ error: 'غير موجود' }, 404);
  const docId = uuid();
  await c.env.DB.prepare(
    `INSERT INTO kb_documents (id, title, source_authority, category, status, version, needs_update, ingest_status, created_at)
     VALUES (?, ?, 'جريدة أم القرى', 'أخرى', 'active', 1, 0, 'pending', ?)`
  )
    .bind(docId, item.title, Date.now())
    .run();
  // محاولة سحب النص من المصدر الرسمي إن توفّر رابط
  if (item.url) {
    c.executionCtx.waitUntil(ingestFromUrl(c.env, docId, item.url));
  }
  await audit(c, 'news.ingest', docId, { from: id });
  return c.json({ ok: true, document_id: docId });
});

// سحب نص من رابط رسمي وتخزينه ثم جدولة التضمين
async function ingestFromUrl(env: Env, docId: string, url: string) {
  try {
    const res = await fetch(url);
    const html = await res.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    await env.R2.put(`kb-text/${docId}.txt`, text);
    await env.QUEUE.send({ kb_document_id: docId });
  } catch {
    await env.DB.prepare("UPDATE kb_documents SET ingest_status = 'error' WHERE id = ?").bind(docId).run();
  }
}

export default app;
