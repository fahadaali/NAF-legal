// فحوص سلوك المنصة على شيفرتها الفعلية — مسارات Hono ووحدات `src/lib` فوق قاعدةٍ
// بهجرات المستودع. كل فحصٍ هنا يقابل خطأً وُجد فعلاً، فيبقى شاهداً عليه لا يعود.
//
//   npm run check:platform
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import { ROOT, bundle, makeDb, makeKv, makeR2, makeCtx, makeVectors, fakeAnthropic, suite } from './harness.mjs';

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
   export { default as files } from './files';
   export { default as folders } from './folders';
   export { default as conversations } from './conversations';
   export { isOfficialUrl } from './admin';
   export { default as evalRoutes } from './eval';
   export { extractPendingLinks, parseRefs, ordinalToNumber } from '../lib/research/links';
   export { normalizeArabic, lightStem } from '../lib/arabic';
   export { stemPending } from '../lib/research/stem';
   export { searchLegal } from '../lib/legal';
   export { default as research } from './research';
   export { ingestDocument } from '../ingest';
   export { searchDocuments, reindexDocuments } from '../lib/research/documents';
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
  PLANNER_MODEL: 'claude-haiku-5-5',
  ANALYSIS_MODEL: 'claude-opus-5-5',
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

console.log('\nالأمان');

async function uploadAs(env, name, type, bytes = 'محتوى') {
  const fd = new FormData();
  fd.append('file', new File([bytes], name, { type }));
  fd.append('text', 'نصٌّ مستخرج');
  const ctx = makeCtx();
  const res = await routes.files.request('/upload/c1', { method: 'POST', body: fd }, env, ctx);
  await ctx.settle();
  return res;
}

await t.check('نوع الملف المرفوع من الخادم لا من المتصفّح، ويُقدَّم بـnosniff وsandbox', async () => {
  const { env, db } = await chatFixture();
  const R2 = makeR2();
  const res = await uploadAs({ ...env, R2 }, 'تقرير.pdf', 'text/html', '<script>alert(1)</script>');
  assert.equal(res.status, 200);
  const att = db.q('SELECT id, mime FROM attachments')[0];
  assert.equal(att.mime, 'application/pdf', `خُزِّن ${att.mime}`);
  // صفٌّ قديم خُزِّن بنوعٍ أعلنه المتصفّح: يُعاد اشتقاقه عند التقديم.
  db.q("INSERT INTO attachments (id, conversation_id, r2_key, filename, mime, size, created_at) VALUES ('old','c1','k-old','x.txt','text/html',1,1)");
  await R2.put('k-old', '<script>1</script>');
  const served = await routes.files.request('/attachments/old/file', {}, { ...env, R2 });
  assert.equal(served.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(served.headers.get('content-security-policy'), 'sandbox');
});

await t.check('ملفٌّ بنوعٍ غير مدعوم يُرفض', async () => {
  const { env } = await chatFixture();
  const res = await uploadAs({ ...env, R2: makeR2() }, 'page.html', 'text/html');
  assert.equal(res.status, 415);
});

await t.check('لا تُربط محادثةٌ بقضية مستخدمٍ آخر', async () => {
  const { env, db } = await chatFixture();
  db.q("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u2','u2@x','-',1)");
  db.q("INSERT INTO case_folders (id, user_id, name, created_at) VALUES ('f2','u2','قضية غيري',1)");
  const res = await routes.folders.request('/assign', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversation_id: 'c1', folder_id: 'f2' }),
  }, env);
  assert.equal(res.status, 404);
  assert.equal(db.q("SELECT folder_id FROM conversations WHERE id = 'c1'")[0].folder_id, null);
});

await t.check('حذف المحادثة يحذف ملفاتها من R2 وما تعلّق برسائلها', async () => {
  const { env, db } = await chatFixture();
  const R2 = makeR2();
  await R2.put('uploads/u1/c1/a', 'x');
  db.q("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m1','c1','assistant','مسودة',1)");
  db.q("INSERT INTO attachments (id, conversation_id, r2_key, filename, mime, size, created_at) VALUES ('a1','c1','uploads/u1/c1/a','a.pdf','application/pdf',1,1)");
  db.q("INSERT INTO draft_versions (id, message_id, version, content, created_at) VALUES ('d1','m1',1,'مسودة',1)");
  const ctx = makeCtx();
  const res = await routes.conversations.request('/c1', { method: 'DELETE' }, { ...env, R2 }, ctx);
  await ctx.settle();
  assert.equal(res.status, 200);
  assert.equal(R2._map.size, 0, 'بقي ملفُّ العميل في R2');
  assert.equal(db.q('SELECT COUNT(*) AS n FROM draft_versions')[0].n, 0, 'بقيت نسخ المسودّة يتيمة');
});

await t.check('الاستيعاب من رابط: مصادر رسمية بـhttps وحدها', async () => {
  assert.equal(routes.isOfficialUrl('https://laws.boe.gov.sa/x'), true);
  assert.equal(routes.isOfficialUrl('https://www.uqn.gov.sa/a'), true);
  assert.equal(routes.isOfficialUrl('http://laws.boe.gov.sa/x'), false);
  assert.equal(routes.isOfficialUrl('https://boe.gov.sa.evil.test/x'), false);
  assert.equal(routes.isOfficialUrl('https://evil.test/?u=boe.gov.sa'), false);
});

