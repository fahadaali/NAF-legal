// فحوص طبقة المبادئ القضائية (`src/lib/principles.ts`، §١٦ في العقد).
//
// المدخل اثنا عشر مبدأً من مدوّنتي المبادئ العمالية 1431 و1432هـ كما يخرجها
// `principles.js` في مشروع nezam: من كل مدوّنة اثنان نافذان، واثنان بتحذير،
// وواحدٌ أساسه معدَّل، وواحدٌ أساسه ملغى.
//
//   npm run check:principles
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ROOT, bundle, makeDb, suite } from './harness.mjs';

const t = suite('فحوص المبادئ القضائية');

const AUTH_STUB = `
export async function requireAuth(c: any, next: any) {
  c.set('user', { id: 'admin1', email: 'a@x', role: 'admin' });
  await next();
}
export const requireAdmin = requireAuth;
export async function audit() {}
`;

const lib = await bundle(
  'principles',
  `export * from './principles';
   export { searchLegal } from './legal';
   import { Hono } from 'hono';
   import principleRoutes from '../routes/principles';
   export const app = new Hono().route('/api/principles', principleRoutes);`,
  { resolveDir: path.join(ROOT, 'src', 'lib'), stubs: { '../lib/auth': AUTH_STUB } }
);

const SAMPLE = await readFile(path.join(ROOT, 'audit', 'fixtures', 'principles-sample.jsonl'), 'utf8');
const LINES = SAMPLE.trim().split('\n');

async function fixture() {
  const db = await makeDb();
  return { db, env: { DB: db.DB } };
}

async function post(env, url, body, type = 'application/x-ndjson') {
  const res = await lib.app.request(url, { method: 'POST', body, headers: { 'content-type': type } }, env);
  return { status: res.status, json: await res.json() };
}

async function importAll(env, text = SAMPLE, id = 'test-import-0001') {
  const s = await post(env, `/api/principles/stage?import_id=${id}&first_line=1`, text);
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const c = await post(env, '/api/principles/commit', JSON.stringify({ import_id: id }), 'application/json');
  assert.equal(c.status, 200, JSON.stringify(c.json));
  return c.json;
}

console.log('\nقراءة الملف');

await t.check('الأسطر الاثنا عشر تُقبل كلُّها بحالاتها الأربع', () => {
  const p = lib.parsePrinciples(SAMPLE);
  assert.equal(p.errors.length, 0, JSON.stringify(p.errors));
  assert.equal(p.rows.length, 12);
  assert.deepEqual(new Set(p.rows.map((r) => r.retrieval_status)), new Set(lib.PRINCIPLE_STATUSES));
  assert.deepEqual(p.collections.sort(), ['مدونة-المبادئ-العمالية-1431', 'مدونة-المبادئ-العمالية-1432']);
});

await t.check('مبدأٌ لم يُعتمد يُرفض — لا يُرفع إصدارٌ لم يراجعه المحامي', () => {
  const o = JSON.parse(LINES[0]);
  delete o.review;
  assert.match(String(lib.preparePrinciple(o)), /review/);
});

await t.check('مادةٌ تُرفض هنا: هذا المسار للمبادئ وحدها', () => {
  const o = { ...JSON.parse(LINES[0]), doc_type: 'law' };
  assert.match(String(lib.preparePrinciple(o)), /doc_type/);
});

await t.check('حالُ الموادّ «ملغى» ليست حالاً لمبدأ', () => {
  const o = { ...JSON.parse(LINES[0]), retrieval_status: 'ملغى' };
  assert.match(String(lib.preparePrinciple(o)), /retrieval_status/);
});

await t.check('حالٌ غير «نافذ» بلا تحذير تُرفض — التحذير يُعرض فوق النصّ', () => {
  const o = JSON.parse(LINES.find((l) => l.includes('أساسه ملغى')));
  o.retrieval_warning = '';
  assert.match(String(lib.preparePrinciple(o)), /retrieval_warning/);
});

await t.check('معرّفٌ مكرّر في الملف يُرفض بسطره', () => {
  const p = lib.parsePrinciples(`${LINES[0]}\n${LINES[0]}`);
  assert.equal(p.errors.length, 1);
  assert.equal(p.errors[0].line, 2);
});

console.log('\nالكتابة');

