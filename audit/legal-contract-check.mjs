// فحص عقد استيراد المحتوى النظامي — NAF-legal
//
// يشغّل **كود المنصة الحقيقي** (`src/lib/legal.ts` و`src/lib/rag.ts` كما هما)
// على قاعدة SQLite حقيقية بُنيت من ملف الهجرة نفسه (`migrations/0012`)، مع
// بديلين في الذاكرة للفهرس المتجهي ولنموذج التضمين.
//
// وهذا ما يجعله فحص عقد لا فحص وحدات: لا يُعاد هنا بناء منطق البحث ولا
// التصفية ولا الاستيراد — تُستدعى الدوال نفسها التي يستدعيها الـWorker،
// ويُقاس ما تفعله بأربعة التزامات العقد:
//
//   ١) سطر واحد = مقطع واحد، والتقطيع التلقائي معطَّل
//   ٢) `embed_text` وحده يصير متجهاً، و`text` وحده يُعرض ويُستشهد به
//   ٣) بحث هجين مع تطبيع عربي
//   ٤) التصفية على السريان في طبقة الاسترجاع لا في الواجهة
//
// التشغيل:  npm run check:legal

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── حزم كود المنصة الحقيقي ──
// ملفّاته TypeScript ويستورد بعضها بعضاً بلا امتداد، وNode لا يحلّ ذلك.
const lib = await (async () => {
  const esbuild = await import('esbuild');
  const cache = path.join(ROOT, 'node_modules', '.cache');
  await mkdir(cache, { recursive: true });
  const built = await esbuild.build({
    // مدخلٌ في الذاكرة لا ملفٌّ يُكتب في `src/`: هذا فحصٌ لا يترك أثراً في
    // شجرة المصدر. و`resolveDir` يجعل `./legal` و`./rag` تُحلّان من مكانهما.
    stdin: {
      contents: "export * from './legal';\nexport { retrieve, formatRagContext } from './rag';\n",
      resolveDir: path.join(ROOT, 'src', 'lib'),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
  });
  const out = path.join(cache, 'naf-legal-contract.mjs');
  await writeFile(out, built.outputFiles[0].text);
  return import(pathToFileURL(out).href);
})();

// ── قاعدة بيانات من ملف الهجرة نفسه ──
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(await readFile(path.join(ROOT, 'migrations', '0001_init.sql'), 'utf8'));
sqlite.exec(await readFile(path.join(ROOT, 'migrations', '0012_legal_corpus.sql'), 'utf8'));

/** بديل D1 بواجهته نفسها فوق node:sqlite. */
class Prepared {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Prepared(this.db, this.sql, args);
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.args), success: true };
  }
  async first() {
    return this.db.prepare(this.sql).all(...this.args)[0] ?? null;
  }
  async run() {
    return this.db.prepare(this.sql).run(...this.args);
  }
}

const DB = {
  prepare: (sql) => new Prepared(sqlite, sql),
  async batch(statements) {
    sqlite.exec('BEGIN');
    try {
      const out = [];
      for (const s of statements) out.push(await s.run());
      sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      sqlite.exec('ROLLBACK');
      throw e;
    }
  },
};

// ── بديل نموذج التضمين ──
// متجه حقيبة كلمات: نصّان يشتركان في كلماتهما يتقاربان. يكفي لاختبار أن
// المسار الدلالي يعمل ويُدمج، ويسجّل كل نصّ وصله ليُتحقَّق من أنه
// `embed_text` لا `text`.
const DIM = 64;
const embeddedTexts = [];