console.log('\nالقياس والأثر');

await t.check('كل دورٍ يحفظ أثر استرجاعه بما رجع وما تعطّل', async () => {
  const { env, db } = await chatFixture();
  const fake = fakeAnthropic((b) =>
    isPlanner(b) ? { text: '{"needs_knowledge_base": true, "kb_queries": ["مكافأة نهاية الخدمة"]}' } : { text: 'رد' }
  );
  try {
    await sendTurn(env, 'سؤال');
    const tr = db.q('SELECT steps_json, result_keys_json, failed FROM retrieval_traces')[0];
    assert.ok(tr, 'لم يُحفظ أثر');
    assert.deepEqual(JSON.parse(tr.result_keys_json), ['legal:labor:84']);
    const steps = JSON.parse(tr.steps_json);
    assert.ok(steps.some((s) => s.stage === 'lexical' && s.count >= 1), 'المسار اللفظي غائب عن الأثر');
    // بلا فهرسٍ متجهي: الدور يمضي، والأثر يقول إن المسار الدلالي لم يعمل.
    assert.ok(steps.some((s) => s.stage === 'semantic' && s.error), 'تعطّل الدلالي لم يُسجَّل');
    assert.equal(tr.failed, 1);
  } finally {
    fake.restore();
  }
});

await t.check('مسار القياس يشغّل خطّ الاسترجاع نفسه ويعيد الأنظمة والمواد', async () => {
  const { env } = await chatFixture();
  const fake = fakeAnthropic(() => ({ text: '{"needs_knowledge_base": true, "kb_queries": ["مكافأة"]}' }));
  try {
    const res = await routes.evalRoutes.request('/retrieve', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'مكافأة نهاية الخدمة', consultation_type: 'consultation' }),
    }, env);
    const out = await res.json();
    assert.equal(res.status, 200);
    assert.equal(out.results[0].law_title, 'نظام العمل');
    assert.equal(out.results[0].article_no, '84');
  } finally {
    fake.restore();
  }
});

await t.check('سكربت القياس يحسب تغطية الأنظمة والطبقات والمواد', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      results: [
        { law_title: 'نظام العمل', article_no: '84', article_ref: 'المادة 84' },
        { law_title: 'اللائحة التنفيذية لنظام العمل', article_no: '3' },
      ],
      queries: ['q'], failed: false, ms: 5,
    }));
  });
  await new Promise((r) => server.listen(0, r));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'naf-eval-'));
  const cases = path.join(dir, 'cases.jsonl');
  await writeFile(cases, JSON.stringify({
    id: 'x', message: 'م', consultation_type: 'consultation',
    expected_laws: [
      { layer: 'موضوعي', title: 'نظام العمل', required: true },
      { layer: 'إجرائي', title: 'نظام المرافعات الشرعية', required: true },
    ],
    expected_articles: [{ law: 'نظام العمل', article: '84', confidence: 'high' }, { law: 'نظام العمل', article: '77', confidence: 'high' }],
  }));
  try {
    const out = path.join(dir, 'out.json');
    await promisify(execFile)('node', [path.join(ROOT, 'scripts', 'eval-retrieval.mjs'),
      '--url', `http://127.0.0.1:${server.address().port}`, '--cookie', 'x', '--cases', cases, '--out', out]);
    const { summary, rows } = JSON.parse(await (await import('node:fs/promises')).readFile(out, 'utf8'));
    // «اللائحة التنفيذية لنظام العمل» لا تُحسب «نظام العمل»، ونظام العمل وحده من نظامين.
    assert.equal(rows[0].laws, 50);
    assert.equal(rows[0].layers, 50);
    assert.equal(rows[0].articles, 50);
    assert.deepEqual(rows[0].missing, ['إجرائي: نظام المرافعات الشرعية']);
    assert.equal(summary.laws, 50);
  } finally {
    server.close();
  }
});

console.log('\nالإحالات بين المواد');

const law = (o) => JSON.stringify({ doc_type: 'law', status: 'active', embed_text: o.text, ...o });

await t.check('الأعداد الترتيبية بالحروف تُقرأ أرقاماً', async () => {
  for (const [w, n] of [['الثالثة والعشرين بعد المائة', 123], ['الثانية عشرة', 12], ['السابعة والسبعين', 77], ['الحادية والعشرون', 21]]) {
    assert.equal(routes.ordinalToNumber(w), n, w);
  }
  assert.equal(routes.ordinalToNumber('المذكورة'), null);
});

