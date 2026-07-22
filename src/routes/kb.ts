// إدارة قاعدة المعرفة (للمسؤول) — §6
import { Hono } from 'hono';
import { requireAuth, requireAdmin, audit } from '../lib/auth';
import { uuid } from '../lib/crypto';
import { extractText } from '../lib/extract';
import { callClaude } from '../lib/claude';
import { ingestDocument } from '../ingest';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth, requireAdmin);

// قائمة وثائق قاعدة المعرفة
app.get('/documents', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, title, source_authority, decree_number, issue_date, status, category,
            version, last_verified, needs_update, chunk_count, ingest_status, created_at
     FROM kb_documents ORDER BY created_at DESC LIMIT 200`
  ).all();
  return c.json({ documents: rows.results });
});

// رفع وثيقة نظام: تخزين + استخراج + تصنيف تلقائي + جدولة التضمين
app.post('/documents', async (c) => {
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ error: 'لم يُرفَق ملف' }, 400);

  const buf = await file.arrayBuffer();
  const id = uuid();
  const r2Key = `kb/${id}-${file.name.replace(/[^\w.\-؀-ۿ]/g, '_')}`;
  await c.env.R2.put(r2Key, buf, { httpMetadata: { contentType: file.type || 'application/octet-stream' } });

  let text = '';
  try {
    text = await extractText(c.env, buf, file.type, file.name);
  } catch {}

  // تصنيف تلقائي عبر Claude
  const meta = await classifyDocument(c.env, file.name, text.slice(0, 6000));

  await c.env.DB.prepare(
    `INSERT INTO kb_documents
     (id, title, source_authority, decree_number, issue_date, status, category, version, r2_key, last_verified, needs_update, ingest_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, 'pending', ?)`
  )
    .bind(
      id,
      meta.title || file.name,
      meta.source_authority ?? null,
      meta.decree_number ?? null,
      meta.issue_date ?? null,
      meta.status ?? 'active',
      meta.category ?? null,
      r2Key,
      Date.now(),
      Date.now()
    )
    .run();

  // خزّن النص المستخرَج مؤقتًا في R2 لاستخدامه في التضمين
  await c.env.R2.put(`kb-text/${id}.txt`, text);

  // جدولة التضمين عبر Queue
  c.executionCtx.waitUntil(ingestDocument(c.env, id));

  await audit(c, 'kb.upload', id, { title: meta.title, category: meta.category });
  return c.json({ id, metadata: meta, ingest_status: 'pending' });
});

// تعديل بيانات وصفية يدويًا
app.patch('/documents/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const fields = ['title', 'source_authority', 'decree_number', 'issue_date', 'status', 'category'];
  const updates = fields.filter((f) => body[f] !== undefined);
  if (!updates.length) return c.json({ error: 'لا تحديثات' }, 400);
  const sql = `UPDATE kb_documents SET ${updates.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`;
  await c.env.DB.prepare(sql).bind(...updates.map((f) => body[f]), id).run();
  await audit(c, 'kb.update', id, body);
  return c.json({ ok: true });
});

// حذف وثيقة + متجهاتها
app.delete('/documents/:id', async (c) => {
  const id = c.req.param('id');
  const doc = await c.env.DB.prepare('SELECT r2_key, chunk_count FROM kb_documents WHERE id = ?')
    .bind(id)
    .first<{ r2_key: string; chunk_count: number }>();
  if (!doc) return c.json({ error: 'غير موجودة' }, 404);

  // حذف المتجهات
  const ids = Array.from({ length: doc.chunk_count ?? 0 }, (_, i) => `${id}:${i}`);
  if (ids.length) await c.env.VECTORIZE.deleteByIds(ids).catch(() => {});
  if (doc.r2_key) await c.env.R2.delete(doc.r2_key).catch(() => {});
  await c.env.R2.delete(`kb-text/${id}.txt`).catch(() => {});
  await c.env.DB.prepare('DELETE FROM kb_documents WHERE id = ?').bind(id).run();

  await audit(c, 'kb.delete', id, {});
  return c.json({ ok: true });
});

// ── إصدارات الأنظمة (§5): رفع نسخة جديدة مع حفظ القديمة ──
app.get('/documents/:id/versions', async (c) => {
  const id = c.req.param('id');
  const rows = await c.env.DB.prepare(
    'SELECT id, version, effective_from, effective_to, note, created_at FROM kb_document_versions WHERE kb_document_id = ? ORDER BY version DESC'
  )
    .bind(id)
    .all();
  return c.json({ versions: rows.results });
});

app.post('/documents/:id/versions', async (c) => {
  const id = c.req.param('id');
  const doc = await c.env.DB.prepare('SELECT title, version FROM kb_documents WHERE id = ?')
    .bind(id)
    .first<{ title: string; version: number }>();
  if (!doc) return c.json({ error: 'غير موجودة' }, 404);

  const form = await c.req.formData();
  const file = form.get('file');
  const effectiveFrom = form.get('effective_from')?.toString() ?? null;
  const note = form.get('note')?.toString() ?? null;
  if (!(file instanceof File)) return c.json({ error: 'لم يُرفَق ملف النسخة الجديدة' }, 400);

  // 1) احفظ النص الحالي كنسخة سابقة (effective_to = الآن)
  const oldText = await c.env.R2.get(`kb-text/${id}.txt`);
  const now = Date.now();
  const oldVersion = doc.version ?? 1;
  if (oldText) {
    const oldKey = `kb-text/${id}.v${oldVersion}.txt`;
    await c.env.R2.put(oldKey, await oldText.text());
    await c.env.DB.prepare(
      `INSERT INTO kb_document_versions (id, kb_document_id, version, text_r2_key, effective_to, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(uuid(), id, oldVersion, oldKey, new Date(now).toISOString().slice(0, 10), 'أُرشِفت عند رفع نسخة أحدث', now)
      .run();
  }

  // 2) استخرج نص النسخة الجديدة وخزّنه، وبمّط رقم الإصدار
  const buf = await file.arrayBuffer();
  const r2Key = `kb/${id}-v${oldVersion + 1}-${file.name.replace(/[^\w.\-؀-ۿ]/g, '_')}`;
  await c.env.R2.put(r2Key, buf, { httpMetadata: { contentType: file.type } });
  let text = '';
  try {
    text = await extractText(c.env, buf, file.type, file.name);
  } catch {}
  await c.env.R2.put(`kb-text/${id}.txt`, text);

  await c.env.DB.prepare(
    "UPDATE kb_documents SET version = ?, r2_key = ?, ingest_status = 'pending', needs_update = 0, last_verified = ? WHERE id = ?"
  )
    .bind(oldVersion + 1, r2Key, now, id)
    .run();
  await c.env.DB.prepare(
    `INSERT INTO kb_document_versions (id, kb_document_id, version, text_r2_key, effective_from, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(uuid(), id, oldVersion + 1, `kb-text/${id}.txt`, effectiveFrom, note ?? 'النسخة السارية', now)
    .run();

  c.executionCtx.waitUntil(ingestDocument(c.env, id));
  await audit(c, 'kb.new_version', id, { version: oldVersion + 1 });
  return c.json({ ok: true, version: oldVersion + 1 });
});

// إعادة تصنيف/إعادة تضمين
app.post('/documents/:id/reingest', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare("UPDATE kb_documents SET ingest_status = 'pending' WHERE id = ?").bind(id).run();
  c.executionCtx.waitUntil(ingestDocument(c.env, id));
  await audit(c, 'kb.reingest', id, {});
  return c.json({ ok: true });
});

// تصنيف وثيقة نظامية عبر Claude
async function classifyDocument(env: Env, filename: string, sample: string) {
  const system = `أنت مصنّف وثائق نظامية سعودية. استخرج البيانات الوصفية من الوثيقة وأعِدها بصيغة JSON فقط:
{
  "title": "اسم النظام/اللائحة الرسمي",
  "source_authority": "الجهة المُصدِرة",
  "decree_number": "رقم المرسوم الملكي أو القرار إن وُجد وإلا null",
  "issue_date": "تاريخ الإصدار إن وُجد (YYYY-MM-DD أو الهجري كما ورد) وإلا null",
  "status": "active | amended | repealed",
  "category": "أحد: مرافعات | معاملات مدنية | عمل | شركات | جزائي | إثبات | جمعيات | تجاري | ملكية فكرية | أخرى"
}`;
  try {
    const { text } = await callClaude(env, {
      model: env.PLANNER_MODEL,
      system,
      messages: [{ role: 'user', content: `اسم الملف: ${filename}\n\nعيّنة من المحتوى:\n${sample}` }],
      max_tokens: 512,
      temperature: 0,
    });
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { title: filename };
  } catch {
    return { title: filename };
  }
}

export default app;