function fakeVector(text) {
  const v = new Array(DIM).fill(0);
  for (const token of String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!token) continue;
    const stem = token.startsWith('ال') && token.length >= 5 ? token.slice(2) : token;
    let h = 0;
    for (let i = 0; i < stem.length; i++) h = (Math.imul(h, 31) + stem.charCodeAt(i)) >>> 0;
    v[h % DIM] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

const AI = {
  async run(_model, { text }) {
    embeddedTexts.push(...text);
    return { data: text.map(fakeVector) };
  },
};

// ── بديل الفهرس المتجهي ──
const vectorStore = new Map();
const VECTORIZE = {
  async upsert(vectors) {
    for (const v of vectors) vectorStore.set(v.id, v);
  },
  async query(vector, { topK = 10 } = {}) {
    const matches = [];
    for (const [id, v] of vectorStore) {
      let dot = 0;
      for (let i = 0; i < DIM; i++) dot += vector[i] * v.values[i];
      matches.push({ id, score: dot, metadata: v.metadata });
    }
    matches.sort((a, b) => b.score - a.score);
    return { matches: matches.slice(0, topK) };
  },
  async deleteByIds(ids) {
    for (const id of ids) vectorStore.delete(id);
  },
};

const env = { DB, AI, VECTORIZE, EMBEDDING_MODEL: '@cf/baai/bge-m3' };

// ── بيانات الفحص ──
const LONG_ARTICLE = `يلتزم صاحب العمل بما يلي: ${'بندٌ من بنود الالتزام التفصيلية. '.repeat(400).trim()}`;

const line = (o) => JSON.stringify(o);
const CORPUS = [
  line({
    id: 'labor:74',
    law_id: 'labor',
    doc_type: 'law',
    article_no: '74',
    instrument_no: 'م/51',
    status: 'active',
    law_title: 'نظام العمل',
    issue_date: '2005-09-27',
    issue_date_hijri: '1426/08/23هـ',
    text: 'يَنتهي عقدُ العمل في الحالات الآتية: إذا اتفق الطرفان على إنهائه، وتُتَّبع الإجراءات النظامية المقرَّرة.',
    embed_text: 'نظام العمل — المادة 74 — انتهاء عقد العمل: الحالات التي ينتهي بها عقد العمل والإجراءات النظامية المقررة لإنهائه.',
  }),
  line({
    id: 'labor:77',
    law_id: 'labor',
    doc_type: 'law',
    article_no: '77',
    status: 'active',
    law_title: 'نظام العمل',
    text: 'إذا أُنهي العقد لسبب غير مشروع، استحقّ العامل تعويضاً عن مدة الإخطار.',
    embed_text: 'نظام العمل — المادة 77 — التعويض عن إنهاء العقد لسبب غير مشروع ومدة الإخطار.',
  }),
  line({
    id: 'labor-reg:12',
    law_id: 'labor-regulation',
    parent_law_id: 'labor',
    doc_type: 'regulation',
    article_no: '12',
    status: 'active',
    law_title: 'اللائحة التنفيذية لنظام العمل',
    text: 'تُحسب مدة الإخطار وفق ما ورد في اللائحة.',
    embed_text: 'اللائحة التنفيذية لنظام العمل — المادة 12 — احتساب مدة الإخطار.',
  }),
  line({
    id: 'labor:old-80',
    law_id: 'labor',
    doc_type: 'law',
    article_no: '80',
    status: 'repealed',
    is_repealed: true,
    law_title: 'نظام العمل',
    text: 'نصٌّ منسوخ لا يجوز الاستشهاد به: يجوز لصاحب العمل الفصل دون مكافأة.',
    embed_text: 'نظام العمل — المادة 80 (منسوخة) — الفصل دون مكافأة والإجراءات النظامية لإنهاء عقد العمل.',
  }),
  line({
    id: 'labor:طويلة',
    law_id: 'labor',
    doc_type: 'law',
    article_no: '99',
    status: 'active',
    law_title: 'نظام العمل',
    text: LONG_ARTICLE,
    embed_text: LONG_ARTICLE,
  }),
];

const results = [];
function check(title, fn) {
  return (async () => {
    await fn();
    results.push(`  [ok] ${title}`);
  })().catch((e) => {
    results.push(`  [فشل] ${title}\n        ${e.message}`);
    process.exitCode = 1;
  });
}

const q = (sql, ...args) => sqlite.prepare(sql).all(...args);

// ═══ ١) الاستيراد: سطر واحد = مقطع واحد ═══

// BOM: العقد يشترط UTF-8 بلا BOM — يُسقَط ويُقال، ولا يتسرّب إلى المعرّف.
const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(CORPUS.join('\n') + '\n')]);
const parsed = lib.parseJsonl(withBom);

await check('١ · سطر واحد = مقطع واحد: خمسة أسطر ⇦ خمسة مقاطع', () => {
  assert.equal(parsed.total, 5);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows.length, 5);
});

await check('١ · علامة BOM تُسقَط ويُبلَّغ عنها ولا تتسرّب إلى المعرّف', () => {
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /BOM/);
  assert.equal(parsed.rows[0].id, 'labor:74');
});