await t.check('الجمع لا يمسّ الجدول، والكتابة تُدرج الاثني عشر', async () => {
  const { env, db } = await fixture();
  const s = await post(env, '/api/principles/stage?import_id=test-import-0001&first_line=1', SAMPLE);
  assert.equal(s.status, 200);
  assert.equal(db.q('SELECT COUNT(*) n FROM legal_principles')[0].n, 0);
  const c = await post(env, '/api/principles/commit', JSON.stringify({ import_id: 'test-import-0001' }), 'application/json');
  assert.equal(c.json.written, 12);
  assert.equal(db.q('SELECT COUNT(*) n FROM legal_principles')[0].n, 12);
  assert.equal(db.q('SELECT COUNT(*) n FROM legal_principles_staging')[0].n, 0);
});

await t.check('جزءٌ فيه سطرٌ فاسد يُردّ كلُّه بـ422 ولا يُجمع منه شيء', async () => {
  const { env, db } = await fixture();
  const s = await post(env, '/api/principles/stage?import_id=test-import-0002&first_line=1', `${LINES[0]}\n{bad`);
  assert.equal(s.status, 422);
  assert.equal(s.json.errors[0].line, 2);
  assert.equal(db.q('SELECT COUNT(*) n FROM legal_principles_staging')[0].n, 0);
});

await t.check('إعادة الاستيراد تستبدل المدوّنة ولا تضاعفها، ومدوّنةٌ ليست في الملف لا تُمسّ', async () => {
  const { env, db } = await fixture();
  await importAll(env);
  const only1431 = LINES.filter((l) => l.includes('-1431/')).slice(0, 2).join('\n');
  const r = await importAll(env, only1431, 'test-import-0003');
  assert.equal(r.written, 2);
  assert.equal(r.replaced, 6);
  const by = Object.fromEntries(db.q('SELECT collection_id c, COUNT(*) n FROM legal_principles GROUP BY c').map((x) => [x.c, x.n]));
  assert.equal(by['مدونة-المبادئ-العمالية-1431'], 2);
  assert.equal(by['مدونة-المبادئ-العمالية-1432'], 6);
});

await t.check('الإلغاء يُسقط ما جُمع', async () => {
  const { env, db } = await fixture();
  await post(env, '/api/principles/stage?import_id=test-import-0004&first_line=1', SAMPLE);
  await post(env, '/api/principles/abort', JSON.stringify({ import_id: 'test-import-0004' }), 'application/json');
  assert.equal(db.q('SELECT COUNT(*) n FROM legal_principles_staging')[0].n, 0);
  const c = await post(env, '/api/principles/commit', JSON.stringify({ import_id: 'test-import-0004' }), 'application/json');
  assert.equal(c.status, 409);
});


console.log('\nالتصفّح');

await t.check('الأبواب بترتيب ورودها، والتصفّح بأرقام المبادئ صفحةً صفحة', async () => {
  const { env } = await fixture();
  await importAll(env);
  const books = await lib.listPrincipleBooks(env, 'مدونة-المبادئ-العمالية-1431');
  assert.ok(books.length >= 1);
  assert.deepEqual(books.map((b) => b.first_no), [...books.map((b) => b.first_no)].sort((a, b) => a - b));
  const page = await lib.browsePrinciples(env, 'مدونة-المبادئ-العمالية-1431', { limit: 2 });
  assert.equal(page.total, 6);
  assert.equal(page.principles.length, 2);
  const next = await lib.browsePrinciples(env, 'مدونة-المبادئ-العمالية-1431', { limit: 2, offset: 2 });
  assert.ok(next.principles[0].principleNo > page.principles[1].principleNo);
});

await t.check('التصفّح يُحصر في حال، وحالٌ مجهولة لا تُحصر', async () => {
  const { env } = await fixture();
  await importAll(env);
  const r = await lib.browsePrinciples(env, 'مدونة-المبادئ-العمالية-1432', { status: 'أساسه ملغى' });
  assert.equal(r.total, 1);
  assert.equal(r.principles[0].retrievalStatus, 'أساسه ملغى');
  assert.equal((await lib.browsePrinciples(env, 'مدونة-المبادئ-العمالية-1432', { status: 'ملغى' })).total, 6);
});

