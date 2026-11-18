// فحوص الفحص الشهري لمصادر الأنظمة المستوردة (`src/lib/updateChecks.ts`، §١٥ في العقد).
//
// المدخل مقتطفٌ من التقرير الحقيقي يوم 18 نوفمبر 2026: المادة ٣٥ من نظام القضاء
// عُدِّلت بالمرسوم م/100 وتاريخ 1448/4/3هـ ولم تُستورد، ونوافذُ قديمة في النظام
// التجاري ونظام المعهد لم تُربط بمادة منذ السحب، وحالُ نظام التنفيذ الجديد تبدّلت.
//
//   npm run check:update-checks
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ROOT, bundle, makeDb, makeKv, makeCtx, suite } from './harness.mjs';

const t = suite('فحوص الفحص الشهري');

const AUTH_STUB = `
export async function requireAuth(c: any, next: any) {
  c.set('user', { id: 'admin1', email: 'a@x', role: 'admin' });
  await next();
}
export const requireAdmin = requireAuth;
export const requireWriter = requireAuth;
export async function audit() {}
`;

const lib = await bundle(
  'update-checks',
  `export * from './updateChecks';
   export { parseJsonl, upsertLegalChunks, getArticle, getChunkById, revertLaw } from './legal';
   export { fromLegalHit, noticeLines } from './rag';
   import { Hono } from 'hono';
   import legalRoutes from '../routes/legal';
   export const app = new Hono().route('/api/legal', legalRoutes);`,
  { resolveDir: path.join(ROOT, 'src', 'lib'), stubs: { '../lib/auth': AUTH_STUB } }
);

const REPORT_TEXT = await readFile(path.join(ROOT, 'audit', 'fixtures', 'update-check-2026-11-18.json'), 'utf8');
const REPORT = JSON.parse(REPORT_TEXT);
const ENV_BASE = { ANTHROPIC_API_KEY: 'test', EMBEDDING_MODEL: '@cf/baai/bge-m3' };

/** مادتان من نظام القضاء ومادةٌ من التجاري — كما في القاعدة قبل الفحص (سحب 22 سبتمبر). */
function lawRows(capturedAt, extra = {}) {
  const row = (o) => JSON.stringify({ doc_type: 'law', status: 'active', captured_at: capturedAt, ...extra, ...o });
  return lib.parseJsonl([
    row({ id: 'نظام-القضاء/art-035', law_id: 'نظام-القضاء', law_title: 'نظام القضاء', article_no: '35',
          text: 'يشترط فيمن يشغل درجة قاضي (ب) أن يكون قد قضى سنة على الأقل في درجة قاضي (ج)…', embed_text: 'نظام القضاء — المادة 35' }),
    row({ id: 'نظام-القضاء/art-036', law_id: 'نظام-القضاء', law_title: 'نظام القضاء', article_no: '36',
          text: 'يشترط فيمن يشغل درجة وكيل محكمة…', embed_text: 'نظام القضاء — المادة 36' }),
  ].join('\n')).rows;
}
function commercialRows(capturedAt) {
  return lib.parseJsonl(JSON.stringify({
    id: 'tijari/art-467', law_id: 'النظام-التجاري-(نظام-المحكمة-التجارية)', law_title: 'النظام التجاري', article_no: '467',
    doc_type: 'law', status: 'active', captured_at: capturedAt, text: 'نصّ', embed_text: 'النظام التجاري — 467',
  })).rows;
}

async function fixture() {
  const db = await makeDb();
  const env = { ...ENV_BASE, DB: db.DB, KV: makeKv() };
  await lib.upsertLegalChunks(env, lawRows('2026-09-22T17:14:25.982Z'));
  await lib.upsertLegalChunks(env, commercialRows('2026-09-22T17:14:25.982Z'));
  return { db, env };
}

const article = async (env, no, lawId = 'نظام-القضاء') => (await lib.getArticle(env, { lawId, articleNo: no }))[0];
const plain = (rows) => rows.map((r) => ({ ...r }));
const openOf = (db, lawId) => db.q(`SELECT * FROM legal_update_findings WHERE law_id = ? AND state = 'open'`, lawId);

console.log('\nالتقرير والتنبيه');