await check('١ · التقطيع التلقائي معطَّل: مادة من ١٢ ألف حرف تبقى مقطعاً واحداً بنصّها كاملاً', async () => {
  await lib.upsertLegalChunks(env, parsed.rows);
  const rows = q('SELECT text FROM legal_chunks WHERE id = ?', 'labor:طويلة');
  assert.equal(rows.length, 1, 'المادة الطويلة قُسِّمت إلى أكثر من مقطع');
  assert.equal(rows[0].text, LONG_ARTICLE, 'نصّ المادة الطويلة لم يبقَ كما ورد');
  assert.ok(LONG_ARTICLE.length > 10_000);
});

await check('١ · سطر فاسد يُبلَّغ برقمه ولا يُسقِط بقية الأسطر', () => {
  const bad = lib.parseJsonl(['{"id":"a","text":"نص","embed_text":"سياق"}', '{ليس JSON}', '{"id":"c","text":"نص","embed_text":"سياق"}'].join('\n'));
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.errors[0].line, 2);
  assert.equal(bad.rows.length, 2);
});

await check('١ · سطر بلا `embed_text` يُرفض ولا يُستعاض عنه بـ`text` صامتاً', () => {
  const bad = lib.parseJsonl('{"id":"a","text":"نص المادة"}');
  assert.equal(bad.rows.length, 0);
  assert.match(bad.errors[0].error, /embed_text/);
});

await check('١ · تقرير الرفض يجمع الأسباب ويعدّها كلَّها ويقول ما حمله السطر', () => {
  // ملفٌّ مولَّد بقالب واحد: مئةُ رسالة متطابقة لا تقول أكثر مما تقوله
  // واحدة، والعدد المخفيّ خلف سقف العرض يُخفي الحقيقة كلَّها.
  const lines = [];
  for (let i = 1; i <= 60; i++) lines.push(line({ id: `x:${i}`, law_id: 'x', article_no: String(i), text: 'نصّ المادة' }));
  lines.push(line({ id: 'y:1', text: 'ن', embed_text: 'س', status: 'draft' }));

  const bad = lib.parseJsonl(lines.join('\n'));
  assert.equal(bad.rows.length, 0);
  assert.equal(bad.errors.length, 61);

  const groups = lib.summarizeErrors(bad.errors);
  assert.equal(groups.length, 2, 'الأسباب لم تُجمَع');
  assert.equal(groups[0].code, 'missing_embed_text');
  assert.equal(groups[0].count, 60, 'العدّ على المعروض لا على الكل');
  assert.ok(groups[0].lines.length > 0 && groups[0].lines.length <= 5, 'أمثلة الأسطر إمّا غائبة أو غير مقصوصة');
  assert.deepEqual(groups[0].keys, ['id', 'law_id', 'article_no', 'text'], 'حقول السطر لم تُذكر، فلا يُعرف الناقص');
  assert.equal(groups[1].code, 'bad_status');
});

await check('١ · ألفاظ الحالة العربية تُقابَل بالمسجَّلة، ولا حالة رابعة', () => {
  const rows = [
    ['ساري', 'active'], ['سارٍ', 'active'], ['سارية', 'active'], ['نافذ', 'active'],
    ['مُعدَّل', 'amended'], ['ملغى', 'repealed'], ['منسوخة', 'repealed'],
  ];
  for (const [given, expected] of rows) {
    const p = lib.parseJsonl(line({ id: `s:${given}`, text: 'ن', embed_text: 'س', status: given }));
    assert.deepEqual(p.errors, [], `«${given}» رُفضت`);
    assert.equal(p.rows[0].status, expected, `«${given}» لم تُقابَل بـ${expected}`);
    assert.equal(p.rows[0].is_repealed, expected === 'repealed' ? 1 : 0);
  }
});

await check('١ · `embed_text` يُبنى بطلبٍ صريح وحده، ويُعَدّ ولا يقع صامتاً', () => {
  const row = line({ id: 'b:1', law_name: 'نظام العمل', article_no: '74', text: 'نصّ المادة كما ورد' });

  const strict = lib.parseJsonl(row);
  assert.equal(strict.rows.length, 0, 'بُني بلا طلب');
  assert.equal(strict.errors[0].code, 'missing_embed_text');

  const built = lib.parseJsonl(row, { buildEmbedText: true });
  assert.deepEqual(built.errors, []);
  assert.equal(built.builtEmbedText, 1, 'البناء لم يُعَدّ');
  // نصُّ التضمين مركَّب من اسم النظام ورقم المادة والنصّ — لا `text` مجرَّداً.
  assert.equal(built.rows[0].embed_text, 'نظام العمل — المادة 74\nنصّ المادة كما ورد');
  assert.equal(built.rows[0].text, 'نصّ المادة كما ورد', 'النصّ المعروض تغيّر');
  assert.equal(built.rows[0].law_title, 'نظام العمل', '`law_name` لم يُقرأ');
});

