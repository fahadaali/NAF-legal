// قياسُ الاسترجاع — للمسؤول وحده.
//
// `POST /retrieve` يشغّل خطّ الاسترجاع نفسه الذي يمرّ به دور المحادثة
// (`lib/research/gather.ts`) على سؤالٍ يُعطى، ويعيد ما رجع بأنظمته وموادّه دون
// توليد. وعليه يبني `scripts/eval-retrieval.mjs` قياسَه على مجموعة القضايا.
// و`GET /traces` يعرض أثر الأدوار المحفوظ — وما تعطّل منها أولاً إن طُلب.
import { Hono } from 'hono';
import { requireAuth, requireAdmin } from '../lib/auth';
import { runPlanner } from '../lib/planner';
import { gatherLegalContext } from '../lib/research/gather';
import { newTrace } from '../lib/research/trace';
import type { ConsultationType, Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth, requireAdmin);

/** أقصى طول سؤالٍ يُقاس — سؤال محامٍ لا مستندٌ كامل. */
const MAX_MESSAGE = 8000;

app.post('/retrieve', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const message = String(body.message ?? '').trim().slice(0, MAX_MESSAGE);
  if (!message) return c.json({ error: 'الرسالة فارغة' }, 400);
  const type = typeof body.consultation_type === 'string' ? (body.consultation_type as ConsultationType) : undefined;

  const trace = newTrace();
  const started = Date.now();
  const plan = await runPlanner(c.env, message, type, false, false, user.id);
  trace.add({ stage: 'planner', count: plan.kb_queries.length, detail: plan.consultation_type });
  const gathered = await gatherLegalContext(c.env, { plan, message, userId: user.id, trace });

  return c.json({
    plan,
    queries: gathered.queries,
    anchors: gathered.anchors.length,
    groups: gathered.groups.map((g) => ({
      kind: g.kind,
      title: g.title,
      layer: g.layer ?? null,
      keys: g.results.map((r) => r.key ?? r.documentId),
    })),
    results: gathered.results.map((r) => ({
      key: r.key ?? r.documentId,
      source: r.source ?? 'document',
      law_id: r.lawId ?? null,
      law_title: r.title,
      article_no: r.articleNo ?? null,
      article_ref: r.articleRef ?? null,
      doc_type: r.docType ?? null,
      score: r.score,
      warning: r.retrievalWarning ?? null,
    })),
    steps: trace.steps,
    failed: trace.failed,
    ms: Date.now() - started,
  });
});

app.get('/traces', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
  const onlyFailed = c.req.query('failed') === '1';
  const rows = await c.env.DB.prepare(
    `SELECT id, conversation_id, message_id, user_id, consultation_type, plan_json, steps_json,
            result_keys_json, failed, created_at
     FROM retrieval_traces ${onlyFailed ? 'WHERE failed = 1' : ''}
     ORDER BY created_at DESC LIMIT ?`
  )
    .bind(limit)
    .all<Record<string, any>>();
  const failedCount = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM retrieval_traces WHERE failed = 1').first<{
    n: number;
  }>();
  return c.json({
    failed_total: failedCount?.n ?? 0,
    traces: (rows.results ?? []).map((r) => ({
      ...r,
      plan: r.plan_json ? JSON.parse(r.plan_json) : null,
      steps: JSON.parse(r.steps_json),
      result_keys: JSON.parse(r.result_keys_json),
      plan_json: undefined,
      steps_json: undefined,
      result_keys_json: undefined,
    })),
  });
});

export default app;