await t.check('التقرير الحقيقي يُقبل: أربعة بنود ونظامان جديدان وملفُّ جهة، وتنبيهٌ واحد — على المادة ٣٥ وحدها', async () => {
  const { db, env } = await fixture();
  const r = await lib.ingestReport(env, REPORT_TEXT, { actorId: 'admin1' });
  assert.equal(r.duplicate, false);
  assert.equal(r.added, 7);
  assert.equal(r.notices, 1);
  const pend = db.q('SELECT law_id, article_no_norm, notice FROM legal_pending_updates');
  assert.equal(pend.length, 1);
  assert.equal(pend[0].law_id, 'نظام-القضاء');
  assert.equal(pend[0].article_no_norm, '35');
  assert.match(pend[0].notice, /بالمرسوم الملكي رقم \(م\/100\) وتاريخ 1448\/4\/3هـ/);
  assert.match(pend[0].notice, /لم يُستورد بعد/);
});

await t.check('النوافذ القديمة لا تُنبِّه: التجاري (1435هـ) والمعهد (1417هـ) للمسؤول وحده', async () => {
  const { db, env } = await fixture();
  await lib.ingestReport(env, REPORT_TEXT);
  assert.equal(openOf(db, 'النظام-التجاري-(نظام-المحكمة-التجارية)').length, 1);
  assert.equal(db.q(`SELECT COUNT(*) AS n FROM legal_pending_updates WHERE law_id = 'النظام-التجاري-(نظام-المحكمة-التجارية)'`)[0].n, 0);
  const a = await article(env, '467', 'النظام-التجاري-(نظام-المحكمة-التجارية)');
  assert.equal(a.pendingUpdate, null);
});

await t.check('التنبيه يصل كل مسار قراءة: المادة نفسها، وسياق المساعد بسطرٍ يبدأ بـ«تنبيه:»، ولا يمسّ جارتها', async () => {
  const { env } = await fixture();
  await lib.ingestReport(env, REPORT_TEXT);
  const a35 = await article(env, '35');
  const a36 = await article(env, '36');
  assert.match(a35.pendingUpdate ?? '', /صدر تعديلٌ على هذه المادة/);
  assert.equal(a36.pendingUpdate, null);
  const byId = await lib.getChunkById(env, 'نظام-القضاء/art-035');
  assert.equal(byId.pendingUpdate, a35.pendingUpdate);
  const lines = lib.noticeLines(lib.fromLegalHit(a35));
  assert.match(lines, /^تنبيه: صدر تعديلٌ على هذه المادة/m);
  assert.equal(lib.noticeLines(lib.fromLegalHit(a36)), '');
});

await t.check('الملف نفسه مرّةً واحدة: إعادته «مرفوعٌ من قبل» ولا تُكتب', async () => {
  const { db, env } = await fixture();
  await lib.ingestReport(env, REPORT_TEXT);
  const again = await lib.ingestReport(env, REPORT_TEXT);
  assert.equal(again.duplicate, true);
  assert.equal(db.q('SELECT COUNT(*) AS n FROM legal_update_checks')[0].n, 1);
  assert.equal(db.q('SELECT COUNT(*) AS n FROM legal_update_findings')[0].n, 7);
});

await t.check('ما لا يُبنى عليه يُرفض بسببه: الإصدار الأول، وملفٌّ ليس تقريراً، وفحصٌ كامل أقدم من المرفوع', async () => {
  const { env } = await fixture();
  await assert.rejects(lib.ingestReport(env, JSON.stringify({ ...REPORT, version: 1 })), /أقدم من المقبول/);
  await assert.rejects(lib.ingestReport(env, '{"id":"x"}'), /ليس تقرير فحص/);
  await assert.rejects(lib.ingestReport(env, 'not json'), /ليس JSON/);
  await lib.ingestReport(env, REPORT_TEXT);
  await assert.rejects(lib.ingestReport(env, JSON.stringify({ ...REPORT, run: '2026-10-18' })), /أقدم من آخر فحصٍ كامل/);
});

console.log('\nالإغلاق وإعادة الفتح');

await t.check('إعادة الرفع من سحبٍ قديم لا تُسقط التنبيه — السلسلة أُعيدت والتعديل لم يُسحب', async () => {
  const { db, env } = await fixture();
  await lib.ingestReport(env, REPORT_TEXT);
  await lib.upsertLegalChunks(env, lawRows('2026-09-22T17:14:25.982Z'), { batchId: 'b-old' });
  assert.equal(openOf(db, 'نظام-القضاء').length, 1);
  assert.ok((await article(env, '35')).pendingUpdate);
});