await check('١ · مرادفات الحقول: law_name · date_gregorian · date_hijri', () => {
  const p = lib.parseJsonl(
    line({ id: 'a:1', law_name: 'نظام', date_gregorian: '2005-09-27', date_hijri: '1426/08/23هـ', text: 'ن', embed_text: 'س' })
  );
  assert.deepEqual(p.errors, []);
  assert.equal(p.rows[0].law_title, 'نظام');
  assert.equal(p.rows[0].issue_date, '2005-09-27');
  assert.equal(p.rows[0].issue_date_hijri, '1426/08/23هـ');
});

await check('١ · حالة سريان غير معروفة تُرفض', () => {
  const bad = lib.parseJsonl('{"id":"a","text":"ن","embed_text":"س","status":"مسودة"}');
  assert.equal(bad.rows.length, 0);
  assert.match(bad.errors[0].error, /status/);
});

// ═══ الاستيراد استبدال لا إضافة ═══

await check('١ · `upsert` على `id`: إعادة رفع نظام محدَّث تستبدل المادة ولا تضاعفها', async () => {
  const before = q('SELECT COUNT(*) AS n FROM legal_chunks')[0].n;
  const updatedLine = line({
    id: 'labor:77',
    law_id: 'labor',
    doc_type: 'law',
    article_no: '77',
    status: 'active',
    law_title: 'نظام العمل',
    text: 'نصٌّ محدَّث للمادة 77 بعد التعديل.',
    embed_text: 'نظام العمل — المادة 77 — النصّ المحدَّث بعد التعديل.',
  });
  const again = lib.parseJsonl(updatedLine);
  const counts = await lib.upsertLegalChunks(env, again.rows);

  assert.equal(counts.inserted, 0, 'المادة القائمة عُدَّت جديدة');
  assert.equal(counts.updated, 1);
  assert.equal(q('SELECT COUNT(*) AS n FROM legal_chunks')[0].n, before, 'عدد المقاطع تغيّر — الاستيراد أضاف بدل أن يستبدل');
  assert.equal(q('SELECT COUNT(*) AS n FROM legal_chunks WHERE id = ?', 'labor:77')[0].n, 1);
  assert.match(q('SELECT text FROM legal_chunks WHERE id = ?', 'labor:77')[0].text, /محدَّث/);
});

// ═══ ٢) الفهرسة: حقلان بدورين مختلفين ═══

await check('٢ · `embed_text` وحده يُحوَّل إلى متجه — ولا يمرّ `text` بنموذج التضمين', async () => {
  embeddedTexts.length = 0;
  const result = await lib.embedPending(env, 100);
  assert.equal(result.remaining, 0, 'بقيت مقاطع بلا تضمين');
  assert.ok(result.embedded >= 5);

  const chunks = q('SELECT text, embed_text FROM legal_chunks');
  for (const sent of embeddedTexts) {
    const match = chunks.find((c) => c.embed_text.startsWith(sent.slice(0, 60)));
    assert.ok(match, `نصٌّ أُرسل للتضمين لا يطابق أيّ \`embed_text\`: ${sent.slice(0, 40)}…`);
  }
  for (const c of chunks) {
    if (c.text === c.embed_text) continue; // المادة الطويلة: الحقلان متطابقان قصداً
    assert.ok(!embeddedTexts.includes(c.text), 'نصّ العرض (`text`) أُرسل إلى نموذج التضمين');
  }
});

await check('٢ · إعادة استيراد بلا تغيير في `embed_text` لا تُعيد التضمين', async () => {
  embeddedTexts.length = 0;
  const again = lib.parseJsonl(CORPUS[0]);
  await lib.upsertLegalChunks(env, again.rows);
  const after = await lib.embedPending(env, 100);
  assert.equal(after.embedded, 0, 'أُعيد تضمين مقطع لم يتغيّر نصّه');
  assert.equal(embeddedTexts.length, 0);
});

