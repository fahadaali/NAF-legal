// مذكرة البحث قبل الصياغة — تُبنى، ويعدّل المحامي أسانيدها، ويعتمدها، ثم يُصاغ منها.
//
//   POST  /api/research/:conversationId      يبني مذكرةً لسؤالٍ دون أن يصوغ (مسودّة)؛
//                                            و`deep: true` يُكملها Claude بأدوات البحث
//   GET   /api/research/memos/:id            المذكرة بمسائلها وموادّها وما لا سند له
//   GET   /api/research/jobs/:id             حالُ مهمّةٍ في الخلفية (`async: true`) ومذكرتُها
//   GET   /api/research/conversations/:id/job  مهمّةٌ لم يُصَغ بعدها — لمن عاد إلى المحادثة
//   PATCH /api/research/memos/:id            يحذف موادّ أو يضيف موادّ — نسخةٌ جديدة
//   POST  /api/research/memos/:id/approve    يعتمدها باسم المعتمِد
//
// والصياغة منها بـ`memo_id` في `POST /api/chat/:conversationId`: لا بحثٌ جديد ولا
// استيضاح، والموادّ تُجلب بنصّها الجاري.
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { buildResearchMemo } from '../lib/research/build';
import { getOwnedMemo, saveMemo, type Memo, type MemoGroup } from '../lib/research/memo';
import { getChunkById, articleBaseId } from '../lib/legal';
import type { ConsultationType, Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

/** موادُّ يضيفها المحامي في الطلب الواحد. */
const ADD_MAX = 20;

/** مهمّةٌ لا يتحرّك تقدّمها هذه المدّة تُعدّ متعطّلة: كلُّ جولةٍ تكتب تقدّمها، ولا جولة تبلغها. */
const STALLED_MS = 20 * 60_000;

app.post('/:conversationId', async (c) => {
  const user = c.get('user');
  const conversationId = c.req.param('conversationId');
  const conv = await c.env.DB.prepare('SELECT id, consultation_type FROM conversations WHERE id = ? AND user_id = ?')
    .bind(conversationId, user.id)
    .first<{ id: string; consultation_type: string | null }>();
  if (!conv) return c.json({ error: 'المحادثة غير موجودة' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const message = String(body.message ?? '').trim();
  if (!message) return c.json({ error: 'الرسالة فارغة' }, 400);

  const attachmentIds: string[] = Array.isArray(body.attachment_ids)
    ? body.attachment_ids.filter((x: unknown) => typeof x === 'string').slice(0, 10)
    : [];
  const consultationType = (conv.consultation_type ?? undefined) as ConsultationType | undefined;

  /* في الخلفية: مهمّةٌ في `ResearchRunner` تبني المذكرة ولو أُغلق المتصفّح، ويُتابَع
     تقدّمها من `GET /jobs/:id`. وهي الأصل للبحث المعمّق: جولاتُه دقائق لا ثوانٍ. */
  if (body.async === true && c.env.RESEARCH) {
    const jobId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO research_jobs (id, conversation_id, user_id, message, consultation_type, attachment_ids_json, deep,
                                  status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`
    )
      .bind(jobId, conversationId, user.id, message, consultationType ?? null, JSON.stringify(attachmentIds), body.deep === true ? 1 : 0, Date.now(), Date.now())
      .run();
    try {
      const stub = c.env.RESEARCH.get(c.env.RESEARCH.idFromName(jobId));
      const res = await stub.fetch('https://research/start', { method: 'POST', body: jobId });
      if (!res.ok) throw new Error(`runner ${res.status}`);
    } catch (e) {
      console.error('research job start failed:', jobId, e);
      await c.env.DB.prepare("UPDATE research_jobs SET status = 'failed', error = 'research_failed', updated_at = ? WHERE id = ?")
        .bind(Date.now(), jobId)
        .run();
      return c.json({ error: 'تعذّر بدء البحث', job_id: jobId }, 503);
    }
    return c.json({ job_id: jobId }, 202);
  }

  const { memoId, plan } = await buildResearchMemo(c.env, {
    conversationId,
    userId: user.id,
    message,
    consultationType,
    attachmentIds,
    deep: body.deep === true,
  });
  return c.json({ memo: await getOwnedMemo(c.env, memoId, user.id), plan });
});

/**
 * آخرُ مهمّة بحثٍ في المحادثة لم يُصَغ بعدها شيء — لمن عاد إلى المحادثة والبحثُ
 * جارٍ أو تمّ ولم يُصَغ منه. ومهمّةٌ بعدها رسالةٌ في المحادثة قد طُويت.
 */
app.get('/conversations/:id/job', async (c) => {
  const user = c.get('user');
  const job = await c.env.DB.prepare(
    `SELECT j.id FROM research_jobs j
     WHERE j.conversation_id = ? AND j.user_id = ?
       AND j.created_at > COALESCE((SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = j.conversation_id), 0)
     ORDER BY j.created_at DESC LIMIT 1`
  )
    .bind(c.req.param('id'), user.id)
    .first<{ id: string }>();
  return c.json({ job_id: job?.id ?? null });
});

/** حالُ مهمّة البحث في الخلفية، ومذكرتُها حين تتمّ. */
app.get('/jobs/:id', async (c) => {
  const user = c.get('user');
  const job = await c.env.DB.prepare('SELECT * FROM research_jobs WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id)
    .first<Record<string, any>>();
  if (!job) return c.json({ error: 'غير موجودة' }, 404);
  // مهمّةٌ لم يتحرّك تقدّمها مدّةً أطول من أيّ بحثٍ معمّق — انقطع منفّذها دون أن يكتب.
  const stalled = (job.status === 'queued' || job.status === 'running') && Date.now() - job.updated_at > STALLED_MS;
  return c.json({
    job: {
      id: job.id,
      conversation_id: job.conversation_id,
      // السؤال نفسه: لم يُحفظ رسالةً في المحادثة بعد — يُحفظ حين يُصاغ منه.
      message: job.message,
      deep: job.deep === 1,
      status: stalled ? 'failed' : job.status,
      stage: job.stage,
      progress: job.progress_json ? JSON.parse(job.progress_json) : null,
      error: stalled ? 'research_stalled' : job.error,
      created_at: job.created_at,
      updated_at: job.updated_at,
    },
    memo: job.memo_id ? await getOwnedMemo(c.env, job.memo_id, user.id) : null,
  });
});

app.get('/memos/:id', async (c) => {
  const memo = await getOwnedMemo(c.env, c.req.param('id'), c.get('user').id);
  if (!memo) return c.json({ error: 'غير موجودة' }, 404);
  return c.json({ memo });
});

/**
 * تعديل الأسانيد: نسخةٌ جديدة لا تعديلٌ في المكان — المذكرة التي صيغ منها دورٌ
 * سابق تبقى كما كانت، فيُعرف من أيّ أسانيد صيغ.
 */
app.patch('/memos/:id', async (c) => {
  const user = c.get('user');
  const memo = await getOwnedMemo(c.env, c.req.param('id'), user.id);
  if (!memo) return c.json({ error: 'غير موجودة' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const remove = new Set<string>(Array.isArray(body.remove) ? body.remove.filter((k: unknown) => typeof k === 'string') : []);
  const add: string[] = Array.isArray(body.add) ? body.add.filter((k: unknown) => typeof k === 'string').slice(0, ADD_MAX) : [];

  let groups: MemoGroup[] = memo.groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !remove.has(i.key)) }))
    .filter((g) => g.items.length);

  const present = new Set(groups.flatMap((g) => g.items.map((i) => i.key)));
  const added: MemoGroup['items'] = [];
  const missing: string[] = [];
  for (const chunkId of add) {
    // المادة تُضاف إن كانت نافذة سليمة — بالتصفية نفسها، فلا يُضاف ملغى.
    const hit = await getChunkById(c.env, chunkId);
    const key = hit ? `legal:${articleBaseId(hit.id)}` : null;
    if (!hit || !key) {
      missing.push(chunkId);
      continue;
    }
    if (present.has(key)) continue;
    present.add(key);
    added.push({ key, seq: hit.seq, title: [hit.lawTitle, hit.articleNo ? `المادة ${hit.articleNo}` : hit.articleLabel].filter(Boolean).join(' — ') });
  }
  if (added.length) groups = [{ kind: 'explicit', title: 'موادّ أضافها المحامي', layer: null, items: added }, ...groups];

  const id = await saveMemo(c.env, {
    conversationId: memo.conversation_id,
    messageId: memo.message_id,
    groups,
    gaps: memo.gaps,
    status: 'draft',
    version: memo.version + 1,
  });
  return c.json({ memo: await getOwnedMemo(c.env, id, user.id), missing });
});

app.post('/memos/:id/approve', async (c) => {
  const user = c.get('user');
  const memo: Memo | null = await getOwnedMemo(c.env, c.req.param('id'), user.id);
  if (!memo) return c.json({ error: 'غير موجودة' }, 404);
  await c.env.DB.prepare("UPDATE research_memos SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?")
    .bind(user.email ?? user.id, Date.now(), memo.id)
    .run();
  return c.json({ memo: await getOwnedMemo(c.env, memo.id, user.id) });
});

export default app;