await t.check('مسارات القراءة: المدوّنات بعددها وحالاتها، والأبواب، والتصفّح', async () => {
  const { env } = await fixture();
  await importAll(env);
  const get = async (u) => (await lib.app.request(u, {}, env)).json();
  const cols = await get('/api/principles/collections');
  assert.equal(cols.total, 12);
  assert.equal(cols.collections.find((c) => c.collection_id.endsWith('1431')).by_status['نافذ'], 2);
  const books = await get(`/api/principles/books?collection_id=${encodeURIComponent('مدونة-المبادئ-العمالية-1431')}`);
  assert.ok(books.books.length);
  const browse = await get(`/api/principles/browse?collection_id=${encodeURIComponent('مدونة-المبادئ-العمالية-1432')}&limit=3`);
  assert.equal(browse.principles.length, 3);
  assert.equal(browse.total, 6);
});

console.log('\nالبحث والعرض');

await t.check('البحث يجد المبدأ بلفظٍ من نصّه ولو بصيغةٍ أخرى («تذكرة» ← «بتأمين تذكرة»)', async () => {
  const { env } = await fixture();
  await importAll(env);
  const hits = await lib.searchPrinciples(env, 'تذكرة سفر العامل');
  assert.ok(hits.some((h) => h.id === 'مدونة-المبادئ-العمالية-1432/art-0092'), hits.map((h) => h.id).join(', '));
});

await t.check('البحث برقم القرار يجد مبدأه', async () => {
  const { env } = await fixture();
  await importAll(env);
  const target = JSON.parse(LINES[3]);
  const hits = await lib.searchPrinciples(env, target.decision_no);
  assert.equal(hits[0]?.id, target.id);
});

await t.check('الحالات الأربع كلُّها تُسترجع — ما أساسُه ملغى يصل بتحذيره لا يُحجب', async () => {
  const { env } = await fixture();
  await importAll(env);
  const hits = await lib.searchPrinciples(env, 'النصاب النهائي لاختصاص');
  const h = hits.find((x) => x.retrievalStatus === 'أساسه ملغى');
  assert.ok(h, 'لم يُسترجع');
  const block = lib.formatPrincipleBlock(h, '1');
  assert.ok(block.indexOf('تنبيه:') < block.indexOf(h.text), 'التحذير بعد النصّ');
});

await t.check('سطر الإسناد: المدوّنة، ثم رقم المبدأ، ثم القرار وتاريخه، ثم الصفحة', async () => {
  const { env } = await fixture();
  await importAll(env);
  const h = await lib.getPrinciple(env, 'مدونة-المبادئ-العمالية-1431/art-0156');
  const cite = lib.principleCitation(h);
  assert.match(cite, /^مدونة المبادئ العمالية لعام 1431هـ — المبدأ 156 — القرار .+ وتاريخ .+هـ — ص \d+/);
});

await t.check('النافذ بلا سطر تنبيه', async () => {
  const { env } = await fixture();
  await importAll(env);
  const h = await lib.getPrinciple(env, 'مدونة-المبادئ-العمالية-1432/art-0091');
  assert.doesNotMatch(lib.formatPrincipleBlock(h, '1'), /تنبيه:/);
});

await t.check('قسمُ السياق وحده بتعليماته، وفارغٌ بلا مبادئ', async () => {
  const { env } = await fixture();
  await importAll(env);
  assert.equal(lib.formatPrinciplesContext([]), '');
  const hits = await lib.retrievePrinciples(env, ['أجر دون عمل', 'تذكرة سفر']);
  const ctx = lib.formatPrinciplesContext(hits);
  assert.match(ctx, /^\n\n<مبادئ_قضائية>/);
  assert.match(ctx, /لا نصوصٌ ملزمة/);
  assert.ok(hits.length <= 4);
});

await t.check('المبادئ لا تظهر في بحث الموادّ — الجدولان منفصلان', async () => {
  const { env } = await fixture();
  await importAll(env);
  const hits = await lib.searchLegal(env, 'لا أجر دون عمل', { limit: 20, lexicalOnly: true });
  assert.equal(hits.length, 0);
});

await t.check('جدولٌ لم يُهيّأ لا يُسقط الدور: البحث يعود فارغاً', async () => {
  const { env, db } = await fixture();
  db.sqlite.exec('DROP TABLE legal_principles_fts');
  assert.deepEqual(await lib.searchPrinciples(env, 'أجر'), []);
  assert.deepEqual(await lib.retrievePrinciples(env, ['أجر']), []);
});

t.done();