await check('٢ · النتيجة تحمل `text` وحده — لا أثر لـ`embed_text` في مخرَج البحث', async () => {
  const hits = await lib.searchLegal(env, 'انتهاء عقد العمل', { limit: 5 });
  assert.ok(hits.length > 0);
  const serialized = JSON.stringify(hits);
  assert.ok(!('embed_text' in hits[0]), '`embed_text` ظهر في النتيجة');
  assert.ok(!serialized.includes('— المادة 74 — انتهاء'), 'سياق التضمين تسرّب إلى مخرَج الاستشهاد');
  const article74 = hits.find((h) => h.id === 'labor:74');
  assert.ok(article74.text.startsWith('يَنتهي عقدُ العمل'), 'النصّ المعروض ليس النصّ كما ورد');
});

// ═══ ٣) البحث الهجين مع التطبيع العربي ═══

await check('٣ · التطبيع: «الاجراءات» بلا همزة تطابق «الإجراءات»', async () => {
  const hits = await lib.searchLegal(env, 'الاجراءات النظاميه', { limit: 5 });
  assert.ok(hits.some((h) => h.id === 'labor:74'), 'لم تُطابق المادة التي تحمل «الإجراءات النظامية»');
  assert.ok(hits.some((h) => h.signals.includes('lexical')), 'المسار اللفظي لم يشارك');
});

await check('٣ · التطبيع: «إجراءات» بلا أل التعريف تطابق «الإجراءات»', async () => {
  const hits = await lib.searchLegal(env, 'إجراءات إنهاء العقد', { limit: 5 });
  assert.ok(hits.some((h) => h.id === 'labor:74'));
});

await check('٣ · اللفظي يجد رقم المادة ولو لم يرد داخل نصّها', async () => {
  const hits = await lib.searchLegal(env, 'المادة 74 من نظام العمل', { limit: 5 });
  assert.equal(hits[0].id, 'labor:74', 'المادة المطلوبة برقمها ليست الأولى');
  assert.ok(hits[0].signals.includes('article') || hits[0].signals.includes('lexical'));
  assert.ok(!q('SELECT text FROM legal_chunks WHERE id = ?', 'labor:74')[0].text.includes('74'));
});

await check('٣ · هجين فعلاً: المساران يشاركان في نتيجة واحدة', async () => {
  const hits = await lib.searchLegal(env, 'التعويض عن الإخطار', { limit: 10 });
  const signals = new Set(hits.flatMap((h) => h.signals));
  assert.ok(signals.has('semantic'), 'المسار الدلالي لم يشارك');
  assert.ok(signals.has('lexical'), 'المسار اللفظي لم يشارك');
});

await check('٣ · الدلالي يجد ما لا تطابقه الكلمات حرفياً', async () => {
  // «مكافأة» لا ترد في نصّ أيّ مادة سارية — الوصول إليها دلاليّ لا لفظيّ.
  const hits = await lib.searchLegal(env, 'احتساب مدة الإخطار في اللائحة', { limit: 5 });
  const reg = hits.find((h) => h.id === 'labor-reg:12');
  assert.ok(reg, 'اللائحة لم تُسترجَع');
});

// ═══ ٤) البيانات الوصفية: تصفية قبل البحث ═══

await check('٤ · التصفية الإلزامية: المادة المنسوخة لا تظهر في البحث افتراضياً', async () => {
  const hits = await lib.searchLegal(env, 'الفصل دون مكافأة والإجراءات النظامية', { limit: 20 });
  assert.ok(!hits.some((h) => h.id === 'labor:old-80'), 'مادة منسوخة ظهرت في نتائج البحث');
  assert.ok(hits.every((h) => !h.isRepealed && h.status !== 'repealed'));
});

await check('٤ · المنسوخة موجودة في القاعدة ومفهرسة — الإسقاط عند الاسترجاع لا عند الكتابة', () => {
  assert.equal(q('SELECT COUNT(*) AS n FROM legal_chunks WHERE id = ?', 'labor:old-80')[0].n, 1);
  assert.ok(vectorStore.size >= 5);
});

await check('٤ · الأرشيف يُفتح بطلب صريح وحده', async () => {
  const hits = await lib.searchLegal(env, 'الفصل دون مكافأة', { limit: 20, includeRepealed: true });
  assert.ok(hits.some((h) => h.id === 'labor:old-80'));
});