await t.check('الإحالات: بالأرقام وبالحروف، وإلى هذا النظام وإلى نظامٍ مسمّى وإلى اللائحة', async () => {
  const p = (x) => routes.parseRefs(routes.normalizeArabic(x)).map((r) => [r.articles.join(','), r.scope]);
  assert.deepEqual(p('مع مراعاة المادة (السابعة والسبعين) من هذا النظام'), [['77', 'self']]);
  assert.deepEqual(p('وفقاً للمادتين (80) و(81) من هذا النظام.'), [['80,81', 'self']]);
  assert.deepEqual(p('مع مراعاة المادة (76) من نظام المرافعات الشرعية'), [['76', 'named']]);
  assert.deepEqual(p('المنصوص عليها في المادة (الثانية عشرة) من اللائحة.'), [['12', 'regulation']]);
  assert.deepEqual(p('استثناءً من حكم المادة السابقة'), [['', 'previous']]);
  // «مكرر» مادةٌ أخرى لا تُحلّ برقم أصلها، و«هذه المادة» ذكرٌ لا إحالة.
  assert.deepEqual(p('وفق المادة (15) مكرر من النظام.'), []);
  assert.deepEqual(p('الإجراءات المشار إليها في هذه المادة.'), []);
});

await t.check('الاستخراج يحلّ الإحالة إلى مادة نظامٍ آخر، ويعيدها حين يتغيّر النصّ أو يُحذف المحال إليه', async () => {
  const db = await makeDb();
  const env = { ...ENV_BASE, DB: db.DB, KV: makeKv() };
  await routes.upsertLegalChunks(env, routes.parseJsonl([
    law({ id: 'labor:20', law_id: 'labor', law_title: 'نظام العمل', article_no: '20', text: 'مع مراعاة المادة (76) من نظام المرافعات الشرعية، والمادة (السابعة) من هذا النظام، تُرفع الدعوى.' }),
    law({ id: 'labor:7', law_id: 'labor', law_title: 'نظام العمل', article_no: '7', text: 'يُستثنى من أحكام هذا النظام...' }),
    law({ id: 'mur:76', law_id: 'murafaat', law_title: 'نظام المرافعات الشرعية', article_no: '76', text: 'الدفع بعدم الاختصاص المكاني يُبدى قبل أي طلب.' }),
  ].join('\n')).rows);
  const r = await routes.extractPendingLinks(env, 100);
  assert.equal(r.remaining, 0);
  const seq = (id) => db.q('SELECT seq FROM legal_chunks WHERE id = ?', id)[0].seq;
  const links = db.q('SELECT to_law_id, to_article_no, to_seq, scope FROM legal_article_links WHERE from_seq = ? ORDER BY to_article_no', seq('labor:20'));
  assert.deepEqual(links.map((l) => [l.to_law_id, l.to_article_no, l.to_seq, l.scope]), [
    ['labor', '7', seq('labor:7'), 'self'],
    ['murafaat', '76', seq('mur:76'), 'named'],
  ]);
  // تعديل النصّ يعيد المقطع إلى الطابور.
  db.q("UPDATE legal_chunks SET text_norm = 'نص جديد' WHERE id = 'labor:20'");
  assert.equal(db.q("SELECT links_at FROM legal_chunks WHERE id = 'labor:20'")[0].links_at, null);
  // حذفُ المحال إليه يُعيد الإحالة معلّقة.
  db.q("DELETE FROM legal_chunks WHERE id = 'mur:76'");
  assert.equal(db.q("SELECT to_seq FROM legal_article_links WHERE to_article_no = '76'")[0].to_seq, null);
});

console.log('\nالبحث اللفظي على الجذوع');

await t.check('الجذع الخفيف ينزع السوابق المتصلة واللواحق الشائعة', async () => {
  for (const [w, st] of [['العامل', 'عامل'], ['للعامل', 'عامل'], ['والعامل', 'عامل'], ['بالعقد', 'عقد'], ['اجره', 'اجر'], ['المحكمه', 'محكم'], ['فللعامل', 'عامل']]) {
    assert.equal(routes.lightStem(w), st, w);
  }
  // القصير يبقى: «ولد» لا تصير «لد».
  assert.equal(routes.lightStem('ولد'), 'ولد');
});

await t.check('«العامل» يجد «للعامل» و«والعامل» و«فللعامل» بعد ملء الجذوع، وترتيب الفهرس الأول باقٍ', async () => {
  const db = await makeDb();
  const env = { ...ENV_BASE, DB: db.DB, KV: makeKv() };
  const texts = ['يستحق العامل أجره كاملاً', 'تلتزم المنشأة بدفع الأجر للعامل', 'إذا انتهى العقد فللعامل مكافأة', 'والعامل يلتزم بالتعليمات'];
  await routes.upsertLegalChunks(env, routes.parseJsonl(texts.map((t, i) =>
    law({ id: `l:${i + 1}`, law_id: 'l', law_title: 'نظام العمل', article_no: String(i + 1), text: t })).join('\n')).rows);
  const before = await routes.searchLegal(env, 'العامل', { limit: 10 });
  assert.equal(before.length, 1);
  const r = await routes.stemPending(env);
  assert.equal(r.remaining, 0);
  const after = await routes.searchLegal(env, 'العامل', { limit: 10 });
  assert.equal(after.length, 4, `وجد ${after.length}`);
  assert.equal(after[0].id, 'l:1', 'تغيّر ترتيب ما وجده الفهرس الأول');
  // نصٌّ تغيّر يُفرَّغ جذعُه ويخرج من الفهرس حتى يُعاد حسابه.
  db.q("UPDATE legal_chunks SET text_norm = 'نص اخر' WHERE id = 'l:2'");
  assert.equal(db.q("SELECT text_stem FROM legal_chunks WHERE id = 'l:2'")[0].text_stem, null);
  assert.equal((await routes.searchLegal(env, 'العامل', { limit: 10 })).length, 3);
});

