// مسارات المسؤول: المستخدمون، سجل التدقيق، تتبّع الأنظمة — §2, §7
import { Hono } from 'hono';
import { requireAuth, requireAdmin, audit } from '../lib/auth';
import { runTrackingScan, runNewsDigest } from '../cron';
import { ingestDocument } from '../ingest';
import { getAllEffectiveConfigs, getEffectiveConfig, defaultConfig } from '../lib/consultationConfig';
import { callClaude } from '../lib/claude';
import {
  DOC_TEMPLATE_KEYS,
  LETTERHEAD_KEY,
  LETTERHEAD_RASTER_KEY,
  isSvgMime,
  normalizeDocTemplate,
} from '../lib/docTemplate';
import { uuid } from '../lib/crypto';
import { listSources, getSource, recordCheck } from '../lib/sources';
import { searchSource } from '../lib/external';
import { discoverForEndpoint } from '../lib/discover';
import { authorizeMachine, forget, startAuthorization, BIND_COOKIE } from '../lib/oauth';
import { callTool } from '../lib/mcp';
import type { ExternalSource } from '../lib/sources';
import { notify } from '../lib/notify';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth, requireAdmin);

// إدارة المستخدمين
app.get('/users', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, email, role, name, must_change_password, created_at FROM users ORDER BY created_at DESC LIMIT 500'
  ).all();
  return c.json({ users: rows.results });
});

/* ── ثلاثةُ مسارات أُسقطت مع الدخول الموحّد ──
 *
 * `POST /users` و `PATCH /users/:id/role` و `POST /users/:id/reset-password`.
 * أُسقطت من الواجهة يوم الربط، وبقيت هنا حيّةً تقبل نداءً مباشراً — وكلُّها
 * لغوٌ في أحسن أحوالها وفخٌّ في أسوئها:
 *
 *   `POST /users`      ينشئ حساباً بكلمة مرورٍ لا بابَ لها: الدخولُ المحليّ
 *                      خلف وسيط المركز، فلا يبلغ صاحبُ الحساب شيئاً.
 *   `PATCH …/role`     يكتب في `users.role` — عمودٌ لا يقرّر وصولاً بعد
 *                      الربط. فيظنّ المسؤولُ أنه منح صلاحيةً ولم يمنح شيئاً،
 *                      والصلاحية في `members.role` من شاشة «الأعضاء».
 *   `POST …/reset-…`   يرفع `must_change_password` إلى ١ — وهي الرايةُ التي
 *                      صفّرتها هجرة `0010` لأنها تحبس صاحبها في شاشةِ كلمةِ
 *                      مرورٍ لا معنى لها بعد الربط.
 *
 * فحُذفت الثلاثة. وإنشاء الأعضاء من المركز، والصلاحية من «الأعضاء»، ولا
 * كلمةَ مرورٍ في هذه المنصة تُنشأ ولا تُصفَّر.
 */

/**
 * حذف سجلّ هوية محليّ.
 *
 * **ويُرفض متى كان مرتبطاً بعضو.** `members.local_user_id` مفتاحٌ أجنبيّ إلى
 * `users(id)` بلا `ON DELETE`، فالقاعدة ترفض الحذف بنفسها — وكان الرفض يخرج
 * استثناءً غيرَ مُمسَك، فيقرؤه المسؤول «خطأ في الاتصال» ويعيد الضغط.
 *
 * والرفض هنا مقصود لا حيلةٌ على القيد: حذفُ الصفّ يتتالى على `conversations`
 * و `case_folders` و `regulation_requests` — عملُ المحامي كلُّه — وما يريده
 * المسؤول حين ينصرف عضوٌ هو **سحبُ وصوله**، وموضعُه شاشة «الأعضاء». فيقول
 * الردُّ ذلك بعينه بدل أن يُلقي اللوم على الشبكة.
 *
 * ويبقى الحذف متاحاً لسجلٍّ لا عضو له — بقايا ما قبل الربط.
 */
app.delete('/users/:id', async (c) => {
  const id = c.req.param('id');
  const me = c.get('user');
  if (id === me.id) return c.json({ error: 'لا يمكنك حذف حسابك' }, 400);

  const linked = await c.env.DB.prepare('SELECT user_id FROM members WHERE local_user_id = ?')
    .bind(id)
    .first<{ user_id: string }>();
  if (linked) {
    return c.json(
      { error: 'هذا السجلّ مرتبط بعضو. اسحب وصوله من شاشة «الأعضاء» بدل حذفه' },
      409
    );
  }

  const res = await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  if (!res.meta.changes) return c.json({ error: 'المستخدم غير موجود' }, 404);
  await audit(c, 'user.delete', id, {});
  return c.json({ ok: true });
});