await check('٤ · استدعاء مادة منسوخة بمعرّفها يُردّ كذلك', async () => {
  assert.equal(await lib.getChunkById(env, 'labor:old-80'), null);
  assert.ok(await lib.getChunkById(env, 'labor:old-80', true));
});

await check('٤ · استدعاء مادة بعينها: `law_id` + `article_no`', async () => {
  const hits = await lib.getArticle(env, { lawId: 'labor', articleNo: '74' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'labor:74');
  // المنسوخة لا تُستدعى بالرقم ما لم يُطلب الأرشيف صراحةً
  assert.equal((await lib.getArticle(env, { lawId: 'labor', articleNo: '80' })).length, 0);
  assert.equal((await lib.getArticle(env, { lawId: 'labor', articleNo: '80', includeRepealed: true })).length, 1);
});

await check('٤ · رقم المادة يُطبَّع: «(٧٤)» و«74» شيء واحد', async () => {
  const hits = await lib.getArticle(env, { lawId: 'labor', articleNo: '(٧٤)' });
  assert.equal(hits[0]?.id, 'labor:74');
});

await check('٤ · حصر البحث في نظام وفي نوع', async () => {
  const inLaw = await lib.searchLegal(env, 'الإخطار', { lawId: 'labor', limit: 10 });
  assert.ok(inLaw.length > 0);
  assert.ok(inLaw.every((h) => h.lawId === 'labor' || h.parentLawId === 'labor'));

  const onlyRegulations = await lib.searchLegal(env, 'الإخطار', { docType: 'regulation', limit: 10 });
  assert.ok(onlyRegulations.every((h) => h.docType === 'regulation'));
});

await check('٤ · `parent_law_id`: اللائحة تُجلب مع نظامها، وتُستبعَد عند الطلب', async () => {
  const withRegs = await lib.searchLegal(env, 'مدة الإخطار', { lawId: 'labor', limit: 10 });
  assert.ok(withRegs.some((h) => h.id === 'labor-reg:12'), 'اللائحة لم تُجلب مع نظامها');

  const lawOnly = await lib.searchLegal(env, 'مدة الإخطار', { lawId: 'labor', withRegulations: false, limit: 10 });
  assert.ok(!lawOnly.some((h) => h.id === 'labor-reg:12'));

  const { law, regulations } = await lib.getLawWithRegulations(env, 'labor');
  assert.equal(law.law_id, 'labor');
  assert.deepEqual(regulations.map((r) => r.law_id), ['labor-regulation']);
});

await check('٤ · بيانات الاستشهاد تصل مع النتيجة', async () => {
  const [hit] = await lib.getArticle(env, { lawId: 'labor', articleNo: '74' });
  assert.equal(hit.instrumentNo, 'م/51');
  assert.equal(hit.issueDate, '2005-09-27');
  assert.equal(hit.issueDateHijri, '1426/08/23هـ');
  assert.equal(hit.lawTitle, 'نظام العمل');
});

// ═══ التصفية في طبقة الاسترجاع لا في الواجهة ═══

await check('٤ · مسار المحادثة (`retrieve`) يرث التصفية — لا واجهة بينه وبين القاعدة', async () => {
  const hits = await lib.retrieve(env, ['الفصل دون مكافأة والإجراءات النظامية لإنهاء العقد'], 10);
  assert.ok(hits.length > 0);
  assert.ok(!hits.some((h) => h.documentId === 'labor:old-80'), 'المادة المنسوخة وصلت إلى سياق التوليد');
  const context = lib.formatRagContext(hits);
  assert.ok(!context.includes('نصٌّ منسوخ'), 'نصّ مادة منسوخة تسرّب إلى البرومبت');
  assert.match(context, /نظام العمل — المادة 74 — م\/51 — 2005-09-27 \(1426\/08\/23هـ\)/);
});

await check('٤ · إحصاءات المحتوى تفصل السارية عن المنسوخة', async () => {
  const stats = await lib.legalStats(env);
  assert.equal(stats.chunks, 5);
  assert.equal(stats.repealed, 1);
  assert.equal(stats.effective, 4);
  assert.equal(stats.pending_embeddings, 0);
});

console.log('\nفحص عقد استيراد المحتوى النظامي — NAF-legal\n');
console.log(results.join('\n'));
console.log(
  process.exitCode
    ? '\nالعقد مخروق — راجِع ما فشل أعلاه.\n'
    : `\n${results.length} فحصاً مرّت — العقد سليم.\n`
);