console.log('\nالمحرّك الطبقي');

async function layeredFixture() {
  const db = await makeDb();
  db.q('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)', 'u1', 'u1@x', '-', 1);
  db.q('INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', 'c1', 'u1', 'محادثة', 1, 1);
  const env = { ...ENV_BASE, DB: db.DB, KV: makeKv() };
  await routes.upsertLegalChunks(env, routes.parseJsonl([
    law({ id: 'labor:1', law_id: 'labor', law_title: 'نظام العمل', article_no: '1', text: 'يُقصد بالألفاظ والعبارات الآتية المعاني المبينة أمامها: العامل: كل شخص طبيعي يعمل لمصلحة صاحب العمل.' }),
    law({ id: 'labor:77', law_id: 'labor', law_title: 'نظام العمل', article_no: '77', text: 'إذا أُنهي العقد لسبب غير مشروع استحق الطرف المتضرر تعويضاً، مع مراعاة المادة (76) من نظام المرافعات الشرعية.' }),
    law({ id: 'labor:84', law_id: 'labor', law_title: 'نظام العمل', article_no: '84', text: 'إذا انتهت علاقة العمل وجب على صاحب العمل أن يدفع إلى العامل مكافأة عن مدة خدمته.' }),
    law({ id: 'mur:31', law_id: 'murafaat', law_title: 'نظام المرافعات الشرعية', article_no: '31', text: 'تختص المحاكم العمالية بالنظر في المنازعات العمالية.' }),
    law({ id: 'mur:76', law_id: 'murafaat', law_title: 'نظام المرافعات الشرعية', article_no: '76', text: 'الدفع ببطلان صحيفة الدعوى يُبدى قبل أي طلب أو دفاع.' }),
    law({ id: 'ith:5', law_id: 'ithbat', law_title: 'نظام الإثبات', article_no: '5', text: 'على المدعي أن يثبت ما يدعيه من حق، وللمدعى عليه نفيه.' }),
  ].join('\n')).rows);
  await routes.extractPendingLinks(env, 100);
  await routes.stemPending(env);
  // طبقة الإثبات معتمدةً مطلوبة؛ والأحكام العامة مسودّةٌ لا يقرؤها المحرّك.
  db.q("UPDATE grounding_map SET status = 'approved', required = 1 WHERE domain = 'عمالي' AND layer = 'evidence'");
  return { db, env };
}

const LAYERED_PLAN = {
  consultation_type: 'litigation.statement_of_claim', needs_knowledge_base: true, kb_queries: [],
  needs_internet_search: false, internet_queries: [], needs_uploaded_files: false,
  target_regulations: ['نظام العمل'], needs_fiqh_sources: false, fiqh_queries: [], clarifying_questions: [],
  output_format: 'docx', domain: 'عمالي',
  issues: [
    { title: 'التعويض عن الفصل', layer: 'substantive', queries: ['تعويض إنهاء العقد لسبب غير مشروع'], laws: ['نظام العمل'] },
    { title: 'الاختصاص', layer: 'procedural', queries: ['اختصاص المحاكم العمالية'], laws: ['نظام المرافعات الشرعية'] },
  ],
  explicit_articles: [{ law: 'نظام العمل', article: '84' }],
};

await t.check('المُخطِّط يطلب مخرجاً منظَّماً بمخطّط الخطة، ويعود إلى النصّ إن رُدّ المخطّط', async () => {
  const { env } = await layeredFixture();
  let first = true;
  const fake = fakeAnthropic((b) => {
    if (!isPlanner(b)) return { text: 'رد' };
    if (b.output_config?.format && first) { first = false; return { status: 400 }; }
    return { text: JSON.stringify(LAYERED_PLAN) };
  });
  try {
    await sendTurn(env, 'صحيفة دعوى عمالية');
    const planners = fake.calls.filter(isPlanner);
    assert.equal(planners[0].output_config.format.type, 'json_schema');
    assert.ok(planners[0].output_config.format.schema.properties.issues, 'المخطّط بلا شجرة المسائل');
    assert.equal(planners.at(-1).output_config.format, undefined, 'لم يُعد الطلب بلا مخطّط');
    assert.match(generationText(fake.calls.find(isGeneration)), /المسألة: الاختصاص/);
  } finally {
    fake.restore();
  }
});

