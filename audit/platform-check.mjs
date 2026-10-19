// فحوص سلوك المنصة على شيفرتها الفعلية — مسارات Hono ووحدات `src/lib` فوق قاعدةٍ
// بهجرات المستودع. كل فحصٍ هنا يقابل خطأً وُجد فعلاً، فيبقى شاهداً عليه لا يعود.
//
//   npm run check:platform
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, bundle, makeDb, makeKv, makeCtx, fakeAnthropic, suite } from './harness.mjs';

const t = suite('فحوص المنصة');

/** مستخدمٌ ثابت تحقنه بدائلُ المصادقة — المسارات تُفحص بلا مركز الهوية. */
const AUTH_STUB = `
export async function requireAuth(c: any, next: any) {
  c.set('user', (globalThis as any).__naf_user ?? { id: 'u1', email: 'a@x', role: 'admin' });
  await next();
}
export const requireAdmin = requireAuth;
export const requireWriter = requireAuth;
export async function audit() {}
`;

const routes = await bundle(
  'platform-routes',
  `export { default as search } from './search';
   export { parseJsonl, upsertLegalChunks } from '../lib/legal';
   export { retrieve } from '../lib/rag';
   import { Hono } from 'hono';
   import chatRoutes from './chat';
   // كما في \`src/index.ts\`: الخطأ يصل \`app.onError\` فيُكتب في \`c.error\`.
   export const chatApp = new Hono()
     .onError((e, c) => c.json({ error: 'تعذّر إتمام العملية. أعد المحاولة بعد قليل' }, 500))
     .route('/api/chat', chatRoutes);`,
  { resolveDir: path.join(ROOT, 'src', 'routes'), stubs: { '../lib/auth': AUTH_STUB } }
);

async function seedConversation(db, { user = 'u1', convId = 'c1', content, folder = null }) {
  db.q('INSERT OR IGNORE INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)', user, `${user}@x`, '-', 1);
  db.sqlite
    .prepare('INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(convId, user, 'عنوان', 1, 1);
  if (folder) db.sqlite.prepare('UPDATE conversations SET folder_id = ? WHERE id = ?').run(folder, convId);
  db.sqlite
    .prepare('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(`${convId}-m`, convId, 'user', content, 2);
}

console.log('\nالبحث في المحادثات والمخرجات');

await t.check('بحثٌ عن كلمةٍ في رسالة المستخدم نفسه يجدها', async () => {
  const db = await makeDb();
  await seedConversation(db, { content: 'نزاع عمالي حول مكافأة نهاية الخدمة' });
  const res = await routes.search.request('/?q=مكافأة&scope=chats', {}, { DB: db.DB, KV: makeKv() });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.chats.length, 1, `المتوقع نتيجة واحدة، والواقع ${body.chats.length}`);
  assert.match(body.chats[0].snippet, /مكافأة/);
});

await t.check('لا يجد ما في محادثات مستخدمٍ آخر', async () => {
  const db = await makeDb();
  await seedConversation(db, { user: 'u2', convId: 'c2', content: 'نزاع عمالي حول مكافأة نهاية الخدمة' });
  const res = await routes.search.request('/?q=مكافأة&scope=chats', {}, { DB: db.DB, KV: makeKv() });
  assert.equal((await res.json()).chats.length, 0);
});

await t.check('بحث المخرجات يجد نسخة المسودّة', async () => {
  const db = await makeDb();
  await seedConversation(db, { content: 'سؤال' });
  db.sqlite
    .prepare('INSERT INTO draft_versions (id, message_id, version, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('d1', 'c1-m', 1, 'صحيفة دعوى بطلب التعويض عن الضرر', 3);
  const res = await routes.search.request('/?q=التعويض&scope=outputs', {}, { DB: db.DB, KV: makeKv() });
  assert.equal((await res.json()).outputs.length, 1);
});

// ── دور المحادثة ──

const ENV_BASE = {
  ANTHROPIC_API_KEY: 'test',
  PLANNER_MODEL: 'claude-opus-5-5',
  GENERATION_MODEL: 'claude-opus-5-5',
  EMBEDDING_MODEL: '@cf/baai/bge-m3',
};

/** محادثةٌ وقاعدةٌ فيها مادةٌ واحدة من نظام العمل. */
async function chatFixture() {
  const db = await makeDb();
  db.q('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)', 'u1', 'u1@x', '-', 1);
  db.q('INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', 'c1', 'u1', 'محادثة جديدة', 1, 1);
  const rows = routes.parseJsonl(
    JSON.stringify({
      id: 'labor:84', law_id: 'labor', doc_type: 'law', article_no: '84', status: 'active', law_title: 'نظام العمل',
      text: 'إذا انتهت علاقة العمل وجب على صاحب العمل أن يدفع إلى العامل مكافأة عن مدة خدمته.',
      embed_text: 'نظام العمل — المادة 84 — مكافأة نهاية الخدمة.',
    })
  ).rows;
  const env = { ...ENV_BASE, DB: db.DB, KV: makeKv() };
  await routes.upsertLegalChunks(env, rows);
  return { db, env };
}

async function sendTurn(env, message) {
  const ctx = makeCtx();
  const res = await routes.chatApp.request(
    '/api/chat/c1',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) },
    env,
    ctx
  );
  const text = res.body ? await res.text() : '';
  await ctx.settle();
  return { res, text };
}