await t.check('استيرادُ سحبٍ بعد يوم الرصد يُغلق البند ويرفع التنبيه — وردُّ الدفعة يعيدهما', async () => {
  const { db, env } = await fixture();
  await lib.ingestReport(env, REPORT_TEXT);
  await lib.upsertLegalChunks(env, lawRows('2026-11-19T08:00:00.000Z'), { batchId: 'b-new' });
  const closed = plain(db.q(`SELECT state, resolved_how, resolved_batch FROM legal_update_findings WHERE law_id = 'نظام-القضاء'`));
  assert.deepEqual(closed, [{ state: 'resolved', resolved_how: 'imported', resolved_batch: 'b-new' }]);
  assert.equal((await article(env, '35')).pendingUpdate, null);
  // الردّ يعيد النصّ القديم — فالتنبيه يعود معه.
  await lib.revertLaw(env, 'b-new', 'نظام-القضاء');
  assert.equal(openOf(db, 'نظام-القضاء').length, 1);
  assert.match((await article(env, '35')).pendingUpdate ?? '', /م\/100/);
});

await t.check('فحصٌ كامل لاحق لا يرصد البند لنظامٍ فحصه: «لم يعد يُرصد» ويُغلق', async () => {
  const { db, env } = await fixture();
  await lib.ingestReport(env, REPORT_TEXT);
  const later = { ...REPORT, run: '2026-12-18', findings: REPORT.findings.filter((f) => f.law_id !== 'نظام-القضاء'), newLaws: [] };
  const r = await lib.ingestReport(env, JSON.stringify(later));
  assert.equal(r.resolved, 1);
  assert.deepEqual(plain(db.q(`SELECT state, resolved_how FROM legal_update_findings WHERE law_id = 'نظام-القضاء'`)), [{ state: 'resolved', resolved_how: 'gone' }]);
  assert.equal(db.q('SELECT COUNT(*) AS n FROM legal_pending_updates')[0].n, 0);
});

await t.check('والسريع لا يُغلق شيئاً: صفحاته بعضُ الفهرس', async () => {
  const { db, env } = await fixture();
  await lib.ingestReport(env, REPORT_TEXT);
  const quick = { ...REPORT, run: '2026-11-25', mode: 'quick', findings: [], newLaws: [] };
  const r = await lib.ingestReport(env, JSON.stringify(quick));
  assert.equal(r.resolved, 0);
  assert.equal(openOf(db, 'نظام-القضاء').length, 1);
});

await t.check('التقرير التالي يحدّث البند ولا يضاعفه', async () => {
  const { db, env } = await fixture();
  await lib.ingestReport(env, REPORT_TEXT);
  const r = await lib.ingestReport(env, JSON.stringify({ ...REPORT, run: '2026-12-18' }));
  assert.equal(r.added, 0);
  assert.equal(r.updated, 7);
  const f = openOf(db, 'نظام-القضاء');
  assert.equal(f.length, 1);
  assert.equal(f[0].first_run, '2026-11-18');
  assert.equal(f[0].last_run, '2026-12-18');
});

await t.check('المستبعَد يُرفع تنبيهه ولا يعود ما دام المرصودُ نفسه — ويعود إن تغيّر', async () => {
  const { db, env } = await fixture();
  await lib.ingestReport(env, REPORT_TEXT);
  const id = openOf(db, 'نظام-القضاء')[0].id;
  assert.equal(await lib.dismissFinding(env, id, 'admin1', 'تحقّقنا'), true);
  assert.equal((await article(env, '35')).pendingUpdate, null);
  const same = await lib.ingestReport(env, JSON.stringify({ ...REPORT, run: '2026-12-18' }));
  assert.equal(same.skipped_dismissed, 1);
  assert.equal(openOf(db, 'نظام-القضاء').length, 0);
  // تعديلٌ آخر للمادة نفسها: مرصودٌ جديد.
  const changed = structuredClone(REPORT);
  changed.run = '2027-01-18';
  changed.findings[0].windows = [{ ...changed.findings[0].windows[0], text: changed.findings[0].windows[0].text.replace('م/100', 'م/140').replace('1448/4/3', '1448/7/1') }];
  const r = await lib.ingestReport(env, JSON.stringify(changed));
  assert.equal(r.skipped_dismissed, 0);
  assert.match((await article(env, '35')).pendingUpdate ?? '', /م\/140/);
});