await t.check('السياق تحت المسائل والطبقات: المذكورة بأرقامها، والمحصور في كل نظام، والطبقة المطلوبة، والإحالة، والتعريفات', async () => {
  const { env, db } = await layeredFixture();
  const fake = fakeAnthropic((b) => (isPlanner(b) ? { text: JSON.stringify(LAYERED_PLAN) } : { text: 'رد' }));
  try {
    await sendTurn(env, 'موكّلي فُصل دون سبب مشروع، أريد صحيفة دعوى عمالية');
    const ctx = generationText(fake.calls.find(isGeneration));
    for (const [label, re] of [
      ['المادة المذكورة برقمها', /موادّ ذكرها المحامي[\s\S]*?نظام العمل — المادة 84/],
      ['المسألة الموضوعية', /المسألة: التعويض عن الفصل \(موضوعي\)[\s\S]*?المادة 77/],
      ['المسألة الإجرائية', /المسألة: الاختصاص \(إجرائي\)[\s\S]*?نظام المرافعات الشرعية — المادة 31/],
      ['الطبقة المطلوبة في الخريطة المعتمدة', /استكمال طبقة إثبات[\s\S]*?نظام الإثبات — المادة 5/],
      ['المادة المحال إليها', /موادّ تحيل إليها الموادّ أعلاه[\s\S]*?نظام المرافعات الشرعية — المادة 76/],
      ['التعريفات', /تعريفات النظام[\s\S]*?نظام العمل — المادة 1/],
    ]) assert.match(ctx, re, `غائب: ${label}`);
    // والأثر يحفظ ما جرى لكل مسألة.
    const steps = JSON.parse(db.q('SELECT steps_json FROM retrieval_traces')[0].steps_json);
    assert.ok(steps.filter((s) => s.stage === 'issue').length === 2);
  } finally {
    fake.restore();
  }
});

await t.check('مدخل الخريطة المسودّة لا يُقرأ: لا استكمال لطبقةٍ لم يعتمدها محامٍ', async () => {
  const { env, db } = await layeredFixture();
  db.q("UPDATE grounding_map SET status = 'draft' WHERE domain = 'عمالي'");
  const fake = fakeAnthropic((b) => (isPlanner(b) ? { text: JSON.stringify(LAYERED_PLAN) } : { text: 'رد' }));
  try {
    await sendTurn(env, 'سؤال');
    assert.doesNotMatch(generationText(fake.calls.find(isGeneration)), /استكمال طبقة إثبات/);
  } finally {
    fake.restore();
  }
});

console.log('\nمذكرة البحث');

async function sendWith(env, body) {
  const ctx = makeCtx();
  const res = await routes.chatApp.request('/api/chat/c1', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, env, ctx);
  const text = res.body ? await res.text() : '';
  await ctx.settle();
  return { res, text };
}

await t.check('كل دورٍ يحفظ مذكرته ويرسل ملخّصها، وسؤال المتابعة يرث موادّها بنصّها الجاري', async () => {
  const { env, db } = await layeredFixture();
  let turn = 0;
  const fake = fakeAnthropic((b) => {
    if (isPlanner(b)) return { text: JSON.stringify(++turn === 1 ? LAYERED_PLAN : { ...LAYERED_PLAN, needs_knowledge_base: false, issues: [], explicit_articles: [] }) };
    return { text: 'رد' };
  });
  try {
    const first = await sendWith(env, { message: 'صحيفة دعوى' });
    assert.match(first.text, /event: memo/, 'لم يُرسل ملخّص المذكرة');
    assert.equal(db.q('SELECT COUNT(*) AS n FROM research_memos')[0].n, 1);
    // عُدّلت المادة 77 بعد بناء المذكرة: تعود بنصّها الجديد.
    db.q("UPDATE legal_chunks SET text = 'نصٌّ معدَّل للمادة السابعة والسبعين' WHERE id = 'labor:77'");
    await sendWith(env, { message: 'عدّل الفقرة الثانية لتكون أوجز' });
    const gen = fake.calls.filter(isGeneration).at(-1);
    const ctx = generationText(gen);
    assert.match(ctx, /من مذكرة البحث السابقة/, 'لم تُورَث المذكرة');
    assert.match(ctx, /نصٌّ معدَّل للمادة السابعة والسبعين/, 'عادت المادة بنصّها القديم');
  } finally {
    fake.restore();
  }
});