const isPlanner = (b) => !b.stream && String(b.system ?? '').includes('مُخطِّط');
const isGeneration = (b) => !!b.stream;
const generationText = (b) => JSON.stringify(b.messages);

console.log('\nدور المحادثة');

await t.check('تعذّر المُخطِّط فلا يمضي التوليد بلا بحث: سؤال المحامي هو الاستعلام', async () => {
  const { env } = await chatFixture();
  const fake = fakeAnthropic((b) => (isPlanner(b) ? { status: 500 } : { text: 'رد' }));
  try {
    await sendTurn(env, 'ما حكم مكافأة نهاية الخدمة للعامل؟');
    const gen = fake.calls.find(isGeneration);
    assert.ok(gen, 'لم يُطلب التوليد');
    assert.match(generationText(gen), /سياق_نظامي/, 'لم يصل سياقٌ نظاميّ إلى التوليد');
    assert.match(generationText(gen), /المادة 84/);
  } finally {
    fake.restore();
  }
});

await t.check('خطأٌ قبل فتح البثّ لا يُبقي المحادثة «قيد التوليد»', async () => {
  const { env } = await chatFixture();
  // قاعدةٌ ترمي عند قراءة إعدادات نوع الاستشارة — بعد رفع العلامة وقبل البثّ.
  const DB = {
    ...env.DB,
    prepare: (sql) => {
      if (sql.includes('consultation_configs')) throw new Error('D1_ERROR: boom');
      return env.DB.prepare(sql);
    },
  };
  const fake = fakeAnthropic((b) => (isPlanner(b) ? { text: '{"needs_knowledge_base": false}' } : { text: 'رد' }));
  try {
    const { res } = await sendTurn({ ...env, DB }, 'سؤال');
    assert.equal(res.status, 500);
    assert.equal(await env.KV.get('gen:c1'), null, 'العلامة بقيت مرفوعة');
  } finally {
    fake.restore();
  }
});

await t.check('انقطاع البثّ في منتصفه: يُحفظ ما وصل موسوماً، ويُقال للمحامي', async () => {
  const { env, db } = await chatFixture();
  const fake = fakeAnthropic((b, n) =>
    isPlanner(b) ? { text: '{"needs_knowledge_base": false}' } : isGeneration(b) ? { text: 'أولاً: الوقائع. ثانياً: الأسانيد النظامية.', breakAfter: 1 } : { text: 'عنوان' }
  );
  try {
    const { text } = await sendTurn(env, 'سؤال');
    assert.match(text, /event: error/, 'لم يصل حدث خطأ');
    assert.match(text, /event: done/, 'لم تُختم الفقاعة');
    const saved = db.q("SELECT content, metadata_json FROM messages WHERE role = 'assistant'");
    assert.equal(saved.length, 1, 'ما وصل من النص لم يُحفظ');
    assert.equal(JSON.parse(saved[0].metadata_json).interrupted, true);
    assert.equal(await env.KV.get('gen:c1'), null);
  } finally {
    fake.restore();
  }
});

