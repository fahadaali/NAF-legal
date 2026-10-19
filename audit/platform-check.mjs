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
import { ROOT, bundle, makeDb, makeKv, makeR2, makeCtx, fakeAnthropic, suite } from './harness.mjs';

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

t.done();
