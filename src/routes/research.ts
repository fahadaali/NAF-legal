// مذكرة البحث قبل الصياغة — تُبنى، ويعدّل المحامي أسانيدها، ويعتمدها، ثم يُصاغ منها.
//
//   POST  /api/research/:conversationId      يبني مذكرةً لسؤالٍ دون أن يصوغ (مسودّة)
//   GET   /api/research/memos/:id            المذكرة بمسائلها وموادّها وما لا سند له
//   PATCH /api/research/memos/:id            يحذف موادّ أو يضيف موادّ — نسخةٌ جديدة
//   POST  /api/research/memos/:id/approve    يعتمدها باسم المعتمِد
//
// والصياغة منها بـ`memo_id` في `POST /api/chat/:conversationId`: لا بحثٌ جديد ولا
// استيضاح، والموادّ تُجلب بنصّها الجاري.
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { runPlanner } from '../lib/planner';
import { gatherLegalContext } from '../lib/research/gather';
import { newTrace, saveTrace } from '../lib/research/trace';
import { getOwnedMemo, memoGroups, saveMemo, type Memo, type MemoGroup } from '../lib/research/memo';
import { getChunkById, articleBaseId } from '../lib/legal';
import type { ConsultationType, Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

/** موادُّ يضيفها المحامي في الطلب الواحد. */
const ADD_MAX = 20;

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

  // مرفقاتٌ في صندوق الكتابة لم تُرسَل — مدخلُ «الاستدلال النظامي».
  const ids: string[] = Array.isArray(body.attachment_ids) ? body.attachment_ids.filter((x: unknown) => typeof x === 'string').slice(0, 10) : [];
  const atts = ids.length
    ? await c.env.DB.prepare(
        `SELECT parsed_text FROM attachments WHERE conversation_id = ? AND id IN (${ids.map(() => '?').join(',')})
         AND parsed_text IS NOT NULL`
      )
        .bind(conversationId, ...ids)
        .all<{ parsed_text: string }>()
    : { results: [] as { parsed_text: string }[] };

  const type = (conv.consultation_type ?? undefined) as ConsultationType | undefined;
  const plan = await runPlanner(c.env, message, type, ids.length > 0, false, user.id);
  const trace = newTrace();
  const gathered = await gatherLegalContext(c.env, {
    plan,
    message,
    attachmentsText: (atts.results ?? []).map((a) => a.parsed_text),
    userId: user.id,
    trace,
  });
  const groups = gathered.groups.length
    ? gathered.groups
    : gathered.results.length
      ? [{ kind: 'issue' as const, title: 'نتائج البحث', results: gathered.results }]
      : [];
  const id = await saveMemo(c.env, {
    conversationId,
    messageId: null,
    groups: memoGroups(groups),
    gaps: gathered.gaps,
    status: 'draft',
  });
  await saveTrace(c.env, {
    conversationId,
    messageId: null,
    userId: user.id,
    plan,
    trace,
    resultKeys: gathered.results.map((r) => r.key ?? r.documentId),
  });
  return c.json({ memo: await getOwnedMemo(c.env, id, user.id), plan });
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
