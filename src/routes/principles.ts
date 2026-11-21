// طبقة المبادئ القضائية: الاستيراد والبحث والاستدعاء.
//
// مسارٌ وحده لا فرعٌ من `/api/legal`: المبدأ ليس مادة، ولا يمرّ بشيءٍ من مسارات
// الموادّ (`lib/principles.ts`). والاستيراد للمسؤول وحده، والقراءة لكل من دخل.
//
// والاستيراد جمعٌ ثم كتابة، كعقد الموادّ (`docs/legal-import.md` §١٦):
//   POST /stage?import_id=…&first_line=…   جزءٌ من الملف، يُجمع جانباً
//   POST /commit {import_id}               يستبدل مدوّنات الملف في دفعةٍ واحدة
//   POST /abort  {import_id}               يُسقط ما جُمع
// وسطرٌ فاسد واحد يردّ الجزء كلَّه: لا «قبول الصالح» هنا.
import { Hono } from 'hono';
import { requireAuth, requireAdmin, audit } from '../lib/auth';
import {
  parsePrinciples,
  stagePrinciples,
  commitPrinciples,
  abortPrinciples,
  searchPrinciples,
  getPrinciple,
  listPrincipleCollections,
  PRINCIPLE_SEARCH_MAX,
} from '../lib/principles';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

/** سقفُ الجزء الواحد بالبايت — الأداة ترسل ٢٠٠ سطر، وأطولُ مبدأ دون ٥ ك.ب. */
const MAX_PART_BYTES = 4 * 1024 * 1024;

/** معرّف الاستيراد: ما تولّده الأداة (UUID) — لا مسافات ولا رموز. */
const IMPORT_ID = /^[A-Za-z0-9-]{8,64}$/;

app.post('/stage', requireAdmin, async (c) => {
  const importId = c.req.query('import_id') ?? '';
  if (!IMPORT_ID.test(importId)) return c.json({ error: '`import_id` غير صالح' }, 400);
  const firstLine = Math.max(1, Number(c.req.query('first_line') ?? 1) || 1);
  const bytes = await c.req.arrayBuffer();
  if (!bytes.byteLength) return c.json({ error: 'الجزء فارغ' }, 400);
  if (bytes.byteLength > MAX_PART_BYTES) return c.json({ error: 'الجزء أكبر من الحدّ — قلّل --batch' }, 413);
  const parsed = parsePrinciples(new TextDecoder().decode(bytes), firstLine);
  if (parsed.errors.length) {
    return c.json({ error: 'في الجزء أسطرٌ مرفوضة — لم يُجمع منه شيء', lines: parsed.total, errors: parsed.errors.slice(0, 50) }, 422);
  }
  const staged = await stagePrinciples(c.env, importId, parsed.rows, firstLine);
  return c.json({ staged, collections: parsed.collections });
});

app.post('/commit', requireAdmin, async (c) => {
  const body = await c.req.json<{ import_id?: string }>().catch(() => ({}) as { import_id?: string });
  const importId = body.import_id ?? '';
  if (!IMPORT_ID.test(importId)) return c.json({ error: '`import_id` غير صالح' }, 400);
  try {
    const result = await commitPrinciples(c.env, importId);
    await audit(c, 'principles.import', importId, { ...result });
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e?.message ?? 'تعذّرت الكتابة' }, 409);
  }
});

app.post('/abort', requireAdmin, async (c) => {
  const body = await c.req.json<{ import_id?: string }>().catch(() => ({}) as { import_id?: string });
  const importId = body.import_id ?? '';
  if (!IMPORT_ID.test(importId)) return c.json({ error: '`import_id` غير صالح' }, 400);
  await abortPrinciples(c.env, importId);
  return c.json({ aborted: importId });
});

app.get('/collections', async (c) => c.json({ collections: await listPrincipleCollections(c.env) }));

app.get('/search', async (c) => {
  const q = c.req.query('q')?.trim() ?? '';
  if (!q) return c.json({ error: 'اكتب q' }, 400);
  const hits = await searchPrinciples(c.env, q, {
    limit: Math.min(Number(c.req.query('limit') ?? 10) || 10, PRINCIPLE_SEARCH_MAX),
    collectionId: c.req.query('collection_id') ?? null,
    parentLawId: c.req.query('parent_law_id') ?? null,
  });
  return c.json({ results: hits, count: hits.length });
});

app.get('/item', async (c) => {
  const id = c.req.query('id') ?? '';
  if (!id) return c.json({ error: 'اكتب id' }, 400);
  const hit = await getPrinciple(c.env, id);
  return hit ? c.json(hit) : c.json({ error: 'لا مبدأ بهذا المعرّف' }, 404);
});

export default app;