// ── طلبات إضافة الأنظمة المرفوعة من المستخدمين ──
app.get('/regulation-requests', async (c) => {
  const status = c.req.query('status') ?? 'all';
  const base = `SELECT r.id, r.name, r.url, r.has_bylaw, r.bylaw_url, r.note, r.source, r.status,
                       r.admin_note, r.created_at, r.handled_at, r.conversation_id,
                       u.email AS requester_email, u.name AS requester_name
                FROM regulation_requests r LEFT JOIN users u ON u.id = r.user_id`;
  const rows =
    status === 'all'
      ? await c.env.DB.prepare(`${base} ORDER BY r.created_at DESC LIMIT 200`).all()
      : await c.env.DB.prepare(`${base} WHERE r.status = ? ORDER BY r.created_at DESC LIMIT 200`).bind(status).all();
  const pending = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM regulation_requests WHERE status = 'pending'"
  ).first<{ n: number }>();
  return c.json({ requests: rows.results, pending: pending?.n ?? 0 });
});

// البتّ في الطلب: اعتماد أو رفض، مع إشعار مقدّم الطلب
app.patch('/regulation-requests/:id', async (c) => {
  const id = c.req.param('id');
  const me = c.get('user');
  const { status, admin_note } = await c.req.json().catch(() => ({} as any));
  if (!['pending', 'approved', 'rejected'].includes(status)) return c.json({ error: 'حالة غير صالحة' }, 400);

  const row = await c.env.DB.prepare(
    'SELECT r.user_id, r.name, u.email FROM regulation_requests r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?'
  )
    .bind(id)
    .first<{ user_id: string; name: string; email: string | null }>();
  if (!row) return c.json({ error: 'غير موجود' }, 404);

  const note = typeof admin_note === 'string' && admin_note.trim() ? admin_note.trim().slice(0, 1000) : null;
  await c.env.DB.prepare(
    'UPDATE regulation_requests SET status = ?, admin_note = ?, handled_by = ?, handled_at = ? WHERE id = ?'
  )
    .bind(status, note, me.id, status === 'pending' ? null : Date.now(), id)
    .run();

  if (status !== 'pending') {
    await notify(c.env, {
      userId: row.user_id,
      kind: 'system',
      title: status === 'approved' ? 'تم اعتماد طلب إضافة النظام' : 'تم رفض طلب إضافة النظام',
      body: note ? `${row.name} — ${note}` : row.name,
      email: row.email ?? undefined,
    });
  }

  await audit(c, 'regulation_request.decide', id, { status });
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

// لوحة تتبّع الأنظمة: الأنظمة التي رُصد لها تعديل يحتاج مراجعة — §7
// (الأنظمة الجديدة تُرصد في «خلاصة الأخبار» من المصادر الرسمية)
app.get('/tracking', async (c) => {
  const needsUpdate = await c.env.DB.prepare(
    `SELECT t.id, t.change_summary, t.last_checked, t.status, d.id AS doc_id, d.title, d.category
     FROM regulation_tracking t JOIN kb_documents d ON d.id = t.kb_document_id
     WHERE t.status = 'needs_review' ORDER BY t.last_checked DESC`
  ).all();
  return c.json({ needs_update: needsUpdate.results });
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
  /* قيم قالب المستند تُضبط عند الكتابة لا عند القراءة وحدها: حقلٌ يُحفظ
     «كبير» ويعود «كبير» في الشاشة بينما المستند يخرج بالافتراضي يُقرأ عطلاً. */
  clampDocTemplateFields(body);
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

/**
 * رفع صورة رأسية الشركة (A4) لقالبَي Word والطباعة.
 *
 * والمتجهة (SVG) تُرفع معها نقطيّتها في الحقل `raster`: Word لا يعرض متجهةً
 * وحدها — امتداد `svgBlip` يوجب بديلاً نقطياً — ولا رَسْمَ متجهات في Worker.
 * فالمتصفّح يرسمها عند الرفع، وهو الموضع الوحيد الذي يملك مُحرّك رسم.
 */
app.post('/letterhead', async (c) => {
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ error: 'لم تُرفَق صورة' }, 400);
  if (!file.type.startsWith('image/')) return c.json({ error: 'يجب أن تكون صورة' }, 415);

  const isSvg = isSvgMime(file.type);
  const raster = form.get('raster');
  if (isSvg && !(raster instanceof File)) {
    return c.json({ error: 'تعذّر تجهيز نسخة الرأسية لقوالب Word. أعد المحاولة أو ارفعها بصيغة PNG.' }, 400);
  }

  await c.env.R2.put(LETTERHEAD_KEY, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  if (isSvg && raster instanceof File) {
    await c.env.R2.put(LETTERHEAD_RASTER_KEY, await raster.arrayBuffer(), {
      httpMetadata: { contentType: 'image/png' },
    });
  } else {
    // رفعٌ نقطيّ بعد متجهٍ سابق: النقطية المشتقّة تصير رأسيةً غير التي رُفعت
    await c.env.R2.delete(LETTERHEAD_RASTER_KEY).catch(() => {});
  }

  await c.env.DB.prepare(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  )
    .bind('letterhead_mime', file.type, Date.now())
    .run();
  await audit(c, 'settings.letterhead', LETTERHEAD_KEY, { mime: file.type, vector: isSvg });
  return c.json({ ok: true, mime: file.type });
});

// ── فحص Workers AI (التضمين) ──
app.get('/ai-check', async (c) => {
  const t0 = Date.now();
  try {
    const res: any = await c.env.AI.run(c.env.EMBEDDING_MODEL as any, { text: ['اختبار عمل Workers AI'] });
    const vec = res?.data?.[0] ?? res?.[0];
    if (!Array.isArray(vec)) return c.json({ ok: false, error: 'لم يُرجِع النموذج متجهًا صالحًا' }, 502);
    return c.json({ ok: true, model: c.env.EMBEDDING_MODEL, dimensions: vec.length, ms: Date.now() - t0 });
  } catch (e: any) {
    return c.json({ ok: false, model: c.env.EMBEDDING_MODEL, error: String(e?.message ?? e) }, 502);
  }
});

// ── فحص Claude (التخطيط والتوليد) ──
//
// للمنصة فحصٌ لـWorkers AI منذ البداية ولا فحص لـClaude، مع أن Claude هو ما
// تقوم عليه كل مخرجاتها. وكل مستدعٍ له — عدا التوليد — يبتلع خطأه ويكمل
// بخطة احتياطية، فانقطاعٌ كامل فيه يظهر جملةً واحدة عند أول رسالة يرسلها
// المستخدم، ويُقرأ خطأَ صلاحيات. هذا الفحص يفصل الحالتين في ثانية.
//
// والنموذجان يُفحصان لا واحد: `PLANNER_MODEL` و `GENERATION_MODEL` قد
// يختلفان، وفشلُ الأول وحده يترك المنصة تعمل بخطة احتياطية بلا تخطيط.
//
// والردّ ٢٠٠ دائماً وإن فشل الفحص: التقرير نفسه هو المطلوب — أيّ نموذج فشل
// وبأي رسالة — ورمزُ خطأٍ يجعل عميل الواجهة يرمي فيضيّع تفصيله.
app.get('/claude-check', async (c) => {
  const models = Array.from(new Set([c.env.GENERATION_MODEL, c.env.PLANNER_MODEL].filter(Boolean)));
  const checks = await Promise.all(
    models.map(async (model) => {
      const t0 = Date.now();
      try {
        // الحدّ ليس ضيّقاً عمداً: التفكير يقتسمه مع النص على Opus 5، وحدٌّ
        // صغير يجعل الفحصَ يفشل على نموذجٍ سليم فيقود التشخيص إلى لا شيء.
        const { text, raw } = await callClaude(c.env, {
          model,
          messages: [{ role: 'user', content: 'أجب بكلمة واحدة: جاهز' }],
          effort: 'low',
          max_tokens: 4096,
        });
        if (!text.trim()) return { model, ok: false, ms: Date.now() - t0, error: `ردٌّ بلا نص (${raw?.stop_reason ?? '—'})` };
        // النموذج الذي خدم الطلب قد يخالف المطلوب إن تدخّل البديل التلقائي.
        return { model, ok: true, ms: Date.now() - t0, served_by: raw?.model ?? model, sample: text.trim().slice(0, 40) };
      } catch (e: any) {
        return { model, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e) };
      }
    })
  );
  return c.json({ ok: checks.every((r) => r.ok), checks });
});

// ── إعداد نماذج الاستشارات (البرومبت + الحقول + طلب الملف) ──
app.get('/consultation-configs', async (c) => {
  const configs = await getAllEffectiveConfigs(c.env);
  return c.json({ configs });
});

app.put('/consultation-configs/:key', async (c) => {
  const key = c.req.param('key');
  const body = await c.req.json().catch(() => ({}));
  // نبني إعدادًا كاملًا فوق الافتراضي لضمان الحقول الأساسية
  const merged = { ...defaultConfig(key), ...body, key };
  await c.env.DB.prepare(
    'INSERT INTO consultation_configs (key, config_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at'
  )
    .bind(key, JSON.stringify(merged), Date.now())
    .run();
  await audit(c, 'consultation_config.update', key, {});
  return c.json({ ok: true, config: merged });
});

// إعادة نوع استشارة إلى الافتراضي
app.delete('/consultation-configs/:key', async (c) => {
  const key = c.req.param('key');
  await c.env.DB.prepare('DELETE FROM consultation_configs WHERE key = ?').bind(key).run();
  await audit(c, 'consultation_config.reset', key, {});
  return c.json({ ok: true, config: await getEffectiveConfig(c.env, key) });
});

// ── المصادر الخارجية (خوادم MCP) ──
app.get('/sources', async (c) => c.json({ sources: await listSources(c.env) }));

/* الحقول القابلة للتحرير — قائمةٌ بيضاء لا `...body`.
   `id` و`kind` ليسا منها: تبديلُ معرّفٍ يفصل الصفَّ عن مفتاحه في `MCP_TOKENS`
   وعن محوّله في `lib/external.ts` معاً، فيصير مصدراً بلا قارئ. */
app.put('/sources/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await getSource(c.env, id);
  if (!existing) return c.json({ error: 'المصدر غير موجود' }, 404);
  const b = await c.req.json().catch(() => ({} as any));

  const endpoint = typeof b.endpoint === 'string' ? b.endpoint.trim() : existing.endpoint;
  /* العنوان `https` أو لا شيء: رمزُ وصولٍ على `http` يُرسَل بلا تعمية.
     والفارغ مسموح — هو حالُ مصدرٍ لم يُضبط بعد. */
  if (endpoint && !endpoint.startsWith('https://')) {
    return c.json({ error: 'العنوان يجب أن يبدأ بـ https://' }, 400);
  }
  const role = b.role === 'legal' || b.role === 'fiqh' ? b.role : existing.role;
  const args = typeof b.args_json === 'string' ? b.args_json : JSON.stringify(existing.args);
  try {
    JSON.parse(args);
  } catch {
    return c.json({ error: 'المعاملات ليست JSON صحيحاً' }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE external_sources SET label = ?, endpoint = ?, role = ?, enabled = ?, search_tool = ?,
       args_json = ?, query_field = ?, limit_field = ?, max_results = ?, timeout_ms = ?, token_key = ?,
       auth_scheme = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      typeof b.label === 'string' && b.label.trim() ? b.label.trim() : existing.label,
      endpoint || null,
      role,
      b.enabled === true || b.enabled === 1 ? 1 : 0,
      typeof b.search_tool === 'string' && b.search_tool.trim() ? b.search_tool.trim() : existing.searchTool,
      args,
      typeof b.query_field === 'string' && b.query_field.trim() ? b.query_field.trim() : existing.queryField,
      typeof b.limit_field === 'string' ? b.limit_field.trim() || null : existing.limitField,
      Math.min(Math.max(Number(b.max_results) || existing.maxResults, 1), 25),
      Math.min(Math.max(Number(b.timeout_ms) || existing.timeoutMs, 2000), 30000),
      typeof b.token_key === 'string' ? b.token_key.trim() || null : existing.tokenKey,
      b.auth_scheme === 'basic' || b.auth_scheme === 'bearer' || b.auth_scheme === 'oauth'
        ? b.auth_scheme
        : existing.authScheme,
      Date.now(),
      id
    )
    .run();
  // والرمز نفسه لا يمرّ من هنا ولا يُسجَّل: مكانه `wrangler secret put`.
  await audit(c, 'external_source.update', id, { role, enabled: b.enabled === true });
  return c.json({ ok: true, source: await getSource(c.env, id) });
});

/* فحصٌ حيّ: مصافحةٌ واستعلامٌ قصير، ونتيجتُه تُقيَّد في الصفّ.
   فسببُ التعذّر يُقرأ في الشاشة — «غير مربوط» أم «تعذّر الوصول» — لا في
   سجلّات العامل. */
app.post('/sources/:id/test', async (c) => {
  const id = c.req.param('id');
  const source = await getSource(c.env, id);
  if (!source) return c.json({ error: 'المصدر غير موجود' }, 404);
  if (!source.endpoint) {
    await recordCheck(c.env, id, 'unconfigured', 'لا عنوان للمصدر');
    return c.json({ ok: false, status: 'unconfigured', error: 'لا عنوان للمصدر' });
  }
  const outcome = await searchSource(c.env, source, 'الإجارة');

  /* وحين يدلّ ٤٠١ على وثيقة موارد فالخادم على OAuth، ورسالةُ التعذّر تقول
     ذلك ولا تقول أكثر. فيُسبَر البابُ هنا وحده — في الفحص الذي يطلبه
     المسؤول صراحةً، لا في كلّ استعلامٍ فقهيّ — ويُعرض ما وراءه: أيُّ خادمٍ
     يُفوّض، وأيَّ نطاقاتٍ يطلب، وهل يقبل تسجيلاً ديناميّاً.
     وسقوطُ المسبار لا يمسّ النتيجة: تبقى كما كانت، ويُقرأ سببُها كما كان. */
  const discovered = outcome.resourceMetadata
    ? await discoverForEndpoint(source.endpoint!, source.timeoutMs, outcome.resourceMetadata)
    : null;

  /* ويُقيَّد في الصفّ سطرٌ واحد — اسمُ خادم التفويض — لا الوثيقةُ كلُّها:
     `last_error` تُقرأ في الشاشة بعد إعادة التحميل، وإغراقُها بجسمٍ كامل
     يُخفي الجملة التي تقول ما يُفعل. والتفصيلُ يعود في ردّ هذا الطلب. */
  const server = discovered?.issuer ?? discovered?.authorizationServers[0];
  const note = server
    ? [outcome.error, `خادم التفويض: ${server}`].filter(Boolean).join(' · ')
    : (outcome.error ?? null);
  await recordCheck(c.env, id, outcome.status, note);
  await audit(c, 'external_source.test', id, { status: outcome.status, oauth: !!discovered });
  return c.json({
    ok: outcome.status === 'ok',
    status: outcome.status,
    error: outcome.error,
    hits: outcome.hits.length,
    discovered,
  });
});

/* بدءُ التفويض — بمنحة الآلة.
 *
 * ولا رحلةَ متصفّح هنا: الخادم يُعلن `client_credentials`، فتُسجَّل المنصةُ
 * عميلاً وتأخذ رمزاً باسمها. وهي أقصرُ الطريقين وأسلمُهما — لا رمزَ مسحوبٌ
 * من حساب إنسانٍ يخدم كلَّ مستخدمي المنصة.
 *
 * و`POST` لا `GET`: يُسجَّل عميلٌ عند خادمٍ أجنبيّ ويُكتب اعتمادٌ مختوم،
 * ورابطٌ يفعل ذلك بمجرّد فتحه تكفي صورةٌ في صفحةٍ أجنبية لتشغيله — وهي
 * عينُ علّة الخروج بـ`GET` الموصوفة في `web/src/lib/api.ts`.
 */
app.post('/sources/:id/authorize', async (c) => {
  const id = c.req.param('id');
  const source = await getSource(c.env, id);
  if (!source) return c.json({ error: 'المصدر غير موجود' }, 404);
  if (!source.endpoint) return c.json({ error: 'لا عنوان للمصدر' }, 400);

  /* التحدّي يُستدرّ بمصدرٍ صوريّ نوعُه «رمز حامل»: الصفُّ على التفويض بلا
     رمزٍ بعد، فحارسُ `callTool` كان يردّ قبل أن يُرسَل طلبٌ أصلاً. */
  const bare: ExternalSource = { ...source, authScheme: 'bearer', tokenKey: null };
  const challenge = await callTool(c.env, bare, null, source.searchTool, {
    ...source.args,
    [source.queryField]: 'الإجارة',
    ...(source.limitField ? { [source.limitField]: 1 } : {}),
  });
  if (challenge.ok) {
    return c.json({ error: 'الخادم يستجيب بلا اعتماد — لا تفويضَ يلزم' }, 400);
  }
  if (!challenge.resourceMetadata) {
    return c.json({ error: `لا وثيقةَ موارد في ردّ الخادم · ${challenge.message}` }, 400);
  }

  const found = await discoverForEndpoint(source.endpoint, source.timeoutMs, challenge.resourceMetadata);
  if (!found) return c.json({ error: 'تعذّرت قراءة وثيقة الموارد' }, 400);

  /* منحةُ الآلة أوّلاً: إن قبلها الخادم انتهى الأمر بلا إنسانٍ ولا متصفّح،
     ولا رمزَ مسحوبٌ من حسابِ أحد. وخادمُ الشاملة يُعلنها ثم يشترط لها تسجيلاً
     مُصادَقاً — فالمحاولةُ تبقى لأن غيره قد يقبلها، وسقوطُها ليس نهاية. */
  const machine = await authorizeMachine(c.env, source, found);
  if (machine.ok) {
    await recordCheck(c.env, id, 'ok', null);
    await audit(c, 'external_source.authorize', id, { ok: true, grant: 'client_credentials' });
    return c.json({ ...machine, grant: 'client_credentials' });
  }

  /* وإلّا فإذنُ إنسانٍ في متصفّح. وسرُّ الربط يُكتب كوكيّاً على مسار
     الاستقبال وحده: يُثبت أن الردّ عاد إلى المتصفّح الذي بدأ — وكونُ الزائر
     مسؤولاً لا يُثبت ذلك. */
  const redirectUri = `${new URL(c.req.url).origin}/auth/mcp/callback`;
  const started = await startAuthorization(
    c.env,
    source,
    found,
    redirectUri,
    challenge.challengeScope
  );
  if ('ok' in started) {
    await recordCheck(c.env, id, 'unconfigured', `${machine.error ?? ''} · ${started.message}`.trim());
    await audit(c, 'external_source.authorize', id, { ok: false });
    return c.json({ ok: false, steps: machine.steps, error: started.message }, 400);
  }
  await audit(c, 'external_source.authorize', id, { ok: false, grant: 'authorization_code', issuer: found.issuer });
  c.header(
    'set-cookie',
    `${BIND_COOKIE}=${encodeURIComponent(started.bindSecret)}; HttpOnly; Secure; SameSite=Lax; Path=/auth/mcp; Max-Age=600`
  );
  return c.json({
    ok: false,
    grant: 'authorization_code',
    steps: [...machine.steps, `منحةُ الآلة تعذّرت: ${machine.error ?? '—'}`, 'يلزم إذنُك في المتصفّح'],
    url: started.url,
  });
});

/* سحبُ التفويض — يُمحى المختوم ويعود المصدر «غير مربوط».
   ولا إبطالَ عند الخادم: لا نقطةَ إبطالٍ في بياناته، ومحوُ ما عندنا يمنع
   الاستعمال. والتسجيلُ يبقى عنده حتى يُزيله مشغّله — يُقال ولا يُدَّعى غيره. */
app.post('/sources/:id/revoke', async (c) => {
  const id = c.req.param('id');
  const source = await getSource(c.env, id);
  if (!source) return c.json({ error: 'المصدر غير موجود' }, 404);
  await forget(c.env, id);
  await recordCheck(c.env, id, 'unconfigured', 'سُحب التفويض');
  await audit(c, 'external_source.revoke', id, {});
  return c.json({ ok: true });
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
    await ingestDocument(env, docId);
  } catch {
    await env.DB.prepare("UPDATE kb_documents SET ingest_status = 'error' WHERE id = ?").bind(docId).run();
  }
}

/** يضبط حقول قالب المستند المُرسَلة داخل الحدود، ويترك ما عداها كما هو. */
function clampDocTemplateFields(body: Record<string, unknown>): void {
  const present = DOC_TEMPLATE_KEYS.filter((k) => k in body);
  if (!present.length) return;
  const raw: Record<string, string> = {};
  for (const k of present) raw[k] = String(body[k] ?? '');
  const t = normalizeDocTemplate(raw);
  const clamped: Record<(typeof DOC_TEMPLATE_KEYS)[number], string | number> = {
    doc_font_family: t.fontFamily,
    doc_heading_pt: t.headingPt,
    doc_body_pt: t.bodyPt,
    doc_margin_top_mm: t.marginTopMm,
    doc_margin_bottom_mm: t.marginBottomMm,
    doc_margin_side_mm: t.marginSideMm,
  };
  for (const k of present) body[k] = clamped[k];
}

export default app;