await t.check('الاسترجاع: سقفٌ لكل استعلام وسقفٌ للمجموع منفصلان', async () => {
  const { env } = await chatFixture();
  const more = routes.parseJsonl(
    [
      { id: 'labor:85', text: 'تُحسب مكافأة العامل على أساس الأجر الأخير.', article_no: '85' },
      { id: 'labor:80', text: 'لا يجوز لصاحب العمل فسخ العقد دون مكافأة إلا في حالات.', article_no: '80' },
    ]
      .map((x) => JSON.stringify({ ...x, law_id: 'labor', doc_type: 'law', status: 'active', law_title: 'نظام العمل', embed_text: x.text }))
      .join('\n')
  ).rows;
  await routes.upsertLegalChunks(env, more);
  const one = await routes.retrieve(env, ['مكافأة', 'فسخ العقد'], 1);
  const all = await routes.retrieve(env, ['مكافأة', 'فسخ العقد'], 1, 2);
  assert.equal(one.length, 1);
  assert.equal(all.length, 2, `المتوقع اثنتان (واحدة لكل استعلام)، والواقع ${all.length}`);
});

console.log('\nعميل Claude');

await t.check('التوليد يخزّن البرومبت والسجلّ مؤقّتاً، ولا يخزّن الرسالة الأخيرة', async () => {
  const { env, db } = await chatFixture();
  db.q("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('h1','c1','user','سؤال سابق',1)");
  db.q("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('h2','c1','assistant','جواب سابق',2)");
  const fake = fakeAnthropic((b) => (isPlanner(b) ? { text: '{"needs_knowledge_base": false}' } : { text: 'رد' }));
  try {
    await sendTurn(env, 'سؤال جديد');
    const gen = fake.calls.find(isGeneration);
    assert.ok(Array.isArray(gen.system) && gen.system[0].cache_control, 'البرومبت بلا نقطة تخزين');
    const msgs = gen.messages;
    const prev = msgs[msgs.length - 2].content;
    assert.ok(Array.isArray(prev) && prev[prev.length - 1].cache_control, 'آخر رسالة في السجلّ بلا نقطة تخزين');
    assert.equal(typeof msgs[msgs.length - 1].content, 'string', 'الرسالة الحالية وُسمت');
  } finally {
    fake.restore();
  }
});

await t.check('ازدحام الخدمة (529) يُعاد ولا يُسقط المُخطِّط إلى خطّته الاحتياطية', async () => {
  const { env } = await chatFixture();
  let plannerHits = 0;
  const fake = fakeAnthropic((b) => {
    if (isPlanner(b)) return ++plannerHits === 1 ? { status: 529 } : { text: '{"needs_knowledge_base": false, "kb_queries": []}' };
    return { text: 'رد' };
  });
  try {
    await sendTurn(env, 'سؤال');
    assert.equal(plannerHits, 2, `المُخطِّط طُلب ${plannerHits} مرّة`);
    const gen = fake.calls.find(isGeneration);
    assert.doesNotMatch(generationText(gen), /سياق_نظامي/, 'خطة المُخطِّط لم تُعتمد');
  } finally {
    fake.restore();
  }
});

await t.check('سجلّ الاستخدام يحفظ رموز التخزين المؤقّت ويسعّرها بسعرها', async () => {
  const { env, db } = await chatFixture();
  const lib = await bundle('platform-usage', `export { logUsage, computeCost } from './usage';`);
  await lib.logUsage(env, { kind: 'generation', model: 'claude-opus-5-5', inputTokens: 1000, outputTokens: 0, cacheReadTokens: 100000 });
  const row = db.q("SELECT cache_read_tokens, cost_usd FROM usage_events WHERE kind = 'generation'")[0];
  assert.equal(row.cache_read_tokens, 100000);
  // 1000 × 4$ + 100000 × 0.20$ لكل مليون = 0.004 + 0.02
  assert.ok(Math.abs(row.cost_usd - 0.024) < 1e-9, `الكلفة ${row.cost_usd}`);
});

t.done();