await t.check('بناء المذكرة دون صياغة، وتعديل أسانيدها نسخةً جديدة، والصياغة منها وحدها', async () => {
  const { env, db } = await layeredFixture();
  const fake = fakeAnthropic((b) => (isPlanner(b) ? { text: JSON.stringify(LAYERED_PLAN) } : { text: 'رد' }));
  try {
    const built = await (await routes.research.request('/c1', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'صحيفة دعوى عمالية' }),
    }, env)).json();
    assert.equal(built.memo.status, 'draft');
    assert.equal(fake.calls.filter(isGeneration).length, 0, 'صاغ وهو مطلوبٌ منه البحث وحده');
    const keys = built.memo.groups.flatMap((g) => g.items.map((i) => i.key));
    assert.ok(keys.includes('legal:labor:84'));

    const edited = await (await routes.research.request(`/memos/${built.memo.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ remove: ['legal:labor:84'], add: ['labor:1'] }),
    }, env)).json();
    assert.equal(edited.memo.version, 2);
    const ekeys = edited.memo.groups.flatMap((g) => g.items.map((i) => i.key));
    assert.ok(!ekeys.includes('legal:labor:84') && ekeys.includes('legal:labor:1'));
    assert.equal(db.q('SELECT COUNT(*) AS n FROM research_memos')[0].n, 2, 'عُدّلت النسخة الأولى في مكانها');

    await routes.research.request(`/memos/${edited.memo.id}/approve`, { method: 'POST' }, env);
    const before = fake.calls.length;
    await sendWith(env, { message: 'صُغ الصحيفة', memo_id: edited.memo.id });
    const gen = fake.calls.slice(before).find(isGeneration);
    const ctx = generationText(gen);
    assert.doesNotMatch(ctx, /نظام العمل — المادة 84/, 'صيغ من مادةٍ حذفها المحامي');
    assert.match(ctx, /نظام العمل — المادة 1/);
    const steps = JSON.parse(db.q('SELECT steps_json FROM retrieval_traces ORDER BY created_at DESC LIMIT 1')[0].steps_json);
    assert.ok(steps.some((x) => x.stage === 'memo') && !steps.some((x) => x.stage === 'issue'), 'بحث من جديد بدل الصياغة من المذكرة');
  } finally {
    fake.restore();
  }
});

await t.check('مذكرةُ محادثة مستخدمٍ آخر لا تُقرأ ولا يُصاغ منها', async () => {
  const { env, db } = await layeredFixture();
  db.q("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u2','u2@x','-',1)");
  db.q("INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES ('c2','u2','غيري',1,1)");
  db.q(`INSERT INTO research_memos (id, conversation_id, version, groups_json, gaps_json, status, created_at)
        VALUES ('m2','c2',1,'[{"kind":"issue","title":"x","layer":null,"items":[{"key":"legal:labor:84","seq":3,"title":"t"}]}]','[]','approved',1)`);
  assert.equal((await routes.research.request('/memos/m2', {}, env)).status, 404);
});

console.log('\nالإسناد بكتل search_result');

await t.check('الموادّ تصل كتلَ search_result مُفعَّلاً إسنادُها كلُّها، ومواضع الإسناد تُحفظ مع الردّ', async () => {
  const { env, db } = await layeredFixture();
  const fake = fakeAnthropic((b) => {
    if (isPlanner(b)) return { text: JSON.stringify(LAYERED_PLAN) };
    if (isGeneration(b)) {
      return { blocks: [
        { text: 'أولاً: الوقائع. ' },
        { text: 'يستحق المدعي التعويض عن الفصل غير المشروع.', sources: ['legal:labor:77'] },
        { text: ' وتختص المحكمة العمالية بنظر الدعوى.', sources: ['legal:mur:31'] },
      ] };
    }
    return { text: 'عنوان' };
  });
  try {
    await sendWith(env, { message: 'صحيفة دعوى عمالية' });
    const gen = fake.calls.find(isGeneration);
    const last = gen.messages.at(-1).content;
    assert.ok(Array.isArray(last), 'السياق نصٌّ لا كتل');
    const results = last.filter((x) => x.type === 'search_result');
    assert.ok(results.length >= 5, `كتل الموادّ ${results.length}`);
    assert.ok(results.every((x) => x.citations?.enabled === true), 'الإسناد ليس في الكتل كلِّها');
    assert.ok(results.some((x) => x.source === 'legal:labor:77' && /نظام العمل — المادة 77/.test(x.title)));
    assert.equal(last.at(-1).type, 'text');
    assert.match(last.at(-1).text, /صحيفة دعوى عمالية/);

    const msg = db.q("SELECT content, metadata_json FROM messages WHERE role = 'assistant'")[0];
    const spans = JSON.parse(msg.metadata_json).citation_spans;
    assert.equal(spans.length, 2);
    assert.equal(msg.content.slice(spans[0].start, spans[0].end), 'يستحق المدعي التعويض عن الفصل غير المشروع.');
    assert.deepEqual(spans[1].keys, ['legal:mur:31']);
  } finally {
    fake.restore();
  }
});

console.log('\nالتحقّق البنيوي من الإسناد');

const isVerifier = (b) => !b.stream && String(b.system ?? '').includes('مدقّق إسناد');

function verifyEvent(text) {
  const m = text.match(/event: verify\ndata: (.*)\n/);
  return m ? JSON.parse(m[1]) : null;
}

await t.check('لم يُسترجع شيء والمخرَج يذكر موادّ: كلُّها «بحاجة لتأكيد يدوي» — وكانت تمرّ بلا شارة', async () => {
  const { env } = await chatFixture();
  const fake = fakeAnthropic((b) =>
    isPlanner(b) ? { text: '{"needs_knowledge_base": false}' } : isGeneration(b) ? { text: 'وفق المادة (99) من نظام العمل يستحق العامل…' } : { text: '{}' }
  );
  try {
    const { text } = await sendTurn(env, 'سؤال');
    const v = verifyEvent(text);
    assert.ok(v, 'لا شارة تحقّق');
    assert.equal(v.verified, false);
    assert.deepEqual(v.unsupported, ['نظام العمل — المادة 99']);
    assert.equal(fake.calls.filter(isVerifier).length, 0, 'استُدعي النموذج بلا موادّ يحكم عليها');
  } finally {
    fake.restore();
  }
});

await t.check('مادةٌ مسترجعة ومادةٌ لم تُسترجع: الثانية وحدها بلا سند، والمدقّق يقرأ نصّ الأولى وحده', async () => {
  const { env } = await chatFixture();
  const answer = 'تستحق المكافأة وفق المادة (84) من نظام العمل، ويقع عبء الإثبات وفق المادة (12) من نظام الإثبات. ' + 'ب'.repeat(15000) + ' والمادة (7) من نظام العمل.';
  const fake = fakeAnthropic((b) => {
    if (isPlanner(b)) return { text: '{"needs_knowledge_base": true, "kb_queries": ["مكافأة نهاية الخدمة"]}' };
    if (isGeneration(b)) return { text: answer };
    if (isVerifier(b)) return { text: '{"unsupported": [], "note": ""}' };
    return { text: 'عنوان' };
  });
  try {
    const { text } = await sendTurn(env, 'سؤال');
    const v = verifyEvent(text);
    assert.deepEqual(v.unsupported.sort(), ['نظام الإثبات — المادة 12', 'نظام العمل — المادة 7'].sort());
    const ver = fake.calls.find(isVerifier);
    const content = ver.messages[0].content;
    assert.match(content, /المادة 84/);
    // المخرَج كاملاً — والمادة السابعة في آخره بعد خمسة عشر ألف حرف.
    assert.match(content, /والمادة \(7\) من نظام العمل/);
  } finally {
    fake.restore();
  }
});

console.log('\nالبحث المعمّق بالأدوات');

await t.check('Claude يبحث بالأدوات ويُكمل المذكرة — ولا يُضاف مفتاحٌ لم تُرجعه الأدوات', async () => {
  const { env, db } = await layeredFixture();
  await routes.upsertLegalChunks(env, routes.parseJsonl(law({
    id: 'ith:9', law_id: 'ithbat', law_title: 'نظام الإثبات', article_no: '9', text: 'الإقرار حجةٌ قاصرة على المقر.',
  })).rows);
  await routes.stemPending(env);
  const isAgent = (b) => !b.stream && String(b.system ?? '').includes('باحثٌ قانونيّ');
  let round = 0;
  const thinking = { type: 'thinking', thinking: '', signature: 'sig-1' };
  const fake = fakeAnthropic((b) => {
    if (isPlanner(b)) return { text: JSON.stringify(LAYERED_PLAN) };
    if (!isAgent(b)) return { text: 'رد' };
    round++;
    if (round === 1) {
      return { stop_reason: 'tool_use', content: [thinking, { type: 'tool_use', id: 't1', name: 'search_laws', input: { query: 'الإقرار', law: 'نظام الإثبات' } }] };
    }
    return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'finish_research', input: {
      add: ['legal:ith:9', 'legal:invented:1'], gaps: [{ title: 'التقادم', reason: 'لا نصّ في القاعدة' }],
    } }] };
  });
  try {
    const out = await (await routes.research.request('/c1', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'صحيفة دعوى عمالية', deep: true }),
    }, env)).json();
    const agentCalls = fake.calls.filter(isAgent);
    assert.equal(agentCalls.length, 2);
    // الجولة الثانية: ردُّ الأولى بكتله كما هو (ومنها التفكير)، ثم نتائج الأدوات كتلَ search_result.
    const msgs = agentCalls[1].messages;
    assert.deepEqual(msgs[1].content[0], thinking, 'لم يُعد التفكير كما هو');
    const tr = msgs[2].content[0];
    assert.equal(tr.type, 'tool_result');
    assert.equal(tr.content[0].type, 'search_result');
    assert.equal(tr.content[0].source, 'legal:ith:9');
    assert.ok(agentCalls[0].tools.every((x) => x.strict === true), 'أدواتٌ بلا strict');

    const keys = out.memo.groups.flatMap((g) => g.items.map((i) => i.key));
    assert.ok(keys.includes('legal:ith:9'), 'لم يُضف ما وجده البحث');
    assert.ok(!keys.includes('legal:invented:1'), 'أُضيف مفتاحٌ مخترع');
    assert.ok(out.memo.gaps.some((g) => /التقادم/.test(g.title)));
    const steps = JSON.parse(db.q('SELECT steps_json FROM retrieval_traces ORDER BY created_at DESC LIMIT 1')[0].steps_json);
    assert.ok(steps.some((x) => x.stage === 'agent-search' && x.count === 1));
  } finally {
    fake.restore();
  }
});

await t.check('رُدّت كتل search_result بـ400: يُعاد الطلب والسياقُ نصٌّ، ولا يتعذّر الردّ', async () => {
  const { env, db } = await layeredFixture();
  const fake = fakeAnthropic((b) => {
    if (isPlanner(b)) return { text: JSON.stringify(LAYERED_PLAN) };
    if (isGeneration(b)) return Array.isArray(b.messages.at(-1).content) ? { status: 400 } : { text: 'ردٌّ من سياقٍ نصّي' };
    return { text: 'عنوان' };
  });
  try {
    const { res } = await sendWith(env, { message: 'صحيفة دعوى عمالية' });
    assert.equal(res.status, 200);
    const gens = fake.calls.filter(isGeneration);
    assert.equal(gens.length, 2);
    assert.match(gens[1].messages.at(-1).content, /<سياق_نظامي>[\s\S]*المسألة: الاختصاص/);
    assert.equal(db.q("SELECT content FROM messages WHERE role = 'assistant'")[0].content, 'ردٌّ من سياقٍ نصّي');
  } finally {
    fake.restore();
  }
});

console.log('\nفهرس الوثائق المرفوعة');

async function docFixture(withVectors) {
  const { env, db } = await layeredFixture();
  const R2 = makeR2();
  const v = makeVectors();
  const e = { ...env, R2, ...(withVectors ? { AI: v.AI, VECTORIZE: v.VECTORIZE } : {}) };
  db.q("INSERT INTO kb_documents (id, title, status, ingest_status, chunk_count, created_at) VALUES ('d1','تعميم وزارة الموارد البشرية بشأن الإجازات','active','ready',2,1)");
  await R2.put('kb-text/d1.txt', 'يستحق للعامل إجازة سنوية مدفوعة الأجر لا تقل عن واحد وعشرين يوماً.');
  return { env: e, db, v };
}

await t.check('بلا فهرسٍ متجهي: مقاطع الوثيقة في D1 والبحث اللفظيّ يجدها بجذوعها، والوثيقة «منتظرة» لا «جاهزة»', async () => {
  const { env, db } = await docFixture(false);
  assert.equal(await routes.ingestDocument(env, 'd1'), 'pending');
  assert.equal(db.q("SELECT COUNT(*) AS n FROM kb_doc_chunks WHERE document_id = 'd1'")[0].n, 1);
  const hits = await routes.searchDocuments(env, 'إجازة العامل');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, 'document');
  assert.match(hits[0].key, /^doc:d1:0$/);
  // وثيقةٌ نُسخت لا يعود منها مقطع.
  db.q("UPDATE kb_documents SET status = 'repealed' WHERE id = 'd1'");
  assert.equal((await routes.searchDocuments(env, 'إجازة العامل')).length, 0);
});

await t.check('بفهرسٍ متجهي: المتجهات في مساحة documents، والقديمة تُحذف، والوثيقة بنسخة الفهرسة الجديدة', async () => {
  const { env, db, v } = await docFixture(true);
  // متجهٌ قديم في المساحة الافتراضية من فهرسة ما قبل الهجرة 0040.
  await v.VECTORIZE.upsert([{ id: 'd1:0', values: v.vec('قديم'), metadata: { document_id: 'd1', text: 'قديم' } }]);
  assert.equal(await routes.ingestDocument(env, 'd1'), 'ready');
  assert.ok(v.log.deletes.includes('d1:0'), 'بقي المتجه القديم');
  assert.deepEqual(v.log.upserts.at(-1), { id: 'doc:d1:0', namespace: 'documents' });
  assert.equal(db.q("SELECT index_version FROM kb_documents WHERE id = 'd1'")[0].index_version, 2);
  const hits = await routes.searchDocuments(env, 'الإجازة السنوية', { queryVector: v.vec('الإجازة السنوية') });
  assert.equal(hits[0]?.key, 'doc:d1:0');
});

await t.check('إعادة الفهرسة في الخلفية تلتقط ما فُهرس بالطريقة القديمة وحده', async () => {
  const { env, db } = await docFixture(true);
  db.q("INSERT INTO kb_documents (id, title, status, ingest_status, index_version, created_at) VALUES ('d2','جديدة','active','ready',2,2)");
  const n = await routes.reindexDocuments(env, routes.ingestDocument);
  assert.equal(n, 1);
  assert.equal(db.q("SELECT index_version FROM kb_documents WHERE id = 'd1'")[0].index_version, 2);
});

await t.check('المحرّك الطبقي يضمّ مقاطع الوثائق في مجموعتها، والمذكرة تستعيدها في سؤال المتابعة', async () => {
  const { env, db } = await docFixture(false);
  await routes.ingestDocument(env, 'd1');
  const plan = { ...LAYERED_PLAN, issues: [{ title: 'الإجازة السنوية', layer: 'substantive', queries: ['إجازة سنوية للعامل'], laws: ['نظام العمل'] }], explicit_articles: [] };
  let turn = 0;
  const fake = fakeAnthropic((b) => {
    if (isPlanner(b)) return { text: JSON.stringify(++turn === 1 ? plan : { ...plan, needs_knowledge_base: false, issues: [] }) };
    return { text: 'رد' };
  });
  try {
    await sendWith(env, { message: 'كم الإجازة السنوية؟' });
    assert.match(generationText(fake.calls.filter(isGeneration)[0]), /من الوثائق المرفوعة[\s\S]*تعميم وزارة الموارد البشرية/);
    await sendWith(env, { message: 'أوجز' });
    assert.match(generationText(fake.calls.filter(isGeneration)[1]), /من مذكرة البحث السابقة[\s\S]*إجازة سنوية مدفوعة الأجر/);
  } finally {
    fake.restore();
  }
});

t.done();