await t.check('نظامٌ صار لاغياً في مصدره: تنبيهٌ على موادّه كلّها، ويُغلق حين يصير لاغياً في القاعدة', async () => {
  const { db, env } = await fixture();
  const rep = { ...REPORT, findings: [{ law_id: 'نظام-القضاء', law_name: 'نظام القضاء', kind: 'status', level: 1,
    detail: '«ساري» ← «لاغي»', from: 'ساري', to: 'لاغي', to_repealed: true }], newLaws: [] };
  await lib.ingestReport(env, JSON.stringify(rep));
  assert.match((await article(env, '36')).pendingUpdate ?? '', /صارت «لاغي»/);
  // استيرادٌ لا يحمل الإلغاء لا يُغلقه — ولو كان سحبه بعد الرصد.
  await lib.upsertLegalChunks(env, lawRows('2026-11-19T08:00:00.000Z'));
  assert.equal(openOf(db, 'نظام-القضاء').length, 1);
  await lib.upsertLegalChunks(env, lawRows('2026-11-19T08:00:00.000Z', { law_repealed: true }));
  assert.equal(openOf(db, 'نظام-القضاء').length, 0);
});

await t.check('«نظامٌ جديد» يُغلق حين يُستورد نظامٌ مصدرُه رابطه', async () => {
  const { db, env } = await fixture();
  await lib.ingestReport(env, REPORT_TEXT);
  const n = REPORT.newLaws[0];
  const id = `boe:${n.guid ?? n.url.match(/LawDetails\/([0-9a-f-]{36})/i)[1]}`.toLowerCase();
  assert.equal(openOf(db, id).length, 1);
  await lib.upsertLegalChunks(env, lib.parseJsonl(JSON.stringify({
    id: 'new/art-1', law_id: 'نظام-جديد', law_title: n.name, article_no: '1', doc_type: 'law', status: 'active',
    captured_at: '2026-11-20T00:00:00Z', source_url: n.url, text: 'نص', embed_text: 'نص',
  })).rows);
  assert.equal(openOf(db, id).length, 0);
});

console.log('\nالمسارات');

await t.check('POST ‎/api/legal/update-checks يستقبل الملف، وGET يعرض بنوده، والاستبعاد يُغلقها', async () => {
  const { env } = await fixture();
  const ctx = makeCtx();
  let res = await lib.app.request('/api/legal/update-checks?filename=report.json', { method: 'POST', body: REPORT_TEXT, headers: { 'content-type': 'application/json' } }, env, ctx);
  let body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.notices, 1);
  res = await lib.app.request('/api/legal/update-checks', {}, env, ctx);
  body = await res.json();
  assert.equal(body.checks.length, 1);
  assert.equal(body.open.length, 7);
  const q = body.open.find((f) => f.law_id === 'نظام-القضاء');
  assert.equal(q.level, 1);
  assert.equal(q.notices, 1);
  assert.equal(q.in_base, true);
  res = await lib.app.request(`/api/legal/update-checks/findings/${q.id}/dismiss`, { method: 'POST', body: JSON.stringify({ note: 'x' }), headers: { 'content-type': 'application/json' } }, env, ctx);
  assert.equal(res.status, 200);
  res = await lib.app.request('/api/legal/update-checks', {}, env, ctx);
  body = await res.json();
  assert.equal(body.open.length, 6);
  assert.equal(body.closed[0].state, 'dismissed');
  res = await lib.app.request(`/api/legal/update-checks/findings/${q.id}/reopen`, { method: 'POST' }, env, ctx);
  assert.equal(res.status, 200);
  assert.match((await article(env, '35')).pendingUpdate ?? '', /م\/100/);
});

await t.check('ملفٌّ ليس تقريراً يُردّ بسببه ورمز 400، والأقدم بـ409', async () => {
  const { env } = await fixture();
  const ctx = makeCtx();
  let res = await lib.app.request('/api/legal/update-checks', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } }, env, ctx);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /ليس تقرير فحص/);
  await lib.ingestReport(env, REPORT_TEXT);
  res = await lib.app.request('/api/legal/update-checks', { method: 'POST', body: JSON.stringify({ ...REPORT, run: '2026-10-01' }), headers: { 'content-type': 'application/json' } }, env, ctx);
  assert.equal(res.status, 409);
});

console.log('\nالنصوص');

await t.check('أداة التعديل تُقرأ من نافذتها بصيغها، وما لا يُقرأ لا يُخمَّن', () => {
  assert.equal(lib.instrumentOf('- عُدلت هذه المادة وذلك بموجب المرسوم الملكي رقم (م/100) وتاريخ 1448/4/3هـ، لتصبح'), 'بالمرسوم الملكي رقم (م/100) وتاريخ 1448/4/3هـ');
  assert.equal(lib.instrumentOf('بموجب قرار مجلس الوزراء رقم ( 197 ) وتاريخ 29 / 11 / 1417 هـ'), 'بقرار مجلس الوزراء رقم (197) وتاريخ 29/11/1417هـ');
  assert.equal(lib.instrumentOf('تم تعديل هذه المادة'), '');
});

t.done();
