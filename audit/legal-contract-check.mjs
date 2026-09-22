// فحص عقد استيراد المحتوى النظامي — NAF-legal
//
// يشغّل **كود المنصة الحقيقي** (`src/lib/legal.ts` و`src/lib/rag.ts` كما هما)
// على قاعدة SQLite حقيقية بُنيت من ملف الهجرة نفسه (`migrations/0012`)، مع
// بديلين في الذاكرة للفهرس المتجهي ولنموذج التضمين.
//
// وهذا ما يجعله فحص عقد لا فحص وحدات: لا يُعاد هنا بناء منطق البحث ولا
// التصفية ولا الاستيراد — تُستدعى الدوال نفسها التي يستدعيها الـWorker،
// ويُقاس ما تفعله بالتزامات العقد:
//
//   ١) سطر واحد = مقطع واحد، والتقطيع التلقائي معطَّل
//   ٢) `embed_text` وحده يصير متجهاً، و`text` وحده يُعرض ويُستشهد به
//   ٣) بحث هجين مع تطبيع عربي
//   ٤) التصفية على السريان في طبقة الاسترجاع لا في الواجهة
//   ٥) حجبُ ما ينتظر المراجعة عن الاسترجاع الآلي
//   ٦) تنبيهُ المادة التي لم يُطبَّق تعديلها — في الشاشة وفي البرومبت
//   ٧) ردُّ أخوات الرقم الواحد كلِّها مرتّبةً
//   ٨) سجلُّ التحديث من `amended_on` لا من وقت الاستيراد
//
// وترقيم الفحوص أدناه يتبع هذه الالتزامات، ويقابل فحصَ القبول في مواصفة
// الاستيراد — الإصدار الثاني.
//
// التشغيل:  npm run check:legal

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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

// ── قاعدة بيانات من الهجرات نفسها ──
// كلُّها بترتيبها لا قائمةٌ مكتوبة: قائمةٌ تُحدَّث باليد تُنسى مع أوّل هجرة
// جديدة، فيفشل العقد بخطأ SQL غامض بدل أن يقول ما نقص.
const migrations = (await readdir(path.join(ROOT, 'migrations')))
  .filter((f) => f.endsWith('.sql'))
  .sort();
const sqlite = new DatabaseSync(':memory:');
for (const f of migrations) sqlite.exec(await readFile(path.join(ROOT, 'migrations', f), 'utf8'));

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
//
// **والمقاس مقاسُ الإنتاج لا مقاسٌ يُختار للسرعة.** `lib/embed.ts` يفحص طول
// كل متجه مقابل `EMBED_DIM`، والفهرسان يُنشآن في `deploy.yml` بـ
// `--dimensions=1024`. فبديلٌ بأربعةٍ وستين يجعل الفحص يمرّ على مسارٍ
// يرفضه الإنتاج — وهو أسوأ من ألّا يُفحص: يقول «سليم» عن طريقٍ مسدود.
const DIM = 1024;
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
  // عدُّ الفهرس بصيغة الربط الحاليّ — لفحص «المتجه بلا سجل» (§6-7).
  async describe() {
    return { vectorCount: vectorStore.size, dimensions: DIM };
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

await check('١ · التواريخ تُقرأ كما تُكتب وتُوحَّد، والهجريُّ في حقل الميلادي يُحفظ هجرياً', () => {
  const cases = [
    ['2005-09-27', '2005-09-27'],
    ['2005/9/27', '2005-09-27'],
    ['27/09/2005', '2005-09-27'],
    ['27-09-2005', '2005-09-27'],
    ['2005-09-27T00:00:00Z', '2005-09-27'],
    ['٢٠٠٥-٠٩-٢٧', '2005-09-27'],
  ];
  for (const [given, expected] of cases) {
    const p = lib.parseJsonl(line({ id: `d:${given}`, text: 'ن', embed_text: 'س', date_gregorian: given }));
    assert.deepEqual(p.errors, [], `«${given}» رُفض`);
    assert.equal(p.rows[0].issue_date, expected, `«${given}» لم يُوحَّد`);
  }

  // هجريٌّ في حقلٍ ميلاديّ: قيمةٌ صحيحة أُسيء وضعها — تُحفظ ولا تُرمى،
  // ولا تُكتب ميلادياً فيصير تاريخ الأداة كاذباً.
  const h = lib.parseJsonl(line({ id: 'd:h', text: 'ن', embed_text: 'س', date_gregorian: '1426/08/23' }));
  assert.deepEqual(h.errors, []);
  assert.equal(h.rows[0].issue_date, null);
  assert.equal(h.rows[0].issue_date_hijri, '1426/08/23');

  // وما لا يُقرأ يبقى مرفوضاً برمزه — التساهل ليس قبولَ كل شيء.
  const bad = lib.parseJsonl(line({ id: 'd:x', text: 'ن', embed_text: 'س', date_gregorian: 'الخميس' }));
  assert.equal(bad.rows.length, 0);
  assert.equal(bad.errors[0].code, 'bad_date:issue_date');
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

// ═══ إعادة رفع نظام: مقارنةٌ قبل الكتابة، وأرشفةٌ عند الاعتماد ═══
//
// بمادةٍ تخصّ هذه الفحوص وحدها: مادةٌ يشترك فيها فحصان يجعل أحدهما يُفشل
// الآخر بترتيبٍ لا علاقة له بما يقيسه.

const V1 = {
  id: 'labor:200', law_id: 'labor', article_no: '200', status: 'active', law_title: 'نظام العمل',
  instrument_no: 'م/51', issue_date: '2005-09-27', issue_date_hijri: '1426/08/23هـ',
  text: 'النصّ الأوّل للمادة 200 قبل التعديل.', embed_text: 'نظام العمل — المادة 200 — النصّ الأوّل.',
};
const V2 = { ...V1, article_no: '200 مكرر', text: 'النصّ الثاني للمادة 200 بعد التعديل.',
             embed_text: 'نظام العمل — المادة 200 — النصّ الثاني.' };

await lib.upsertLegalChunks(env, lib.parseJsonl(line(V1)).rows, { importId: 'imp-seed' });

await check('٢ · المقارنة تقول ما سيقع قبل أن يقع، ولا تكتب شيئاً', async () => {
  const incoming = lib.parseJsonl(
    [
      line(V2),                    // تغيّر نصُّها ورقمها
      CORPUS[4],                   // لم يتغيّر فيها شيء
      line({ ...V1, id: 'labor:201', article_no: '201', text: 'مادة مستحدَثة.', embed_text: 'مادة مستحدَثة.' }),
    ].join('\n')
  );
  assert.deepEqual(incoming.errors, []);

  const diff = await lib.diffChunks(env, incoming.rows);
  assert.equal(diff.added, 1, 'الجديدة لم تُعَدّ');
  assert.equal(diff.changed, 1, 'المتغيّرة لم تُعَدّ');
  assert.equal(diff.unchanged, 1, 'التي لم تتغيّر عُدَّت تغييراً');
  assert.deepEqual(diff.changes[0].fields.sort(), ['article_no', 'text']);
  assert.equal(diff.changes[0].old_text, V1.text);
  assert.equal(diff.changes[0].new_text, V2.text);
  // الغائب عن الملف يُحصى ولا يُحذف: ملفٌّ جزئيّ يجعل سائر النظام «غائباً».
  assert.ok(diff.missing > 0, 'الغائب عن الملف لم يُحصَ');
  assert.equal(q('SELECT text FROM legal_chunks WHERE id = ?', V1.id)[0].text, V1.text, 'المقارنة كتبت في القاعدة');
});

await check('٢ · الاعتماد يؤرشف القديم ويعتمد الجديد', async () => {
  const totalBefore = (await lib.listLawChanges(env, 'labor')).total;
  const result = await lib.upsertLegalChunks(env, lib.parseJsonl(line(V2)).rows, { importId: 'imp-1' });
  assert.equal(result.archived, 1, 'لم تُؤرشَف النسخة القديمة');
  assert.equal(result.updated, 1);

  // الجاري هو الجديد
  const now = q('SELECT text, article_no FROM legal_chunks WHERE id = ?', V1.id)[0];
  assert.equal(now.text, V2.text);
  assert.equal(now.article_no, V2.article_no);

  // والقديم محفوظٌ كما كان، ومعه ما تغيّر
  const { changes, total } = await lib.listLawChanges(env, 'labor');
  assert.equal(total, totalBefore + 1, 'السجلّ لم يزد نسخةً واحدة');
  const entry = changes.find((v) => v.chunk_id === V1.id);
  assert.ok(entry, 'النسخة المؤرشفة غير موجودة في السجلّ');
  assert.equal(entry.text, V1.text, 'النصّ القديم لم يُحفظ كما كان');
  assert.equal(entry.article_no, V1.article_no);
  assert.deepEqual(entry.changed_fields.split(',').sort(), ['article_no', 'text']);
  assert.equal(entry.current_text, V2.text, 'السجلّ لا يعرض الجاري بجانب القديم');
});

await check('٢ · إعادة رفعٍ بلا تغيير لا تُنشئ نسخةً في السجلّ', async () => {
  const totalBefore = (await lib.listLawChanges(env, 'labor')).total;
  const result = await lib.upsertLegalChunks(env, lib.parseJsonl(line(V2)).rows, { importId: 'imp-2' });
  assert.equal(result.archived, 0, 'أُرشِفت مادة لم تتغيّر');
  assert.equal((await lib.listLawChanges(env, 'labor')).total, totalBefore, 'السجلّ زاد بلا تغيير');
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

await check('٣ · البحث المباشر لفظيٌّ بحت — لا نداءَ لنموذج التضمين', async () => {
  embeddedTexts.length = 0;
  const hits = await lib.searchLegal(env, 'الاجراءات النظاميه', { limit: 5, lexicalOnly: true });
  assert.equal(embeddedTexts.length, 0, 'نودي نموذج التضمين في بحثٍ لفظيّ');
  assert.ok(hits.some((h) => h.id === 'labor:74'), 'اللفظي وحده لم يجد المادة');
  assert.ok(hits.every((h) => !h.signals.includes('semantic')), 'تسرّبت إشارة دلالية');
  // والتصفية على السريان قائمةٌ فيه كما في غيره.
  assert.ok(!hits.some((h) => h.isRepealed));
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
  const inDb = q('SELECT COUNT(*) AS n FROM legal_chunks')[0].n;
  assert.equal(stats.chunks, inDb);
  assert.equal(stats.repealed, q("SELECT COUNT(*) AS n FROM legal_chunks WHERE is_repealed = 1 OR status = 'repealed'")[0].n);
  assert.equal(stats.effective, stats.chunks - stats.repealed);
  assert.equal(stats.repealed, 1, 'المنسوخة الوحيدة في المجموعة');
});

// ── الإصدار الثاني من المواصفة: التعديل والمراجعة وتكرار الرقم ──
//
// أربع قواعد تُضاف إلى العقد، وكلُّها في **طبقة الاسترجاع** لا في الواجهة:
// حجبُ ما ينتظر المراجعة، وتنبيهُ ما لم يُطبَّق تعديله، وردُّ أخوات الرقم
// الواحد كلِّها، وأخذُ سجلّ التحديث تاريخَه من `amended_on` لا من وقت السحب.

const AMEND = [
  // عُدِّلت وطُبِّق تعديلها، ومعها نصُّها السابق في الملف نفسه.
  line({
    id: 'نظام-العمل/art-233', law_id: 'labor', doc_type: 'law', article_no: 233,
    article_label: 'المادة الثالثة والثلاثون بعد المائتين', law_title: 'نظام العمل',
    text: 'تُنشأ في الوزارة إدارةٌ لتفتيش العمل، ويصدر بتنظيمها قرارٌ من الوزير.',
    text_superseded: 'يتولى تفتيش العمل مفتشون يصدر بتعيينهم قرارٌ من الوزير.',
    has_amendments: true, amendment_applied: true, amendment_kind: 'استبدال',
    amendment_instrument: 'م/44', amended_on: '1446/05/12', amendments_count: 1,
    embed_text: 'نظام العمل — المادة 233 — إدارة تفتيش العمل وتنظيمها بقرار من الوزير.',
  }),
  // عُدِّلت ولم يُطبَّق تعديلها: نصُّها المعروض أصليّ، فتُعرض بتنبيهها.
  line({
    id: 'نظام-العمل/art-120', law_id: 'labor', doc_type: 'law', article_no: 120,
    law_title: 'نظام العمل',
    text: 'للعامل الحقُّ في إجازةٍ سنوية لا تقلّ مدتها عن واحدٍ وعشرين يوماً.',
    has_amendments: true, amendment_applied: false, amendment_kind: 'تعديل جزئي',
    amendment_instrument: 'م/46', amended_on: '1447/01/03', amendments_count: 1,
    amendments_raw: 'تُستبدل عبارة «واحد وعشرين يوماً» بعبارة «ثلاثين يوماً».',
    amend_note: 'إحلال عبارةٍ داخل المادة — الدمج يدويّ.',
    needs_review: false,
    embed_text: 'نظام العمل — المادة 120 — الإجازة السنوية للعامل ومدتها.',
  }),
  // محجوبة حتى تُراجَع: تصنيفٌ آليّ لم يبتّ فيه.
  line({
    id: 'نظام-العمل/art-240', law_id: 'labor', doc_type: 'law', article_no: 240,
    law_title: 'نظام العمل',
    text: 'يُعاقَب بغرامةٍ ماليةٍ كلُّ من خالف أحكام الفصل الخاص بتشغيل الأحداث.',
    has_amendments: true, amendment_applied: false, amendment_kind: 'تعديل جماعي',
    amendments_raw: 'مرسومٌ واحد يعدّل عدة مواد ويعيد صياغتها.',
    amend_note: 'تعديل جماعي — لا يُطبَّق آلياً.', needs_review: true,
    embed_text: 'نظام العمل — المادة 240 — عقوبة مخالفة أحكام تشغيل الأحداث.',
  }),
  // أخوات الرقم الواحد: مادةٌ قائمة وأخرى أُضيفت بمرسومٍ معدِّل تحمل رقمها.
  line({
    id: 'نظام-العمل/art-121', law_id: 'labor', doc_type: 'law', article_no: 121,
    law_title: 'نظام العمل', is_duplicate: true, duplicate_of: 'نظام-العمل/art-121', duplicate_index: 1,
    needs_review: true, amend_note: 'رقمٌ مكرّر في المصدر — راجِع أهي مادة مضافة أم خطأ تقطيع.',
    text: 'تُحسب مدة الإجازة السنوية من تاريخ مباشرة العامل عمله.',
    embed_text: 'نظام العمل — المادة 121 — احتساب مدة الإجازة السنوية.',
  }),
  line({
    id: 'نظام-العمل/art-121--dup2', law_id: 'labor', doc_type: 'law', article_no: 121,
    law_title: 'نظام العمل', is_duplicate: true, duplicate_of: 'نظام-العمل/art-121', duplicate_index: 2,
    needs_review: true, amend_note: 'رقمٌ مكرّر في المصدر — راجِع أهي مادة مضافة أم خطأ تقطيع.',
    text: 'لا يجوز حرمان العامل من إجازته السنوية ولا التنازل عنها بمقابل.',
    embed_text: 'نظام العمل — المادة 121 مكرر — حظر الحرمان من الإجازة السنوية والتنازل عنها.',
  }),
  // مادةٌ طويلة مقسّمة: جزآن من مادةٍ واحدة لا مادتان.
  line({
    id: 'نظام-العمل/art-300#a', law_id: 'labor', doc_type: 'law', article_no: 300, part: 'a', parts_total: 2,
    law_title: 'نظام العمل', text: 'يلتزم صاحب العمل بتوفير وسائل الوقاية الآتية: أولاً وثانياً وثالثاً.',
    effective_from: '1448/01/01هـ',
    embed_text: 'نظام العمل — المادة 300 (جزء أ) — وسائل الوقاية التي يلتزم بها صاحب العمل.',
  }),
  line({
    id: 'نظام-العمل/art-300#b', law_id: 'labor', doc_type: 'law', article_no: 300, part: 'b', parts_total: 2,
    law_title: 'نظام العمل', text: 'رابعاً وخامساً، وتُحدَّد التفاصيل بقرارٍ من الوزير.',
    effective_from: '1448/01/01هـ',
    embed_text: 'نظام العمل — المادة 300 (جزء ب) — تتمّة وسائل الوقاية وتحديد تفاصيلها.',
  }),
];

const amend = lib.parseJsonl(AMEND.join('\n'));

await check('٥ · حقول التعديل تُقرأ كما وردت، وتُعَدّ في التقرير ولا تقع صامتة', () => {
  assert.equal(amend.errors.length, 0, JSON.stringify(amend.errors));
  assert.equal(amend.rows.length, 7);
  assert.equal(amend.needsReview, 3, 'ثلاثٌ محجوبة: المادة 240 وأختا الرقم 121');
  assert.equal(amend.amendmentPending, 2, 'مادتان عُدِّلتا ونصُّهما أصليّ');
  assert.equal(amend.superseded, 1, 'نصٌّ سابق واحد يدخل سجلّ التحديث');
  const pending = amend.rows.find((r) => r.id === 'نظام-العمل/art-120');
  assert.equal(pending.has_amendments, 1);
  assert.equal(pending.amendment_applied, 0, 'الافتراض الآمن: النصّ أصليّ حتى يُقال غير ذلك');
  assert.equal(pending.amendment_instrument, 'م/46');
  assert.equal(pending.amended_on, '1447/01/03');
});

await check('٩ · نفاذٌ مؤجَّل بتاريخ هجري يُحفظ هجرياً ولا يُرفض السطر لأجل علامته', () => {
  const part = amend.rows.find((r) => r.id === 'نظام-العمل/art-300#a');
  assert.equal(part.effective_from, null, 'ليس ميلادياً فلا يُكتب في حقل الميلادي');
  assert.equal(part.effective_from_hijri, '1448/01/01');
});

await check('٩ · سطرٌ بصيغة المواصفة كما هي: `law_name` ونوعٌ عربيّ ورقمٌ عدداً وبنيةُ النظام', async () => {
  const spec = lib.parseJsonl(
    line({
      id: 'نظام-الشركات/art-001', law_id: 'companies', law_name: 'نظام الشركات', doc_type: 'نظام',
      instrument: 'مرسوم ملكي', instrument_no: 'م/132', authority: 'وزارة التجارة',
      date_hijri: '1443/01/18هـ', date_gregorian: '2022-08-26', captured_at: '2026-08-01T09:00:00Z',
      book: 'الباب الأول: أحكام عامة', chapter: 'الفصل الأول', section: 'التمهيد',
      article_no: 1, article_label: 'المادة الأولى', article_title: 'التعريفات',
      text: 'يُقصد بالألفاظ الآتية المعاني المبيَّنة أمامها ما لم يقتضِ السياق غير ذلك.',
      embed_text: 'نظام الشركات — المادة 1 — التعريفات.',
    })
  );
  assert.equal(spec.errors.length, 0, JSON.stringify(spec.errors));
  const r = spec.rows[0];
  assert.equal(r.law_title, 'نظام الشركات', '`law_name` لم يُقرأ اسماً للنظام');
  assert.equal(r.doc_type, 'law', 'النوع العربيّ يُقابَل بالمخزَّن كما تُقابَل الحالة');
  assert.equal(r.article_no, '1', 'الرقم عدداً في الملف يبقى رقماً في القاعدة');
  assert.equal(r.article_no_norm, '1');
  assert.equal(r.issue_date, '2022-08-26');
  assert.equal(r.issue_date_hijri, '1443/01/18هـ');
  assert.equal(r.instrument, 'مرسوم ملكي');
  assert.equal(r.authority, 'وزارة التجارة');
  assert.equal(r.captured_at, '2026-08-01T09:00:00Z');
  assert.equal(r.book, 'الباب الأول: أحكام عامة');
  assert.equal(r.chapter, 'الفصل الأول');
  assert.equal(r.section, 'التمهيد');
  assert.equal(r.article_title, 'التعريفات');
  // ما عُرِف لا يتسرّب إلى `meta_json`: هناك ما زاد عن العقد وحده.
  assert.equal(r.meta_json, null, 'حقلٌ معروف سقط في `meta_json` فلا يُصفّى عليه');

  await lib.upsertLegalChunks(env, spec.rows, { importId: 'imp-spec' });
  const laws = await lib.listLaws(env);
  const companies = laws.find((l) => l.law_id === 'companies');
  assert.equal(companies.instrument, 'مرسوم ملكي', 'أداة الإصدار لا تصل ترويسة النظام');
  assert.equal(companies.authority, 'وزارة التجارة', 'الجهة لا تصل ترويسة النظام');
});

await check('٩ · واستدعاء رقمٍ في نظامٍ لا يردّ مادةً تحمل الرقم نفسه من نظامٍ آخر', async () => {
  // نظام الشركات فيه المادة 1، ونظام العمل فيه مواد بأرقام أخرى. والمصيدة
  // أن يُستدعى رقمٌ موجودٌ في نظامين، فيُردّ أوّل ما يُطابق الرقم أياً كان نظامه.
  const clash = lib.parseJsonl(
    line({
      id: 'نظام-الشركات/art-074', law_id: 'companies', law_name: 'نظام الشركات', doc_type: 'نظام', article_no: 74,
      text: 'تُحلّ الشركة بانقضاء المدة المحدَّدة في عقد تأسيسها.',
      embed_text: 'نظام الشركات — المادة 74 — حلّ الشركة بانقضاء مدتها.',
    })
  );
  await lib.upsertLegalChunks(env, clash.rows, { importId: 'imp-clash' });

  const labor = await lib.getArticle(env, { lawId: 'labor', articleNo: '74' });
  assert.deepEqual(labor.map((h) => h.id), ['labor:74'], 'مادةُ نظامٍ آخر تسرّبت إلى استدعاءٍ محصور');
  const companies = await lib.getArticle(env, { lawId: 'companies', articleNo: '74' });
  assert.deepEqual(companies.map((h) => h.id), ['نظام-الشركات/art-074']);
  const hits = await lib.searchLegal(env, 'المادة 74', { lawId: 'labor', limit: 10 });
  assert.ok(!hits.some((h) => h.lawId === 'companies'), 'حصرُ النظام لم يمنع تسرّب مادةٍ من نظامٍ آخر');
});

await check('٩ · والنفاذ المؤجَّل يُحسب في طبقة الاسترجاع فيبلغ الشاشة والبرومبت معاً', async () => {
  const deferred = lib.parseJsonl(
    [
      line({
        id: 'نظام-العمل/art-401', law_id: 'labor', doc_type: 'law', article_no: 401, law_title: 'نظام العمل',
        effective_from: '1499/01/01هـ',
        text: 'تسري أحكام هذا الفصل على منشآت النقل البحري من تاريخ النفاذ المحدَّد.',
        embed_text: 'نظام العمل — المادة 401 — سريان أحكام الفصل على منشآت النقل البحري.',
      }),
      line({
        id: 'نظام-العمل/art-402', law_id: 'labor', doc_type: 'law', article_no: 402, law_title: 'نظام العمل',
        effective_from: '2020-01-01',
        text: 'تسري أحكام هذا الفصل على منشآت النقل البري من تاريخ النفاذ المحدَّد.',
        embed_text: 'نظام العمل — المادة 402 — سريان أحكام الفصل على منشآت النقل البري.',
      }),
    ].join('\n')
  );
  await lib.upsertLegalChunks(env, deferred.rows, { importId: 'imp-deferred' });
  const [pending] = await lib.getArticle(env, { lawId: 'labor', articleNo: '401' });
  const [inForce] = await lib.getArticle(env, { lawId: 'labor', articleNo: '402' });
  assert.equal(pending.effectivePending, true, 'نصٌّ سابقٌ لأوانه يُعرض كأنه جارٍ');
  assert.equal(inForce.effectivePending, false, 'تاريخٌ حلّ من سنين يُعرض تنبيهاً بلا سبب');
  const context = lib.formatRagContext(await lib.retrieve(env, ['سريان أحكام الفصل على منشآت النقل البحري'], 3));
  assert.ok(context.includes(lib.DEFERRED_NOTICE), 'النفاذ المؤجَّل لم يبلغ البرومبت');
});

const amendWrite = await lib.upsertLegalChunks(env, amend.rows, { importId: 'imp-amend' });
await lib.embedPending(env, 100);

await check('٥ · المادةُ الموسومة بتحذير تدخل البحث بتحذيرها لا تُحجب', async () => {
  // وثيقة الاستيراد تردّ الحجب هنا: مادةٌ عليها تعديل تعذّر دمجه نصُّها قائم،
  // وحجبُها يجعل الباحث يظنّ أن لا نصّ في الموضوع أصلاً — وذاك أسوأ من نصٍّ
  // مصحوب بتحذير. والصمت في المنتج القانوني ليس حياداً.
  const hits = await lib.searchLegal(env, 'عقوبة مخالفة أحكام تشغيل الأحداث', { limit: 10 });
  const hit = hits.find((h) => h.id === 'نظام-العمل/art-240');
  assert.ok(hit, 'مادةٌ نصُّها قائم حُجبت لأنها تنتظر دمج تعديل');
  assert.equal(hit.retrievalStatus, lib.RETRIEVAL_WARNING, 'دخلت بلا وسم حالها');
  const rag = await lib.retrieve(env, ['عقوبة مخالفة أحكام تشغيل الأحداث'], 10);
  const ctx = lib.formatRagContext(rag);
  assert.ok(rag.some((r) => r.documentId === 'نظام-العمل/art-240'), 'لم تصل المحادثة');
  assert.ok(ctx.includes(lib.AMENDMENT_NOTICE), 'وصلت المحادثة بلا تحذيرها — وهو أسوأ من غيابها');
});

await check('٥ · والمعطوبة تُحجب حتى يبتّ فيها إنسان — العطب غير التحذير', async () => {
  // والحجّة أعلاه لا تصدق هنا: رقمٌ مكرّر لم يُبتّ فيه، أو نصٌّ تسرّبت إليه
  // ديباجة الأداة، أو مشبوهُ الاقتطاع — عرضُه ليس كسراً للصمت بل عرضُ ما لا
  // يُقرأ. وهذا هو الفرق الذي يقوم عليه `has_defect`.
  const dup = q('SELECT has_defect, defect_kind FROM legal_chunks WHERE id = ?', 'نظام-العمل/art-121--dup2')[0];
  assert.equal(dup.has_defect, 1, 'الرقم المكرّر لم يُحسب عطباً');
  assert.equal(dup.defect_kind, 'رقم مكرّر');
  const warn = q('SELECT has_defect FROM legal_chunks WHERE id = ?', 'نظام-العمل/art-240')[0];
  assert.equal(warn.has_defect, 0, 'التحذير حُسب عطباً فحُجبت مادةٌ سليمة');

  const hits = await lib.searchLegal(env, 'تحسب مدة الإجازة السنوية من تاريخ مباشرة العامل', { limit: 10 });
  assert.ok(!hits.some((h) => h.id === 'نظام-العمل/art-121--dup2'), 'معطوبةٌ وصلت نتائج البحث');
});

await check('٥ · وفتحُ الأرشيف لا يفتح المعطوب — شرطان مستقلّان لا واحد', async () => {
  const hits = await lib.searchLegal(env, 'تحسب مدة الإجازة السنوية من تاريخ مباشرة العامل', {
    limit: 10, includeRepealed: true,
  });
  assert.ok(!hits.some((h) => h.id === 'نظام-العمل/art-121--dup2'), '`include_repealed` رفع الحجب عن المعطوب');
});

await check('٥ · وتُرى في طابور المراجعة وفي تصفّح النظام بشارتها', async () => {
  const queue = await lib.listReviewQueue(env, { lawId: 'labor', limit: 50 });
  assert.equal(queue.total, 3);
  assert.ok(queue.articles.some((a) => a.id === 'نظام-العمل/art-240'));
  assert.ok(queue.articles.every((a) => a.needsReview));
  const browse = await lib.listLawArticles(env, 'labor', { limit: 200 });
  const shown = browse.articles.find((a) => a.id === 'نظام-العمل/art-240');
  assert.ok(shown, 'المحجوبة غابت عن التصفّح فقفز ترقيم المواد بلا تفسير');
  assert.equal(shown.needsReview, true);
});

await check('٥ · الاعتماد يفتح المعطوب للاسترجاع، والتراجع يعيده إلى الحجب', async () => {
  const query = 'تحسب مدة الإجازة السنوية من تاريخ مباشرة العامل';
  assert.equal((await lib.reviewChunk(env, 'نظام-العمل/art-121--dup2', 'approve', 'مراجع')).ok, true);
  const after = await lib.searchLegal(env, query, { limit: 10 });
  assert.ok(after.some((h) => h.id === 'نظام-العمل/art-121--dup2'), 'الاعتماد لم يرفع الحجب');
  await lib.reviewChunk(env, 'نظام-العمل/art-121--dup2', 'undo', 'مراجع');
  const back = await lib.searchLegal(env, query, { limit: 10 });
  assert.ok(!back.some((h) => h.id === 'نظام-العمل/art-121--dup2'), 'التراجع لم يُعِد الحجب');
  assert.equal((await lib.reviewChunk(env, 'مادةٌ لا وجود لها', 'approve', 'مراجع')).ok, false);
});

await check('٥ · واعتمادُ نصٍّ لم يعد هو النصّ ليس اعتماداً: إعادةُ رفعه تُسقطه', async () => {
  await lib.reviewChunk(env, 'نظام-العمل/art-240', 'approve', 'مراجع');
  const changed = lib.parseJsonl(
    line({
      id: 'نظام-العمل/art-240', law_id: 'labor', doc_type: 'law', article_no: 240,
      law_title: 'نظام العمل',
      text: 'يُعاقَب بغرامةٍ ماليةٍ مضاعفةٍ كلُّ من خالف أحكام الفصل الخاص بتشغيل الأحداث.',
      has_amendments: true, amendment_applied: false, needs_review: true,
      embed_text: 'نظام العمل — المادة 240 — عقوبة مخالفة أحكام تشغيل الأحداث.',
    })
  );
  await lib.upsertLegalChunks(env, changed.rows, { importId: 'imp-again' });
  const row = q('SELECT reviewed_at, reviewed_by, review_status FROM legal_chunks WHERE id = ?', 'نظام-العمل/art-240')[0];
  assert.equal(row.reviewed_at, null, 'الاعتماد بقي على نصٍّ تغيّر');
  assert.equal(row.reviewed_by, null);
  assert.equal(row.review_status, 'pending', 'المادة لم تعد إلى الطابور بعد تغيّر نصّها');
});

await check('٦ · التنبيه الإلزامي يرافق النتيجة ويبلغ البرومبت لا الشاشة وحدها', async () => {
  const hits = await lib.searchLegal(env, 'الإجازة السنوية للعامل ومدتها', { limit: 10 });
  const hit = hits.find((h) => h.id === 'نظام-العمل/art-120');
  assert.ok(hit, 'المادة المعدَّلة غير المطبَّق تعديلها لا تُحجب — تُعرض بتنبيهها');
  assert.equal(hit.hasAmendments, true);
  assert.equal(hit.amendmentApplied, false);
  assert.equal(hit.amendmentInstrument, 'م/46');
  const rag = await lib.retrieve(env, ['الإجازة السنوية للعامل ومدتها'], 10);
  const context = lib.formatRagContext(rag);
  assert.ok(context.includes(lib.AMENDMENT_NOTICE), 'نصٌّ أصليّ وصل البرومبت بلا تنبيهه');
  assert.ok(context.includes('م/46'), 'التنبيه بلا أداته لا يدلّ على موضع الصواب');
});

await check('٦ · ولا تنبيه على مادةٍ طُبِّق تعديلها — نصُّها هو النافذ', async () => {
  const rag = await lib.retrieve(env, ['إدارة تفتيش العمل وتنظيمها بقرار من الوزير'], 5);
  const context = lib.formatRagContext(rag);
  assert.ok(context.includes('تفتيش العمل'));
  assert.ok(!context.includes(lib.AMENDMENT_NOTICE), 'تنبيهٌ على نصٍّ نافذ يُفقد التنبيه معناه');
});

await check('٧ · استدعاء رقمٍ مكرّر يردّ كل سجلاته مرتّبةً لا الأول وحده', async () => {
  await lib.reviewChunk(env, 'نظام-العمل/art-121', 'approve', 'مراجع');
  await lib.reviewChunk(env, 'نظام-العمل/art-121--dup2', 'approve', 'مراجع');
  const hits = await lib.getArticle(env, { lawId: 'labor', articleNo: '121' });
  assert.equal(hits.length, 2, 'المادة المضافة بمرسومٍ معدِّل اختفت من النتائج');
  assert.deepEqual(hits.map((h) => h.id), ['نظام-العمل/art-121', 'نظام-العمل/art-121--dup2']);
  assert.deepEqual(hits.map((h) => h.duplicateIndex), [1, 2]);
});

await check('٧ · ولاحقة `--dup` سجلٌّ مستقلّ لا نسخةٌ معدَّلة', () => {
  const rows = q("SELECT id, text FROM legal_chunks WHERE duplicate_of = 'نظام-العمل/art-121' ORDER BY duplicate_index");
  assert.equal(rows.length, 2, 'الاستبدال ابتلع إحدى المادتين');
  assert.notEqual(rows[0].text, rows[1].text);
  assert.equal(q("SELECT COUNT(*) AS n FROM legal_chunk_versions WHERE chunk_id LIKE 'نظام-العمل/art-121%'")[0].n, 0,
    'مادةٌ مستقلّة أُرشِفت كأنها نصٌّ أُزيح');
});

await check('٧ · والمحجوب لا يدخل مع أخواته: الضمّ يمرّ بالتصفية نفسها', async () => {
  await lib.reviewChunk(env, 'نظام-العمل/art-121--dup2', 'undo', 'مراجع');
  const hits = await lib.getArticle(env, { lawId: 'labor', articleNo: '121' });
  assert.deepEqual(hits.map((h) => h.id), ['نظام-العمل/art-121']);
  await lib.reviewChunk(env, 'نظام-العمل/art-121--dup2', 'approve', 'مراجع');
});

await check('٨ · سجلّ التحديث يأخذ تاريخه من `amended_on` وينسب التغيير إلى أداته', async () => {
  assert.equal(amendWrite.superseded, 1);
  const { changes } = await lib.listLawChanges(env, 'labor', { limit: 50 });
  const seeded = changes.find((v) => v.chunk_id === 'نظام-العمل/art-233');
  assert.ok(seeded, 'النصّ السابق الوارد في الملف لم يدخل سجلّ التحديث');
  assert.equal(seeded.amended_on, '1446/05/12', 'السجلّ يقول إن التعديل وقع يوم استوردناه');
  assert.equal(seeded.amendment_instrument, 'م/44');
  assert.equal(seeded.change_kind, 'amendment');
  assert.equal(seeded.origin, 'superseded');
  assert.match(seeded.text, /مفتشون/);
  assert.match(seeded.current_text, /إدارةٌ لتفتيش العمل/);
});

await check('٨ · ومادةٌ ذات `text_superseded` لا تولّد سجلاً ثانياً في المواد', () => {
  assert.equal(q("SELECT COUNT(*) AS n FROM legal_chunks WHERE id LIKE 'نظام-العمل/art-233%'")[0].n, 1);
});

await check('٨ · وإعادة رفع الملف نفسه لا تكرّر النسخة في السجلّ', async () => {
  const before = q("SELECT COUNT(*) AS n FROM legal_chunk_versions WHERE chunk_id = 'نظام-العمل/art-233'")[0].n;
  await lib.upsertLegalChunks(env, lib.parseJsonl(AMEND[0]).rows, { importId: 'imp-repeat' });
  const after = q("SELECT COUNT(*) AS n FROM legal_chunk_versions WHERE chunk_id = 'نظام-العمل/art-233'")[0].n;
  assert.equal(after, before, 'إعادة الرفع ضاعفت النصّ السابق في السجلّ');
});

await check('٨ · والنصّ المُزاح لا يُكتب مرّتين حين يعود في `text_superseded`', async () => {
  // الحال الشائعة: الملف الجديد يحمل نصَّ المادة الجاري اليوم في
  // `text_superseded` ونصّاً نافذاً في `text`. فالمُزاح والسابق شيء واحد،
  // وكتابته مرّتين تجعل سجلّ التحديث يقول إن المادة عُدِّلت مرّتين.
  const first = lib.parseJsonl(
    line({
      id: 'نظام-العمل/art-500', law_id: 'labor', doc_type: 'law', article_no: 500, law_title: 'نظام العمل',
      text: 'مدة الاختبار لا تزيد على تسعين يوماً.',
      embed_text: 'نظام العمل — المادة 500 — مدة الاختبار.',
    })
  );
  await lib.upsertLegalChunks(env, first.rows, { importId: 'imp-500-a' });

  const second = lib.parseJsonl(
    line({
      id: 'نظام-العمل/art-500', law_id: 'labor', doc_type: 'law', article_no: 500, law_title: 'نظام العمل',
      text: 'مدة الاختبار لا تزيد على مائة وثمانين يوماً.',
      text_superseded: 'مدة الاختبار لا تزيد على تسعين يوماً.',
      has_amendments: true, amendment_applied: true, amendment_instrument: 'م/46', amended_on: '1447/02/10',
      embed_text: 'نظام العمل — المادة 500 — مدة الاختبار.',
    })
  );
  await lib.upsertLegalChunks(env, second.rows, { importId: 'imp-500-b' });

  const rows = q("SELECT origin, amended_on FROM legal_chunk_versions WHERE chunk_id = 'نظام-العمل/art-500'");
  assert.equal(rows.length, 1, 'النصّ الواحد دخل السجلّ مرّتين: مرّةً لأنه أُزيح ومرّةً لأنه ورد سابقاً');
  assert.equal(rows[0].origin, 'displaced');
  assert.equal(rows[0].amended_on, '1447/02/10');
});

await check('٨ · ووسم «تصحيح بيانات» يميّز خطأ السحب عن التعديل النظامي', async () => {
  const fixed = lib.parseJsonl(
    line({
      id: 'نظام-العمل/art-120', law_id: 'labor', doc_type: 'law', article_no: 120,
      law_title: 'نظام العمل',
      text: 'للعامل الحقُّ في إجازةٍ سنوية لا تقلّ مدتها عن واحدٍ وعشرين يوماً، تُمنح قبل استحقاقها.',
      has_amendments: true, amendment_applied: false, amendment_instrument: 'م/46', amended_on: '1447/01/03',
      embed_text: 'نظام العمل — المادة 120 — الإجازة السنوية للعامل ومدتها.',
    })
  );
  await lib.upsertLegalChunks(env, fixed.rows, { importId: 'imp-fix', correction: true });
  const row = q(
    "SELECT change_kind, origin, amended_on FROM legal_chunk_versions WHERE chunk_id = 'نظام-العمل/art-120' ORDER BY rowid DESC"
  )[0];
  assert.equal(row.change_kind, 'correction', 'تصحيحُ سحبٍ ظهر في السجلّ تعديلاً نظامياً');
  assert.equal(row.origin, 'displaced');
  assert.equal(row.amended_on, '1447/01/03', 'تاريخ التعديل يبقى تاريخه ولو كان الفرق تصحيحاً');
});

await check('٩ · أجزاء المادة المقسّمة تبقى مقاطع متتابعة بترتيب الملف', async () => {
  const { articles } = await lib.listLawArticles(env, 'labor', { limit: 200 });
  const parts = articles.filter((a) => a.id.startsWith('نظام-العمل/art-300'));
  assert.deepEqual(parts.map((a) => a.part), ['a', 'b'], 'الأجزاء تفرّقت أو انقلب ترتيبها');
  assert.ok(parts.every((a) => a.partsTotal === 2));
  const at = articles.findIndex((a) => a.id === 'نظام-العمل/art-300#a');
  assert.equal(articles[at + 1].id, 'نظام-العمل/art-300#b', 'جزءٌ فصل بينه وبين تتمّته مادةٌ أخرى');
});

await check('٩ · وبنية النظام وعنوان المادة يصلان النتيجة ويُفهرسان لفظياً', async () => {
  const hits = await lib.searchLegal(env, 'المادة الثالثة والثلاثون بعد المائتين', { limit: 5, lexicalOnly: true });
  assert.ok(hits.some((h) => h.id === 'نظام-العمل/art-233'), 'لفظُ رقم المادة لا يجدها');
  const hit = hits.find((h) => h.id === 'نظام-العمل/art-233');
  assert.equal(hit.articleLabel, 'المادة الثالثة والثلاثون بعد المائتين');
  assert.equal(hit.amendmentApplied, true);
});

await check('٩ · والإحصاءات تفصل المحجوب عمّا يُعرض بتنبيه', async () => {
  const stats = await lib.legalStats(env);
  assert.equal(
    stats.needs_review,
    q('SELECT COUNT(*) AS n FROM legal_chunks WHERE needs_review = 1 AND reviewed_at IS NULL')[0].n
  );
  assert.equal(
    stats.amendment_pending,
    q('SELECT COUNT(*) AS n FROM legal_chunks WHERE has_amendments = 1 AND amendment_applied = 0')[0].n
  );
});

await check('٩ · ونافذة التعديلات تُقرأ بطلبٍ صريح ولا تظهر في نتيجة بحث', async () => {
  // تُعاد المادة إلى صورتها في الملف ثم تُعتمد: الفحص السابق أعاد رفعها بنصٍّ
  // آخر بلا نافذة تعديل، فأسقط النافذة والاعتماد معاً — وهو الصواب.
  await lib.upsertLegalChunks(env, lib.parseJsonl(AMEND[2]).rows, { importId: 'imp-restore' });
  await lib.reviewChunk(env, 'نظام-العمل/art-240', 'approve', 'مراجع');
  const amendment = await lib.getChunkAmendment(env, 'نظام-العمل/art-240');
  assert.match(amendment.amendments_raw, /مرسومٌ واحد يعدّل عدة مواد/);
  assert.match(amendment.amend_note, /تعديل جماعي/);
  const hits = await lib.searchLegal(env, 'عقوبة مخالفة أحكام تشغيل الأحداث', { limit: 10 });
  const hit = hits.find((h) => h.id === 'نظام-العمل/art-240');
  assert.ok(hit, 'المادة اعتُمدت فينبغي أن تظهر');
  assert.equal('amendments_raw' in hit, false, 'النصّ الخام تسرّب إلى نتيجة البحث');
  assert.equal('text_superseded' in hit, false, 'النصّ المنسوخ تسرّب إلى نتيجة البحث');
});

// ── وحدة مراجعة المواد ──
//
// مواصفةٌ مستقلّة تُبنى فوق الاستيراد بلا تعديل عليه. ومبدؤها الحاكم الفصل
// التام: المراجعة لا توقف شيئاً — الجاهز يعمل والطابور ينتظر.

const REVIEW = [
  // ملغاة وموسومة للمراجعة معاً: **لا تدخل الطابور**. الإلغاء قرارٌ نظاميّ
  // لا اجتهادٌ يُراجَع، وإغراقُ المراجع بالملغاة يُخفي تحتها ما يستحقّ نظره.
  line({
    id: 'مراجعة/ملغاة', law_id: 'review', law_name: 'نظام المراجعة', doc_type: 'نظام', article_no: 1,
    is_repealed: true, needs_review: true, amendment_kind: 'إلغاء',
    text: 'نصٌّ ملغى بمرسومٍ لاحق ولا يُستشهد به.',
    embed_text: 'نظام المراجعة — المادة 1 — نصّ ملغى.',
  }),
  // جاهزة: تدخل الاسترجاع فور الاستيراد ولا تنتظر أحداً.
  line({
    id: 'مراجعة/جاهزة', law_id: 'review', law_name: 'نظام المراجعة', doc_type: 'نظام', article_no: 2,
    text: 'تسري أحكام هذا النظام على جميع منشآت القطاع الخاص.',
    embed_text: 'نظام المراجعة — المادة 2 — نطاق سريان النظام على منشآت القطاع الخاص.',
  }),
  // مشبوهة الاقتطاع: نصُّها أقصر من نصف سابقه.
  line({
    id: 'مراجعة/مقتطعة', law_id: 'review', law_name: 'نظام المراجعة', doc_type: 'نظام', article_no: 3,
    needs_review: true, amendment_kind: 'استبدال', captured_at: '2026-08-01T09:00:00Z',
    text: 'يلتزم صاحب العمل.',
    text_superseded: 'يلتزم صاحب العمل بتوفير بيئة عملٍ آمنة، وبتدريب العاملين على وسائل الوقاية، وبتوفير أدواتها كاملةً على نفقته، وبمتابعة تطبيقها متابعةً دورية.',
    embed_text: 'نظام المراجعة — المادة 3 — التزامات صاحب العمل.',
  }),
  // تسرّب ديباجة المرسوم إلى متن المادة.
  line({
    id: 'مراجعة/ديباجة', law_id: 'review', law_name: 'نظام المراجعة', doc_type: 'نظام', article_no: 4,
    needs_review: true, amendment_kind: 'غير مصنَّف', captured_at: '2026-08-01T09:00:00Z',
    text: 'بموجب المرسوم الملكي رقم م/44 تُعدَّل المادة الرابعة لتكون بالنص الآتي: يُحدَّد أجر العامل بعقدٍ مكتوب.',
    embed_text: 'نظام المراجعة — المادة 4 — تحديد أجر العامل بعقد مكتوب.',
  }),
  // تعديل جماعي — بالشدّة كما يكتبها المصدر.
  line({
    id: 'مراجعة/جماعي', law_id: 'review', law_name: 'نظام المراجعة', doc_type: 'نظام', article_no: 5,
    needs_review: true, amendment_kind: 'تعديل جماعي', has_amendments: true, amendment_applied: false,
    text: 'تُطبَّق العقوبات المنصوص عليها في الجدول المرفق.',
    embed_text: 'نظام المراجعة — المادة 5 — العقوبات والجدول المرفق.',
  }),
  // أختا رقمٍ واحد: الحكم عليهما لا يصحّ إلا مجتمعتين.
  line({
    id: 'مراجعة/art-9', law_id: 'review', law_name: 'نظام المراجعة', doc_type: 'نظام', article_no: 9,
    needs_review: true, is_duplicate: true, duplicate_of: 'مراجعة/art-9', duplicate_index: 1,
    text: 'تُحسب مدة الخدمة من تاريخ المباشرة.',
    embed_text: 'نظام المراجعة — المادة 9 — احتساب مدة الخدمة.',
  }),
  line({
    id: 'مراجعة/art-9--dup2', law_id: 'review', law_name: 'نظام المراجعة', doc_type: 'نظام', article_no: 9,
    needs_review: true, is_duplicate: true, duplicate_of: 'مراجعة/art-9', duplicate_index: 2,
    text: 'لا تُحتسب مدة الانقطاع ضمن مدة الخدمة.',
    embed_text: 'نظام المراجعة — المادة 9 مكرر — استثناء مدة الانقطاع.',
  }),
];

const review = lib.parseJsonl(REVIEW.join('\n'));
await lib.upsertLegalChunks(env, review.rows, { importId: 'imp-review' });
await lib.embedPending(env, 100);

await check('١٠ · الفصل التام: الجاهزة تعمل فوراً والطابور ممتلئ', async () => {
  const hits = await lib.searchLegal(env, 'نطاق سريان النظام على منشآت القطاع الخاص', { limit: 10 });
  assert.ok(hits.some((h) => h.id === 'مراجعة/جاهزة'), 'مادةٌ جاهزة انتظرت فراغ المراجع');
  const { total } = await lib.listReviewQueue(env, { lawId: 'review', limit: 50 });
  assert.ok(total > 0, 'الطابور فارغ فلا معنى للفحص');
});

await check('١٠ · والملغاة لا تدخل الطابور ولا الاسترجاع', async () => {
  const { articles } = await lib.listReviewQueue(env, { lawId: 'review', limit: 50 });
  assert.ok(!articles.some((a) => a.id === 'مراجعة/ملغاة'), 'ملغاةٌ أُدخلت الطابور فأغرقت المراجع');
  const hits = await lib.searchLegal(env, 'نصّ ملغى', { limit: 10 });
  assert.ok(!hits.some((h) => h.id === 'مراجعة/ملغاة'));
});

await check('١١ · الطوابير تُعرَّف بشروطها على الحقول، وعدّاداتها استعلامٌ حيّ', async () => {
  const counts = await lib.reviewQueueCounts(env, { lawId: 'review' });
  const by = Object.fromEntries(counts.map((c) => [c.key, c]));
  assert.equal(by.truncated.pending, 1, 'شرط الاقتطاع: أقصر من نصف سابقه');
  assert.equal(by.preamble.pending, 1, 'شرط الديباجة: «بموجب المرسوم» أو «لتكون بالنص»');
  assert.equal(by.collective.pending, 1, '«تعديل جماعي» لم يُطابَق');
  assert.equal(by.unclassified.pending, 1, '«غير مصنَّف» بالشدّة لم يُطابَق مطبَّعاً');
  assert.equal(by.duplicate.pending, 2, 'أختا الرقم الواحد كلتاهما في الطابور');
  // كلُّها تخصّ نظام المراجعة وحده — الترشيح يعمل.
  assert.equal(by.truncated.done, 0);
});

await check('١١ · والعدّاد يتغيّر بالقرار لا يبقى على رقمه الأول', async () => {
  const before = (await lib.reviewQueueCounts(env, { lawId: 'review' })).find((c) => c.key === 'collective');
  await lib.reviewChunk(env, 'مراجعة/جماعي', 'defer', 'مراجع');
  const after = (await lib.reviewQueueCounts(env, { lawId: 'review' })).find((c) => c.key === 'collective');
  assert.equal(after.pending, before.pending - 1, 'المؤجَّلة بقيت في الطابور');
  assert.equal(after.done, before.done + 1, 'المنجز لم يزد');
  // والتأجيل لا يحجب ما ليس بمعطوب: «تعديل جماعي» مادةٌ نصُّها قائم، وتأجيلُ
  // البتّ فيها قرارُ ترتيبِ عملٍ لا حكمٌ على نصّها. والمعطوبة تبقى محجوبة
  // مؤجَّلةً كانت أو منتظرة — هذا ما يفحصه البند ٥ أعلاه.
  const hits = await lib.searchLegal(env, 'العقوبات والجدول المرفق', { limit: 10 });
  assert.ok(hits.some((h) => h.id === 'مراجعة/جماعي'), 'مادةٌ سليمة حُجبت بتأجيل البتّ فيها');
  const defect = q('SELECT has_defect FROM legal_chunks WHERE id = ?', 'مراجعة/جماعي')[0];
  assert.equal(defect.has_defect, 0, 'حُسبت معطوبة فبطل الفحص');
});

await check('١٢ · الاعتماد يُدخل المادة الاسترجاع في الحال', async () => {
  const before = await lib.searchLegal(env, 'تحديد أجر العامل بعقد مكتوب', { limit: 10 });
  assert.ok(!before.some((h) => h.id === 'مراجعة/ديباجة'));
  const res = await lib.reviewChunk(env, 'مراجعة/ديباجة', 'approve', 'مراجع');
  assert.equal(res.status, 'approved');
  const after = await lib.searchLegal(env, 'تحديد أجر العامل بعقد مكتوب', { limit: 10 });
  assert.ok(after.some((h) => h.id === 'مراجعة/ديباجة'), 'الاعتماد لم يُدخلها الاسترجاع');
});

await check('١٣ · التحرير يعيد بناء نصّ التضمين ومتجهه، والبحث يطابق الجديد لا القديم', async () => {
  const NEW = 'يُحدَّد أجر العامل بعقدٍ مكتوب، ويُسلَّم بالتحويل البنكي في موعدٍ ثابت.';
  const res = await lib.reviewChunk(env, 'مراجعة/ديباجة', 'edit', 'مراجع', { text: NEW });
  assert.equal(res.status, 'edited');
  assert.equal(res.reembedded, true, 'التحرير لم يُعِد المقطع إلى طابور التضمين');

  const row = q("SELECT text, embed_text, text_original_import, embedded_at FROM legal_chunks WHERE id = 'مراجعة/ديباجة'")[0];
  assert.equal(row.text, NEW);
  assert.match(row.text_original_import, /بموجب المرسوم/, 'أصلُ الاستيراد لم يُحفظ قبل التحرير');
  assert.match(row.embed_text, /نظام المراجعة/, 'نصّ التضمين لم يُبنَ باسم النظام');
  assert.match(row.embed_text, new RegExp('المادة 4'), 'نصّ التضمين بلا رقم المادة');
  assert.ok(row.embed_text.endsWith(NEW), 'نصّ التضمين لا ينتهي بالنصّ المحرَّر');
  assert.equal(row.embedded_at, null, 'المقطع لم يُعَد إلى طابور التضمين');

  await lib.embedPending(env, 50);
  // اللفظيّ: يجد الجديد ولا يجد القديم — محفّز الفهرس عمل مع الكتابة.
  const fresh = await lib.searchLegal(env, 'التحويل البنكي في موعد ثابت', { limit: 10, lexicalOnly: true });
  assert.ok(fresh.some((h) => h.id === 'مراجعة/ديباجة'), 'البحث لا يجد النصّ المحرَّر');
  const stale = await lib.searchLegal(env, 'بموجب المرسوم الملكي', { limit: 10, lexicalOnly: true });
  assert.ok(!stale.some((h) => h.id === 'مراجعة/ديباجة'), 'البحث ما زال يطابق النصّ القديم');
});

await check('١٣ · والتحرير الثاني لا يمحو أصلَ الاستيراد', async () => {
  await lib.reviewChunk(env, 'مراجعة/ديباجة', 'edit', 'مراجع', { text: 'صياغةٌ ثالثة للمادة الرابعة.' });
  const row = q("SELECT text_original_import FROM legal_chunks WHERE id = 'مراجعة/ديباجة'")[0];
  assert.match(row.text_original_import, /بموجب المرسوم/, 'صار «الأصل» آخرَ ما حُرِّر لا ما جاء من المصدر');
});

await check('١٤ · التراجع يُرجع نصّ الاستيراد ويعيد المادة إلى الطابور', async () => {
  const res = await lib.reviewChunk(env, 'مراجعة/ديباجة', 'undo', 'مراجع');
  assert.equal(res.status, 'pending');
  const row = q("SELECT text, text_original_import, review_status FROM legal_chunks WHERE id = 'مراجعة/ديباجة'")[0];
  assert.match(row.text, /بموجب المرسوم/, 'التراجع لم يُرجع النصّ الأصلي');
  assert.equal(row.text_original_import, null);
  assert.equal(row.review_status, 'pending');
  const hits = await lib.searchLegal(env, 'التحويل البنكي في موعد ثابت', { limit: 10, lexicalOnly: true });
  assert.ok(!hits.some((h) => h.id === 'مراجعة/ديباجة'), 'النصّ المحرَّر بقي في الفهرس بعد التراجع');
});

await check('١٥ · كل تغيير مقيَّد في سجلّ التدقيق بصاحبه ووقته وقيمتَيه', async () => {
  const entries = await lib.listReviewAudit(env, { chunkId: 'مراجعة/ديباجة', limit: 50 });
  assert.ok(entries.length >= 4, 'السجلّ لا يحفظ كل قرار');
  assert.ok(entries.every((e) => e.actor_id === 'مراجع' && e.at > 0));
  const statuses = entries.filter((e) => e.field === 'review_status').map((e) => e.new_value);
  assert.deepEqual(statuses, ['pending', 'edited', 'edited', 'approved'], 'تسلسل القرارات غير محفوظ');
  const texts = entries.filter((e) => e.field === 'text');
  assert.ok(texts.length >= 2 && texts.every((e) => e.old_value && e.new_value), 'تغيّر النصّ بلا قيمتيه');
});

await check('١٦ · الاستبعاد يبقيها محجوبة، والملاحظة تُحفظ بلا تغيير الحال', async () => {
  await lib.reviewChunk(env, 'مراجعة/مقتطعة', 'exclude', 'مراجع', { note: 'اقتطاعٌ في السحب — يُعاد سحبها.' });
  const row = q("SELECT review_status, review_note FROM legal_chunks WHERE id = 'مراجعة/مقتطعة'")[0];
  assert.equal(row.review_status, 'rejected');
  assert.match(row.review_note, /اقتطاع/);
  const hits = await lib.searchLegal(env, 'التزامات صاحب العمل', { limit: 10 });
  assert.ok(!hits.some((h) => h.id === 'مراجعة/مقتطعة'), 'المستبعدة دخلت الاسترجاع');

  await lib.reviewChunk(env, 'مراجعة/مقتطعة', 'note', 'مراجع', { note: 'روجعت مع المصدر.' });
  const after = q("SELECT review_status, review_note FROM legal_chunks WHERE id = 'مراجعة/مقتطعة'")[0];
  assert.equal(after.review_status, 'rejected', 'الملاحظة غيّرت الحال');
  assert.match(after.review_note, /روجعت/);
});

await check('١٧ · لوحة الحال تقرأ الاسترجاع بشرطَيه لا بجمعٍ يدويّ', async () => {
  const d = await lib.reviewDashboard(env);
  const inDb = q('SELECT COUNT(*) AS n FROM legal_chunks')[0].n;
  assert.equal(d.chunks, inDb);
  assert.equal(
    d.retrievable,
    q(`SELECT COUNT(*) AS n FROM legal_chunks c
        WHERE c.retrieval_status <> 'repealed' AND c.is_repealed = 0 AND c.status IN ('active','amended')
        AND (c.has_defect = 0 OR c.review_status IN ('approved','edited'))`)[0].n
  );
  assert.equal(d.in_queue, q(`SELECT COUNT(*) AS n FROM legal_chunks c
      WHERE c.needs_review = 1 AND c.review_status = 'pending' AND c.is_repealed = 0 AND c.status <> 'repealed'`)[0].n);
  assert.ok(d.rejected >= 1 && d.deferred >= 1);
  assert.ok(d.last_activity > 0, 'اللوحة لا تعرف آخر نشاط');
  assert.equal(d.queues.length, 7, 'الطوابير سبعة');
});

await check('١٨ · الترشيح بنظامٍ واحد أو بدفعة استيرادٍ واحدة', async () => {
  const byLaw = await lib.listReviewQueue(env, { lawId: 'review', limit: 50 });
  assert.ok(byLaw.articles.every((a) => a.lawId === 'review'));
  const byBatch = await lib.listReviewQueue(env, { capturedAt: '2026-08-01T09:00:00Z', limit: 50 });
  assert.ok(byBatch.total >= 1, 'الترشيح بدفعة الاستيراد لا يجد شيئاً');
  assert.ok(byBatch.articles.every((a) => a.lawId === 'review'));
  const batches = await lib.listCaptureBatches(env);
  assert.ok(batches.some((b) => b.captured_at === '2026-08-01T09:00:00Z'));
});

await check('١٨ · واستيراد نظامٍ جديد تدخل مواده الطوابير تلقائياً', async () => {
  const before = (await lib.reviewQueueCounts(env)).find((c) => c.key === 'unclassified').pending;
  const fresh = lib.parseJsonl(
    line({
      id: 'نظام-جديد/art-001', law_id: 'brand-new', law_name: 'نظامٌ استُورد للتوّ', doc_type: 'نظام',
      article_no: 1, needs_review: true, amendment_kind: 'غير مصنَّف',
      text: 'مادةٌ من نظامٍ لم يكن في القاعدة قبل لحظة.',
      embed_text: 'نظامٌ استُورد للتوّ — المادة 1.',
    })
  );
  await lib.upsertLegalChunks(env, fresh.rows, { importId: 'imp-new' });
  const after = (await lib.reviewQueueCounts(env)).find((c) => c.key === 'unclassified').pending;
  assert.equal(after, before + 1, 'مواد نظامٍ جديد لم تدخل الطابور بلا تعديلٍ في الشاشة');
});

await check('١٩ · الاعتماد لا يحذف نافذة التعديلات ولا النصّ السابق — هما أثرُ القرار', async () => {
  const before = q("SELECT amendments_raw, text_superseded FROM legal_chunks WHERE id = 'مراجعة/جماعي'")[0];
  await lib.reviewChunk(env, 'مراجعة/جماعي', 'approve', 'مراجع');
  await lib.reviewChunk(env, 'مراجعة/جماعي', 'edit', 'مراجع', { text: 'صياغةٌ يعتمدها المراجع.' });
  const after = q("SELECT amendments_raw, text_superseded FROM legal_chunks WHERE id = 'مراجعة/جماعي'")[0];
  assert.equal(after.amendments_raw, before.amendments_raw, 'نافذة التعديلات ضاعت بعد الاعتماد');
  assert.equal(after.text_superseded, before.text_superseded, 'النصّ السابق ضاع بعد التحرير');
});

await check('١٩ · الاعتماد جملةً بمعرّفاتٍ محدَّدة وبسقف، ولا يقبل «كل الطابور»', async () => {
  // المواصفة تمنع «الاعتماد الجماعي بلا قراءة»، وقرارُ المالك أجازه على
  // محدَّدٍ يراه المراجع. فالحدُّ الفاصل أن يأتي بمعرّفاته لا بشرطٍ يُطابقها،
  // وأن يقف عند سقفٍ يقابل ما تراه الشاشة.
  const before = await lib.reviewQueueCounts(env, { lawId: 'review' });
  const { articles } = await lib.listReviewQueue(env, { lawId: 'review', limit: 50 });
  const ids = articles.slice(0, 2).map((a) => a.id);
  assert.equal(ids.length, 2, 'الطابور لا يحمل مادتين للفحص');

  const res = await lib.reviewChunks(env, ids, 'approve', 'مراجع');
  assert.equal(res.done, 2);
  assert.equal(res.failed.length, 0);
  const after = await lib.reviewQueueCounts(env, { lawId: 'review' });
  const pending = (cs) => cs.reduce((n, c) => n + c.pending, 0);
  assert.ok(pending(after) < pending(before), 'الاعتماد جملةً لم يُخرجها من الطابور');

  // معرّفٌ لا وجود له يُردّ وحده ولا يُسقط الباقي.
  const mixed = await lib.reviewChunks(env, ['مراجعة/art-9', 'لا-وجود-له'], 'defer', 'مراجع');
  assert.equal(mixed.done, 1);
  assert.deepEqual(mixed.failed.map((f) => f.id), ['لا-وجود-له']);

  // السقف يقف عند خمسين، وما زاد يُردّ بمعرّفه لا يُقصّ صامتاً: قصٌّ خفيّ
  // يجعل المراجع يرى «تمّ» وقد بقي ما حدَّده بلا قرارٍ ولا خبر.
  assert.equal(lib.BULK_LIMIT, 50);
  const many = await lib.reviewChunks(env, Array.from({ length: 80 }, (_, i) => `وهم-${i}`), 'approve', 'مراجع');
  assert.equal(many.done, 0, 'اعتُمد ما لا وجود له');
  assert.equal(many.failed.length, 80, 'معرّفاتٌ سقطت من الردّ بلا ذكر');
  const overflow = many.failed.filter((f) => /تجاوز سقف النداء الواحد/.test(f.error));
  assert.equal(overflow.length, 80 - lib.BULK_LIMIT, 'الزائد على السقف لم يُردّ بسببه');
  assert.deepEqual(
    overflow.map((f) => f.id),
    Array.from({ length: 80 - lib.BULK_LIMIT }, (_, i) => `وهم-${i + lib.BULK_LIMIT}`),
    'الزائد المردود ليس هو الزائد المرسل'
  );
  // والسقف الذي يعرفه المتصفّح هو سقف الخادم: اختلافُهما يجعل الشاشة تقسّم
  // على عددٍ لا يقبله المسار، فيعود نصفُ كل دفعةٍ مردوداً.
  const webApi = readFileSync(path.join(ROOT, 'web', 'src', 'lib', 'api.ts'), 'utf8');
  const declared = webApi.match(/REVIEW_BULK_LIMIT\s*=\s*(\d+)/);
  assert.ok(declared, 'الشاشة لا تعرف سقف النداء');
  assert.equal(Number(declared[1]), lib.BULK_LIMIT, 'سقف الشاشة خالف سقف الخادم');
});

await check('١٩ · وتحديد الطابور كلِّه يأتي بمعرّفاته لا بشرطٍ يُطابقها', async () => {
  // «تحديد الكل» تحدّد صفحةً، وهذه تتجاوزها إلى ما لم يُعرض. والفرق الذي
  // يجعلها مقبولة أنها تُحصي أوّلاً: العدد الذي يراه المراجع قبل التأكيد هو
  // العدد الذي يقع عليه القرار، وكلُّ معرّف يعود صريحاً فيبقى قيدُه وحده.
  const all = await lib.listReviewQueueIds(env, {});
  const { total } = await lib.listReviewQueue(env, { limit: 1 });
  assert.equal(all.ids.length, all.total, 'العدد المعلن غير العدد المسلَّم');
  assert.equal(all.total, total, 'إحصاء التحديد الشامل خالف إحصاء الطابور');
  assert.equal(all.truncated, 0);
  assert.equal(new Set(all.ids).size, all.ids.length, 'معرّفٌ مكرّر في التحديد');

  // وما يجلبه هو ما ينتظر: لا معتمَدةً ولا ملغاةً ولا خارج الطابور.
  const stray = all.ids.filter((id) => {
    const row = q('SELECT needs_review, review_status, is_repealed FROM legal_chunks WHERE id = ?', id)[0];
    return !row || row.needs_review !== 1 || row.review_status !== 'pending' || row.is_repealed !== 0;
  });
  assert.deepEqual(stray, [], 'التحديد الشامل طال ما ليس في الطابور');

  // والمرشّح يضيّقه كما يضيّق الصفحة: تحديدٌ يشمل طابوراً غير المعروض خيانةٌ
  // للعدد المكتوب على الزرّ.
  const dup = await lib.listReviewQueueIds(env, { queue: 'duplicate', lawId: 'review' });
  const page = await lib.listReviewQueue(env, { queue: 'duplicate', lawId: 'review', limit: 500 });
  assert.equal(dup.total, page.total, 'الشامل المرشَّح خالف الطابور المرشَّح');
  assert.ok(dup.total < all.total, 'المرشّح لم يضيّق شيئاً');

  // والشامل داخلٌ فيما يُعرض لا يتجاوزه.
  const pageIds = new Set(page.articles.map((a) => a.id));
  assert.ok(dup.ids.every((id) => pageIds.has(id)), 'الشامل جاء بما لا يُعرض');

  // وما عُرض ولم يدخل التحديد أختُ رقمٍ بُتَّ فيها: تُعرض بجانب أختها ليُحكم
  // عليهما معاً، ولا تُعتمد ثانيةً بتحديدٍ شامل — قرارٌ وقع لا يقع مرّتين.
  const context = page.articles.filter((a) => !dup.ids.includes(a.id));
  const missed = context.filter(
    (a) => q('SELECT review_status FROM legal_chunks WHERE id = ?', a.id)[0]?.review_status === 'pending'
  );
  assert.deepEqual(missed.map((a) => a.id), [], 'الشامل أسقط مادةً منتظرة في الطابور');
  assert.ok(context.length > 0, 'لا أختَ رقمٍ مبتوتاً فيها لفحص هذا الفرق');

  // وسقف الجلب يُعلَن حين يُبلَغ لا يُقصّ صامتاً.
  assert.equal(lib.QUEUE_IDS_MAX, 5000);
  const source = readFileSync(path.join(ROOT, 'src', 'lib', 'legal.ts'), 'utf8');
  assert.match(source, /truncated:\s*Math\.max\(0,\s*\(total\?\.n \?\? 0\) - ids\.length\)/);
});

await check('١٩ · ومسارُ المعرّفات قراءةٌ للمسؤول لا كتابةٌ بشرط', () => {
  const routes = readFileSync(path.join(ROOT, 'src', 'routes', 'legal.ts'), 'utf8');
  assert.match(routes, /app\.get\('\/review\/ids', requireAdmin/, 'مسار المعرّفات ليس قراءةً للمسؤول');
  // ولا يقبل مسارُ القرار شرطاً: `ids` وحدها، فلا «اعتمد كل ما يطابق».
  const body = routes.slice(routes.indexOf("app.post('/review-selected'"));
  assert.ok(!/\bqueue\b/.test(body.slice(0, 900)), 'مسار القرار يقبل شرطاً بدل المعرّفات');
});

await check('١٩ · وقيدُ الاعتماد جملةً يُميَّز في السجلّ عن قرارٍ فُتحت له المادة', async () => {
  const entries = await lib.listReviewAudit(env, { limit: 200 });
  const bulk = entries.filter((e) => e.via === 'bulk');
  const single = entries.filter((e) => e.via === 'single');
  assert.ok(bulk.length > 0, 'لا أثر للاعتماد جملةً في السجلّ');
  assert.ok(single.length > 0, 'ضاع تمييزُ القرار المفرد');
  // وثالثُها `import`: قرارٌ أسقطته دفعةٌ غيّرت النصّ (§6-6) — تغييرٌ في حال
  // المراجعة لم يقع بيد مراجع، وكلُّ تغييرٍ يُقيَّد بكيفيّته.
  assert.ok(entries.every((e) => ['bulk', 'single', 'import'].includes(e.via)), 'قيدٌ بلا وسمٍ لكيفيّته');
});

await check('١٩ · ولا اعتماد بمرور الوقت: لا مهمّة خلفية تمسّ حال المراجعة', () => {
  const cron = readFileSync(path.join(ROOT, 'src', 'cron.ts'), 'utf8');
  assert.ok(!/review_status/.test(cron), 'الـCron يمسّ حال المراجعة');
  // ومسارا الكتابة اثنان لا ثالث لهما: مادةٌ بعينها، ومحدَّدٌ بمعرّفاته.
  const routes = readFileSync(path.join(ROOT, 'src', 'routes', 'legal.ts'), 'utf8');
  const writers = [...routes.matchAll(/app\.post\('(\/review[^']*)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(writers, ['/review-selected', '/review/:id'], 'ظهر مسارُ كتابةٍ ثالث في المراجعة');
  // والتحرير خارج الجملة: نصٌّ يُحرَّر يُحرَّر مادةً مادة.
  assert.match(routes, /\['approve', 'exclude', 'defer', 'note', 'undo'\]\.includes\(action\)/);
});

await check('١٩ · أخوات الرقم تُعرض مجتمعة في الطابور لا فرادى', async () => {
  const { articles } = await lib.listReviewQueue(env, { queue: 'duplicate', lawId: 'review', limit: 50 });
  const group = articles.filter((a) => a.duplicateOf === 'مراجعة/art-9');
  assert.equal(group.length, 2, 'الحكم على أخوات الرقم لا يصحّ إلا مجتمعة');
  assert.deepEqual(group.map((a) => a.duplicateIndex), [1, 2]);
});

// ═══ الإصدار الثالث من المواصفة: حالُ الاسترجاع والخطّ الزمني وسجلّ التعديلات ═══

const V3_LINES = [
  line({
    id: 'ثالثة/art-22', law_id: 'third', law_name: 'نظام الثالثة', doc_type: 'نظام',
    book: 'الباب الثالث: التوظيف', chapter: 'الفصل الأول',
    article_no: 22, article_label: 'المادة الثانية والعشرون',
    text: 'توفر الوزارة قنوات للتوظيف دون مقابل، تقوم بما يأتي.',
    embed_text: 'نظام الثالثة — المادة 22 — قنوات التوظيف.',
    retrieval_status: 'نافذ', has_amendments: true, amendment_applied: true, amendments_count: 1,
    is_repealed: false, needs_review: false,
    text_versions: [
      { seq: 0, text: 'تنشئ الوزارة وحدات للتوظيف دون مقابل، تقوم بما يأتي.',
        label: 'النص الأصلي كما صدر', from_instrument: null, from_date: null, current: false },
      { seq: 1, text: 'توفر الوزارة قنوات للتوظيف دون مقابل، تقوم بما يأتي.',
        label: 'بعد استبدال الصدر — م/44 (8/2/1446هـ)', from_instrument: 'م/44',
        from_date: '8/2/1446', current: true },
    ],
    amendment_events: [
      { seq: 0, scope: 'صدر', op: 'استبدال', targets: [], instrument: 'مرسوم ملكي', instrument_no: 'م/44',
        date_hijri: '8/2/1446', new_text: 'توفر الوزارة قنوات للتوظيف دون مقابل، تقوم بما يأتي.',
        applied: true, result: 'استبدال صدر المادة', reason: null, raw: 'يُستبدل بصدر المادة النصّ الآتي…' },
    ],
  }),
  line({
    id: 'ثالثة/art-74', law_id: 'third', law_name: 'نظام الثالثة', doc_type: 'نظام',
    article_no: 74, article_label: 'المادة الرابعة والسبعون',
    text: 'ينتهي عقد العمل بانقضاء مدته المتفق عليها بين الطرفين.',
    embed_text: 'نظام الثالثة — المادة 74 — انقضاء مدة العقد.',
    retrieval_status: 'نافذ_بتحذير', has_amendments: true, amendment_applied: false,
    is_repealed: false, needs_review: true, amend_note: 'البوابة لا تنشر نصّ التعديل.',
    amendment_events: [
      { seq: 0, scope: 'فقرة', op: 'استبدال', targets: ['ب'], instrument_no: 'م/46', date_hijri: '3/1/1447',
        applied: false, result: 'تخطٍّ', reason: 'البوابة لا تنشر نصّ التعديل، فلا نصّ يُدمج.',
        raw: 'تُعدَّل الفقرة (ب).' },
    ],
  }),
  line({
    id: 'ثالثة/art-233', law_id: 'third', law_name: 'نظام الثالثة', doc_type: 'نظام',
    article_no: 233, article_label: 'المادة الثالثة والثلاثون بعد المائتين',
    text: 'نصُّ مادةٍ ألغاها المرسوم اللاحق فخرجت من النظام.',
    embed_text: 'نظام الثالثة — المادة 233 — ملغاة.',
    retrieval_status: 'ملغى', is_repealed: true, has_amendments: true, amendment_applied: true,
    needs_review: false,
  }),
  line({
    id: 'لائحة-ثالثة/art-12', law_id: 'third-reg', parent_law_id: 'third',
    law_name: 'اللائحة التنفيذية لنظام الثالثة', doc_type: 'لائحة',
    article_no: 12, article_label: 'المادة الثانية عشرة',
    text: 'تُحسب مدة الإخطار وفق ما ورد في هذه اللائحة.',
    embed_text: 'اللائحة التنفيذية — المادة 12 — احتساب مدة الإخطار.',
    retrieval_status: 'نافذ', is_repealed: false, has_amendments: false, needs_review: false,
  }),
];
const v3 = lib.parseJsonl(V3_LINES.join('\n'));

await check('٢٠ · حالُ الاسترجاع يُقرأ من الملف بألفاظه الثلاثة ويُخزَّن مقابلَها', () => {
  assert.equal(v3.errors.length, 0, JSON.stringify(v3.errors));
  const by = Object.fromEntries(v3.rows.map((r) => [r.id, r]));
  assert.equal(by['ثالثة/art-22'].retrieval_status, lib.RETRIEVAL_EFFECTIVE);
  assert.equal(by['ثالثة/art-74'].retrieval_status, lib.RETRIEVAL_WARNING);
  assert.equal(by['ثالثة/art-233'].retrieval_status, lib.RETRIEVAL_REPEALED);
  // ونصُّ التحذير جاهزٌ للعرض ولو لم يحمله الملف — من الألفاظ المسجَّلة لا مُنشأً هنا.
  assert.equal(by['ثالثة/art-74'].retrieval_warning, lib.AMENDMENT_NOTICE);
  assert.equal(by['ثالثة/art-22'].retrieval_warning, null, 'تحذيرٌ على مادةٍ نافذة');
});

await check('٢٠ · وحالٌ غائبة تُشتقّ من الحقول المنطقية لا تُترك فارغة', () => {
  const noStatus = lib.parseJsonl(
    line({ id: 'ثالثة/art-5', law_id: 'third', text: 'نصٌّ عليه تعديل لم يُدمج.',
      embed_text: 'نظام الثالثة — المادة 5.', has_amendments: true, amendment_applied: false })
  );
  assert.equal(noStatus.rows[0].retrieval_status, lib.RETRIEVAL_WARNING, 'الغياب تُرك بلا اشتقاق');
  const repealed = lib.parseJsonl(
    line({ id: 'ثالثة/art-6', law_id: 'third', text: 'نصّ', embed_text: 'نصّ', is_repealed: true })
  );
  assert.equal(repealed.rows[0].retrieval_status, lib.RETRIEVAL_REPEALED);
  // وقولُ الحقلين القديمين «منسوخ» يغلب حالاً تقول «نافذ» — الاتجاه الآمن.
  const conflict = lib.parseJsonl(
    line({ id: 'ثالثة/art-7', law_id: 'third', text: 'نصّ', embed_text: 'نصّ',
      is_repealed: true, retrieval_status: 'نافذ' })
  );
  assert.equal(conflict.rows[0].retrieval_status, lib.RETRIEVAL_REPEALED, 'تناقضٌ حُسم في الاتجاه الخطر');
});

await check('٢٠ · والخطّ الزمني بقيده: نسخةٌ معتمدة واحدة نصُّها هو النصّ المعروض', () => {
  const by = Object.fromEntries(v3.rows.map((r) => [r.id, r]));
  const versions = JSON.parse(by['ثالثة/art-22'].text_versions);
  assert.equal(versions.length, 2);
  assert.equal(versions.filter((v) => v.current).length, 1);
  assert.equal(versions.find((v) => v.current).text, by['ثالثة/art-22'].text, 'المعتمدة تخالف `text`');
  // ومن لا تعديل له تُبنى له نسخةٌ واحدة، فلا تخلو مادةٌ من خطٍّ زمنيّ.
  const plain = JSON.parse(by['لائحة-ثالثة/art-12'].text_versions);
  assert.equal(plain.length, 1);
  assert.equal(plain[0].current, true);

  // والخرق يُرفض بسببه: خطٌّ زمنيّ يكذّب البطاقة أسوأ من غياب النافذة أصلاً.
  const lying = lib.parseJsonl(
    line({ id: 'ثالثة/art-8', law_id: 'third', text: 'نصٌّ معروض', embed_text: 'نصّ',
      text_versions: [{ seq: 0, text: 'نصٌّ آخر', current: true }] })
  );
  assert.equal(lying.rows.length, 0);
  assert.match(lying.errors[0].error, /تخالف/);
  const twoCurrent = lib.parseJsonl(
    line({ id: 'ثالثة/art-9', law_id: 'third', text: 'نصّ', embed_text: 'نصّ',
      text_versions: [{ seq: 0, text: 'نصّ', current: true }, { seq: 1, text: 'نصّ', current: true }] })
  );
  assert.equal(twoCurrent.rows.length, 0);
  assert.match(twoCurrent.errors[0].error, /معتمدة/);
});

await check('٢٠ · وسجلّ التعديلات يُحفظ مفكَّكاً بما تُخطّي وسببه', () => {
  const by = Object.fromEntries(v3.rows.map((r) => [r.id, r]));
  const events = JSON.parse(by['ثالثة/art-74'].amendment_events);
  assert.equal(events.length, 1);
  assert.equal(events[0].applied, false);
  assert.match(events[0].reason, /لا تنشر/, 'سببُ التخطّي ضاع — وهو ما يحتاجه المراجع');
  assert.deepEqual(events[0].targets, ['ب']);
  assert.equal(by['لائحة-ثالثة/art-12'].amendment_events, null, 'مصفوفةٌ فارغة تُخزَّن بلا داعٍ');
});

await check('٢٠ · ونوعُ الأداة يُقابَل كما تُقابَل الحالة، و«تنظيم» رابعةٌ لا تُردّ إلى «لائحة»', () => {
  const by = Object.fromEntries(v3.rows.map((r) => [r.id, r]));
  assert.equal(by['ثالثة/art-22'].doc_type, 'law');
  assert.equal(by['لائحة-ثالثة/art-12'].doc_type, 'regulation');
  assert.equal(lib.canonicalDocType('تنظيم'), 'arrangement');
  assert.equal(lib.canonicalDocType('لائحة'), 'regulation');
  assert.equal(lib.canonicalDocType('law'), 'law', 'القيمة المخزَّنة تمرّ كما هي');
  assert.equal(lib.canonicalDocType('شيء آخر'), null);
  assert.equal(lib.DOC_TYPES.arrangement, 'تنظيم', 'ولكلٍّ لفظُه العربي للعرض');
});

const v3Write = await lib.upsertLegalChunks(env, v3.rows, { importId: 'imp-v3', batchId: 'batch-v3' });

await check('٢٠ · الموسومة بتحذير تدخل البحث ومعها تحذيرُها، والملغاة لا تدخله', async () => {
  assert.equal(v3Write.inserted, 4);
  const hits = await lib.searchLegal(env, 'بانقضاء مدته المتفق عليها بين الطرفين', { limit: 10 });
  const warned = hits.find((h) => h.id === 'ثالثة/art-74');
  assert.ok(warned, 'مادةٌ نصُّها قائم حُجبت لأنها تنتظر دمج تعديل');
  assert.equal(warned.retrievalStatus, lib.RETRIEVAL_WARNING);
  assert.equal(warned.retrievalWarning, lib.AMENDMENT_NOTICE, 'دخلت بلا تحذيرها');
  const repealed = await lib.searchLegal(env, 'نصُّ مادةٍ ألغاها المرسوم اللاحق', { limit: 10 });
  assert.ok(!repealed.some((h) => h.id === 'ثالثة/art-233'), 'ملغاةٌ دخلت البحث');
});

await check('٢٠ · والترشيح بالباب وبالنوع العربي يصيبان', async () => {
  const inBook = await lib.searchLegal(env, 'قنوات للتوظيف', { limit: 10, book: 'الباب الثالث: التوظيف' });
  assert.ok(inBook.some((h) => h.id === 'ثالثة/art-22'));
  const elsewhere = await lib.searchLegal(env, 'قنوات للتوظيف', { limit: 10, book: 'بابٌ لا وجود له' });
  assert.equal(elsewhere.length, 0);
  // اللفظ العربي في المرشِّح يصيب المخزَّن الإنجليزي: لغةُ المرشِّح ليست لغة العمود.
  const byArabic = await lib.searchLegal(env, 'مدة الإخطار', { limit: 10, docType: 'لائحة' });
  assert.ok(byArabic.some((h) => h.id === 'لائحة-ثالثة/art-12'));
});

await check('٢٠ · حذف اليتيم يقع على دفعةٍ تامّة، ولا يُقاس إلا على أنظمتها', async () => {
  assert.deepEqual(await lib.listBatchOrphans(env, 'batch-v3'), [], 'دفعةٌ تامّة لا يتيم فيها');

  // دفعةٌ ثانية تحمل «الثالثة» ناقصةً مادةً، ولا تحمل اللائحة أصلاً.
  const second = lib.parseJsonl(
    [
      line({ id: 'ثالثة/art-22', law_id: 'third', law_name: 'نظام الثالثة', doc_type: 'نظام',
        article_no: 22, text: 'توفر الوزارة قنوات للتوظيف دون مقابل، تقوم بما يأتي.',
        embed_text: 'نظام الثالثة — المادة 22 — قنوات التوظيف.', retrieval_status: 'نافذ' }),
      line({ id: 'ثالثة/art-74', law_id: 'third', law_name: 'نظام الثالثة', doc_type: 'نظام',
        article_no: 74, text: 'ينتهي عقد العمل بانقضاء مدته المتفق عليها بين الطرفين.',
        embed_text: 'نظام الثالثة — المادة 74 — انقضاء مدة العقد.', retrieval_status: 'نافذ_بتحذير',
        has_amendments: true, amendment_applied: false, needs_review: true }),
    ].join('\n')
  );
  assert.equal(second.errors.length, 0, JSON.stringify(second.errors));
  await lib.upsertLegalChunks(env, second.rows, { importId: 'imp-v3b', batchId: 'batch-v3b' });

  const orphans = await lib.listBatchOrphans(env, 'batch-v3b');
  assert.deepEqual(orphans.map((o) => o.id), ['ثالثة/art-233'], 'اليتيم ليس ما غاب عن الدفعة وحده');
  assert.ok(
    !orphans.some((o) => o.law_id === 'third-reg'),
    'نظامٌ لم تحمله الدفعة قيس عليه — ورفعُ نظامٍ واحد يمحو ما عداه'
  );

  const deleted = await lib.deleteOrphans(env, orphans.map((o) => o.id), { importId: 'imp-v3b' });
  assert.equal(deleted, 1);
  assert.equal(q("SELECT COUNT(*) AS n FROM legal_chunks WHERE id = 'ثالثة/art-233'")[0].n, 0);
  // ونصُّه محفوظٌ قبل ذهابه: من استشهد به أمسِ يجد أثره اليوم.
  const kept = q("SELECT text, origin FROM legal_chunk_versions WHERE chunk_id = 'ثالثة/art-233'");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].origin, 'deleted');
  assert.match(kept[0].text, /ألغاها المرسوم/);
});

await check('٢٠ · والملغاة لا تُفهرَس أصلاً — لا تُفهرَس ثم تُصفّى', async () => {
  const pending = q(
    `SELECT id FROM legal_chunks WHERE embedded_at IS NULL AND retrieval_status <> 'repealed' AND is_repealed = 0`
  ).map((r) => r.id);
  const repealedPending = q(
    `SELECT id FROM legal_chunks WHERE embedded_at IS NULL AND (retrieval_status = 'repealed' OR is_repealed = 1)`
  ).map((r) => r.id);
  assert.ok(repealedPending.length > 0, 'لا مادة ملغاة في القاعدة لفحص هذا');
  assert.ok(
    repealedPending.every((id) => !pending.includes(id)),
    'ملغاةٌ في طابور التضمين — تُنفق حصّة التضمين على ما لا يُسترجَع'
  );
  const src = readFileSync(path.join(ROOT, 'src', 'lib', 'legal.ts'), 'utf8');
  assert.match(src, /purgeRepealedVectors/, 'لا تنظيف لمتجهات ما انقلب إلى ملغى');
  assert.match(src, /EMBEDDABLE_SQL/, 'شرط التضمين غير مصرَّح به');
});

await check('٢٠ · التصعيد لمن فتح المادة وحده — والاعتماد جملةً لا يُسقط تحذيراً', async () => {
  // الوثيقة تجعل زرّ الاعتماد يُصعّد `نافذ_بتحذير` إلى `نافذ`، وقرارُ المالك
  // بعدها أن يقع ذلك للقرار المفرد وحده: إسقاط تحذيرٍ عن نصٍّ لم يُقرأ دعوى
  // بتحقّقٍ لم يقع، وضغطةٌ على «تحديد الطابور كلَّه» كانت تمحو مئتين.
  const before = q("SELECT retrieval_status FROM legal_chunks WHERE id = 'ثالثة/art-74'")[0];
  assert.equal(before.retrieval_status, lib.RETRIEVAL_WARNING);

  await lib.reviewChunks(env, ['ثالثة/art-74'], 'approve', 'مراجع');
  const afterBulk = q("SELECT retrieval_status, review_status FROM legal_chunks WHERE id = 'ثالثة/art-74'")[0];
  assert.equal(afterBulk.review_status, 'approved', 'الاعتماد جملةً لم يُخرجها من الطابور');
  assert.equal(afterBulk.retrieval_status, lib.RETRIEVAL_WARNING, 'اعتمادٌ جملةً أسقط تحذيراً بلا قراءة');

  await lib.reviewChunk(env, 'ثالثة/art-74', 'undo', 'مراجع');
  await lib.reviewChunk(env, 'ثالثة/art-74', 'approve', 'مراجع');
  const afterSingle = q("SELECT retrieval_status, retrieval_warning FROM legal_chunks WHERE id = 'ثالثة/art-74'")[0];
  assert.equal(afterSingle.retrieval_status, lib.RETRIEVAL_EFFECTIVE, 'القرار المفرد لم يُصعّد');
  assert.equal(afterSingle.retrieval_warning, null, 'التحذير بقي بعد التصعيد');

  // ولا يبقى في نتيجة البحث تحذيرٌ سقط.
  const hit = (await lib.searchLegal(env, 'بانقضاء مدته المتفق عليها بين الطرفين', { limit: 10 }))
    .find((h) => h.id === 'ثالثة/art-74');
  assert.equal(hit?.retrievalStatus, lib.RETRIEVAL_EFFECTIVE);
  assert.equal(hit?.retrievalWarning, null);
});

await check('٢٠ · والتراجع يُعيد التحذير كما يُعيد الحال — لا يترك دعوى نفاذٍ بلا اعتماد', async () => {
  await lib.reviewChunk(env, 'ثالثة/art-74', 'undo', 'مراجع');
  const row = q("SELECT retrieval_status, retrieval_warning, review_status FROM legal_chunks WHERE id = 'ثالثة/art-74'")[0];
  assert.equal(row.review_status, 'pending');
  assert.equal(row.retrieval_status, lib.RETRIEVAL_WARNING, 'بقيت «نافذ» بعد التراجع عن اعتمادها');
  assert.equal(row.retrieval_warning, lib.AMENDMENT_NOTICE, 'عادت بلا نصّ تحذيرها');
  // وقيدُ التصعيد وردُّه كلاهما في سجلّ التدقيق: من سأل لاحقاً لمَ سقط
  // التحذير يجد الإجابة.
  const entries = await lib.listReviewAudit(env, { chunkId: 'ثالثة/art-74', limit: 50 });
  const moves = entries.filter((e) => e.field === 'retrieval_status');
  assert.ok(moves.length >= 2, 'تغيّر الحال لم يُقيَّد');
});

await check('٢١ · صحّة القاعدة عدٌّ حيّ: توزيعُ الحال ومقياسا المتجه', async () => {
  // رقمٌ مكتوب في وثيقة يتقادم مع أوّل دفعة فيُقارَن به ويُظَنّ الاستيراد
  // ناقصاً. وهذا يُقرأ من القاعدة في كل فتحة، ويُقابَل ببيان `verify-legal`.
  const st = await lib.legalStats(env);
  assert.equal(st.chunks, q('SELECT COUNT(*) AS n FROM legal_chunks')[0].n, 'العدّ ليس حيّاً');
  assert.equal(
    st.retrieval.effective + st.retrieval.warning + st.retrieval.repealed,
    st.chunks,
    'توزيع حال الاسترجاع لا يجمع إلى الإجمالي'
  );
  assert.equal(st.indexed, st.chunks - st.retrieval.repealed, '«ما يُفهرَس» لا يطابق ما ليس ملغىً');
  // ومقياسُ المتجه اليتيم يبقى صفراً ما دام التنظيف يعمل — وارتفاعُه إنذار.
  assert.equal(typeof st.stale_vector, 'number');
  assert.equal(typeof st.missing_vector, 'number');
  const cron = readFileSync(path.join(ROOT, 'src', 'cron.ts'), 'utf8');
  assert.match(cron, /stale_vector/, 'الدورة الليلية لا تُحصي المتجه اليتيم');
  assert.match(cron, /missing_vector/, 'ولا ما ينقصه متجه');
});

await check('٢١ · والعدد المعروض هو ما يصرّفه الزرّ — لا عددٌ لا يُنقصه شيء', async () => {
  /* «ينتظر التضمين» في شريط قاعدة المعرفة يقابله زرُّ «تضمين الآن». فإن عدّ
     الشريط ما لا يختاره الزرّ ظهر عددٌ لا يتحرّك: يُضغط الزرّ فيدور ثم يقف،
     ويُعاد الضغط، ويُظنّ التضمين معطَّلاً — والطابور فارغ من أوّله.

     وهو ما وقع: الشريط كان يعدّ `embedded_at IS NULL` وحده، والمادةُ الملغاة
     لا تُضمَّن بالتصميم — `EMBEDDABLE_SQL` يستثنيها و`purgeRepealedVectors`
     يحذف متجهها. فكل ملغاةٍ غيرِ مضمَّنة تجلس في العدد إلى الأبد. */
  const st = await lib.legalStats(env);
  const drainable = q(
    `SELECT COUNT(*) AS n FROM legal_chunks
     WHERE embedded_at IS NULL AND retrieval_status <> 'repealed' AND is_repealed = 0`
  )[0].n;
  assert.equal(st.pending_embeddings, drainable, 'الشريط يعدّ ما لا يصرّفه الزرّ');

  // وشرطُ الوثائق المرفوعة كشرط تصريفها: `pending` لا معها `processing`.
  const kb = readFileSync(path.join(ROOT, 'src', 'routes', 'kb.ts'), 'utf8');
  const listed = kb.slice(kb.indexOf("app.get('/documents'"), kb.indexOf("app.post('/documents/embed-pending'"));
  assert.ok(
    !/ingest_status IN \('pending', 'processing'\)/.test(listed),
    'عدُّ الوثائق المنتظرة يشمل `processing` ولا يصرّفها الزرّ'
  );

  /* وهذا الفحص لا يجوز أن يصير فارغاً.
     الشرطان يتساويان تلقائياً في قاعدةٍ لا ملغاةَ فيها بلا متجه، فيمرّ الفحص
     على علّةٍ قائمة. فيُشترط أن تكون في البيانات واحدةٌ على الأقل — وإلا كان
     الحارس حراسةَ بابٍ لا أحد يمرّ به. */
  const repealedUnembedded = q(
    `SELECT COUNT(*) AS n FROM legal_chunks
     WHERE embedded_at IS NULL AND (retrieval_status = 'repealed' OR is_repealed = 1)`
  )[0].n;
  assert.ok(repealedUnembedded > 0, 'لا ملغاةَ بلا متجه في البيانات — الفحص أعلاه لا يفحص شيئاً');
});

await check('٢١ · وسجلّ الدفعات يقول أثرها وبصمتَها', () => {
  const routes = readFileSync(path.join(ROOT, 'src', 'routes', 'legal.ts'), 'utf8');
  const q0 = routes.slice(routes.indexOf("app.get('/imports'"), routes.indexOf("app.get('/imports'") + 700);
  for (const col of ['inserted', 'updated', 'failed', 'deleted', 'file_sha256', 'batch_id']) {
    assert.ok(q0.includes(col), `سجلّ الدفعات بلا \`${col}\``);
  }
});

await check('٢١ · والاستشهاد يحمل نسخة النصّ لا رقم المادة وحده', async () => {
  // «المادة الخامسة» تصف موضعاً، و«بصيغتها بعد أ/256» تصف أيَّ نصٍّ فيه.
  // ومادةٌ عُدِّلت ثلاثاً لها ثلاثة نصوص، والرقم وحده يصدق على أيّها.
  await lib.upsertLegalChunks(env, lib.parseJsonl(
    line({ id: 'ثالثة/art-5', law_id: 'third', law_name: 'نظام الثالثة', article_no: 5, instrument_no: 'م/51',
      text: 'يُصرف بدل الاغتراب للمبتعث الموفَد إلى خارج المملكة وفق جدولٍ يعتمده الوزير.',
      embed_text: 'نظام الثالثة — المادة 5 — بدل الاغتراب للمبتعث الموفَد.', retrieval_status: 'نافذ',
      has_amendments: true, amendment_applied: true, amendment_instrument: 'أ/256', amended_on: '26/9/1438' })
  ).rows, { importId: 'imp-cite' });
  await lib.embedPending(env, 50);
  const ctx = lib.formatRagContext(
    await lib.retrieve(env, ['بدل الاغتراب للمبتعث الموفَد إلى خارج المملكة'], 10)
  );
  assert.match(ctx, /بصيغتها بعد أ\/256 وتاريخ 26\/9\/1438/, 'سطر الإسناد بلا نسخته: ' + ctx.slice(0, 300));
  const prompts = readFileSync(path.join(ROOT, 'src', 'lib', 'prompts.ts'), 'utf8');
  assert.match(prompts, /بصيغتها بعد/, 'البرومبت لا يُلزم بنقل سطر الإسناد');
});

// ═══ ٢٢) ردُّ دفعة: صورةٌ قبل الكتابة، وخطّةٌ قبل التنفيذ ═══
//
// الاستيراد يكتب فوق ما كان، فدفعةٌ معطوبة تُتلف نصّاً صحيحاً. والردُّ نطاقُه
// نظامٌ في دفعة — لا القاعدة كلَّها كما تفعل النسخة الاحتياطية.

const R1 = [
  line({ id: 'ردّ/1', law_id: 'revert-a', law_name: 'نظام الردّ', doc_type: 'نظام', article_no: 1,
    text: 'النصُّ الأوّل للمادة الأولى كما صدر في الجريدة الرسمية.',
    embed_text: 'نظام الردّ — المادة 1 — النصّ الأوّل.', retrieval_status: 'نافذ',
    text_versions: [{ seq: 0, text: 'النصُّ الأوّل للمادة الأولى كما صدر في الجريدة الرسمية.', label: 'الأصل', current: true }] }),
  line({ id: 'ردّ/2', law_id: 'revert-a', law_name: 'نظام الردّ', doc_type: 'نظام', article_no: 2,
    text: 'النصُّ الأوّل للمادة الثانية.', embed_text: 'نظام الردّ — المادة 2.', retrieval_status: 'نافذ' }),
  line({ id: 'آخر/1', law_id: 'revert-b', law_name: 'نظامٌ آخر', doc_type: 'نظام', article_no: 1,
    text: 'مادةٌ في نظامٍ آخر حملتها الدفعتان معاً.', embed_text: 'نظامٌ آخر — المادة 1.', retrieval_status: 'نافذ' }),
];
await lib.upsertLegalChunks(env, lib.parseJsonl(R1.join('\n')).rows, { importId: 'imp-r1', batchId: 'batch-r1' });
// قرارُ مراجعةٍ وقع **قبل** الدفعة الثانية — الصورة تحمله، فيعود بردّها.
await lib.reviewChunk(env, 'ردّ/2', 'approve', 'مراجعٌ قديم');

const R2 = [
  line({ id: 'ردّ/1', law_id: 'revert-a', law_name: 'نظام الردّ', doc_type: 'نظام', article_no: 1,
    text: 'نصٌّ ثانٍ معطوب حلَّ محلَّ الأوّل.', embed_text: 'نظام الردّ — المادة 1 — معطوب.', retrieval_status: 'نافذ' }),
  line({ id: 'ردّ/3', law_id: 'revert-a', law_name: 'نظام الردّ', doc_type: 'نظام', article_no: 3,
    text: 'مادةٌ أدرجتها الدفعة الثانية ولم تكن قبلها.', embed_text: 'نظام الردّ — المادة 3.', retrieval_status: 'نافذ' }),
  line({ id: 'آخر/1', law_id: 'revert-b', law_name: 'نظامٌ آخر', doc_type: 'نظام', article_no: 1,
    text: 'نصٌّ جديد في النظام الآخر — لا يمسّه ردُّ نظامٍ غيره.', embed_text: 'نظامٌ آخر — المادة 1 — جديد.', retrieval_status: 'نافذ' }),
];
await lib.upsertLegalChunks(env, lib.parseJsonl(R2.join('\n')).rows, { importId: 'imp-r2', batchId: 'batch-r2' });
await env.DB.prepare(
  `INSERT INTO legal_imports (id, actor_id, filename, lines, inserted, updated, failed, created_at, batch_id)
   VALUES (?,?,?,?,?,?,?,?,?)`
).bind('imp-r2', 'مسؤول', 'revert-a.jsonl', 3, 1, 2, 0, Date.now(), 'batch-r2').run();
// وقرارُ مراجعةٍ وقع **بعد** الدفعة على مادةٍ ستُردّ — يسقط بردّها، فيُعلَن.
await lib.reviewChunk(env, 'ردّ/1', 'approve', 'مراجعٌ جديد');

await check('٢٢ · الصورة تُؤخذ قبل أن تكتب الدفعة فوقها — صفّاً كاملاً لا حقولاً مختارة', () => {
  const snaps = q("SELECT chunk_id FROM legal_snapshots WHERE batch_id = 'batch-r2' ORDER BY chunk_id")
    .map((r) => r.chunk_id);
  assert.deepEqual(snaps, ['آخر/1', 'ردّ/1'], 'صورةٌ لكل ما كان قائماً قبل الدفعة');
  assert.ok(!snaps.includes('ردّ/3'), 'وما أدرجته الدفعة بلا صورة — وبغيابها يُعرف أنه مُدرَج');

  const snap = JSON.parse(
    q("SELECT row_json FROM legal_snapshots WHERE batch_id = 'batch-r2' AND chunk_id = 'ردّ/1'")[0].row_json
  );
  // الصفُّ كلُّه لا ثمانية أعمدة كما يحفظ سجلّ التحديث: من ردّ من ذاك استرجع
  // النصّ وفقد الخطّ الزمني وحالَ الاسترجاع ونصَّ التضمين.
  const cols = q('PRAGMA table_info(legal_chunks)').length;
  assert.equal(Object.keys(snap).length, cols, `الصورة ناقصةُ الأعمدة: ${Object.keys(snap).length} من ${cols}`);
  assert.match(snap.text, /النصُّ الأوّل/, 'الصورة لا تحمل النصّ الذي كان');
  assert.ok(snap.text_versions, 'الصورة بلا خطٍّ زمني — وهو ما يفقده سجلّ التحديث');
});

await check('٢٢ · والخطّة تُعرض قبل أن تقع، ومعها قرارُ المراجعة الذي سيسقط', async () => {
  const plan = await lib.planRevert(env, 'batch-r2', 'revert-a');
  assert.deepEqual(plan.restore, ['ردّ/1'], 'ما يُستعاد');
  assert.deepEqual(plan.remove, ['ردّ/3'], 'وما يُحذف');
  // أخطرُ ما في الباب: الصورة تحمل حالَ المراجعة كما كانت، فردُّها يمحو قراراً
  // وقع بعدها. صحيحٌ منطقاً، وخطيرٌ إن وقع صامتاً.
  assert.deepEqual(plan.review_lost.map((r) => r.id), ['ردّ/1'], 'قرارُ مراجعةٍ يسقط ولم يُعلَن');
  // وقرارٌ سبق الدفعة لا يُعدّ ساقطاً: الصورة تحمله فيعود كما كان.
  assert.ok(!plan.review_lost.some((r) => r.id === 'ردّ/2'), 'قرارٌ سابقٌ للدفعة عُدَّ ساقطاً');

  const other = await lib.planRevert(env, 'batch-r2', 'revert-b');
  assert.deepEqual(other.restore, ['آخر/1'], 'ونظامٌ آخر في الدفعة له خطّتُه المستقلّة');
});

await check('٢٢ · والتنفيذ يردّ النصّ وحالَ المراجعة، ويُصفّر المتجه، ويحذف المُدرَج بنصِّه محفوظاً', async () => {
  await lib.embedPending(env, 50);
  assert.ok(q("SELECT embedded_at FROM legal_chunks WHERE id = 'ردّ/1'")[0].embedded_at, 'المادة غير مُضمَّنة قبل الردّ');

  const res = await lib.revertLaw(env, 'batch-r2', 'revert-a', { actorId: 'مسؤول' });
  assert.deepEqual(res, { restored: 1, removed: 1 });

  const back = q("SELECT text, embedded_at, review_status, reviewed_by FROM legal_chunks WHERE id = 'ردّ/1'")[0];
  assert.match(back.text, /النصُّ الأوّل/, 'النصّ لم يعد إلى ما كان');
  // نصٌّ عاد ومتجهٌ لم يعد يطابقه أسوأ من غيابهما معاً.
  assert.equal(back.embedded_at, null, 'المتجه لم يُصفَّر ليُعاد بناؤه على النصّ المستعاد');
  assert.equal(back.review_status, 'pending', 'حالُ المراجعة لم تعد إلى ما قبل الدفعة كما أُعلن');
  assert.ok(!back.reviewed_by, 'اسمُ مراجعٍ بقي على قرارٍ سقط');

  assert.equal(q("SELECT COUNT(*) AS n FROM legal_chunks WHERE id = 'ردّ/3'")[0].n, 0, 'المُدرَج لم يُحذف');
  const kept = q("SELECT text, origin FROM legal_chunk_versions WHERE chunk_id = 'ردّ/3'");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].origin, 'deleted', 'ذهب المُدرَج بلا أثرٍ لنصِّه');
});

await check('٢٢ · ونظامٌ آخر حملته الدفعة لا يمسُّه ردُّ نظامٍ غيره', () => {
  assert.match(
    q("SELECT text FROM legal_chunks WHERE id = 'آخر/1'")[0].text,
    /نصٌّ جديد في النظام الآخر/,
    'ردُّ نظامٍ ردَّ معه نظاماً لم يُطلب'
  );
  // ومادةٌ لم تحملها الدفعة الثانية باقيةٌ بقرار مراجعتها السابق.
  const untouched = q("SELECT review_status, reviewed_by FROM legal_chunks WHERE id = 'ردّ/2'")[0];
  assert.equal(untouched.review_status, 'approved');
  assert.equal(untouched.reviewed_by, 'مراجعٌ قديم');
});

await check('٢٢ · والدفعة المردودة تُقيَّد في سجلّها ولا تُحذف منه', async () => {
  const imp = q("SELECT reverted_at, reverted_by FROM legal_imports WHERE batch_id = 'batch-r2'")[0];
  assert.ok(imp.reverted_at, 'دفعةٌ رُدَّ منها تُقرأ في السجلّ كأنها قائمة بأثرها كلِّه');
  assert.equal(imp.reverted_by, 'مسؤول', 'ولا يُعرف من ردَّها');
  const listed = (await lib.listRevertableBatches(env)).find((b) => b.batch_id === 'batch-r2');
  assert.ok(listed, 'وصورُها باقية: ردُّ نظامٍ لا يمنع ردَّ ما معه');
  assert.ok(listed.reverted_at, 'وقائمة الدفعات لا تُظهر أنها رُدَّت');
  assert.equal(listed.filename, 'revert-a.jsonl');
  assert.ok(listed.laws.length >= 2, 'وقائمةُ أنظمتها ناقصة: ' + JSON.stringify(listed.laws));
});

await check('٢٢ · والصور تُقلَّم إلى أحدث ثلاث دفعات — تخزينٌ بلا حدٍّ ثمنٌ بلا مقابل', async () => {
  assert.equal(lib.SNAPSHOT_KEEP, 3);
  for (const b of ['batch-r3', 'batch-r4', 'batch-r5']) {
    await lib.upsertLegalChunks(env, lib.parseJsonl(
      line({ id: 'ردّ/2', law_id: 'revert-a', text: `تغييرٌ صغير في ${b}.`, embed_text: `ردّ 2 — ${b}.`,
        retrieval_status: 'نافذ' })
    ).rows, { importId: b, batchId: b });
  }
  const left = q('SELECT DISTINCT batch_id FROM legal_snapshots ORDER BY batch_id').map((r) => r.batch_id);
  assert.deepEqual(left, ['batch-r3', 'batch-r4', 'batch-r5'], 'التقليم أبقى غير الثلاث الأحدث: ' + left.join('، '));
  // ومن أراد ما هو أقدم فمصدرُه النسخة الاحتياطية لا هذا الجدول.
  const wf = readFileSync(path.join(ROOT, '.github', 'workflows', 'restore-backup.yml'), 'utf8');
  assert.match(wf, /dry_run/, 'سير الاستعادة بلا قراءةٍ قبل الكتابة');
  assert.match(wf, /pre-restore/, 'الاستعادة بلا نسخةٍ للحال القائمة قبلها');
});

await check('٢٢ · ودفعتان في المللي ثانية نفسها: يُقلَّم الأقدم لا الأحدث', async () => {
  // `at` مللي ثانية، ورفعٌ آليّ متتابع يضع دفعتين فيها. والترتيب بالوقت وحده
  // يجعل SQLite تختار بالقرعة، فتذهب صورُ **أحدث** دفعة — وهي أوّل ما يُطلب
  // ردُّه. والفاصل `rowid`: الأحدثُ كتابةً هي الأحدث وقوعاً.
  const real = Date.now;
  const frozen = real() + 60_000;
  Date.now = () => frozen;
  try {
    for (const b of ['tie-1', 'tie-2', 'tie-3', 'tie-4', 'tie-5']) {
      await lib.upsertLegalChunks(env, lib.parseJsonl(
        line({ id: 'تساوٍ/1', law_id: 'tie', text: `نصٌّ كتبته الدفعة ${b}.`, embed_text: `تساوٍ — ${b}.`,
          retrieval_status: 'نافذ' })
      ).rows, { importId: b, batchId: b });
    }
  } finally {
    Date.now = real;
  }
  const ats = q('SELECT DISTINCT at FROM legal_snapshots').length;
  assert.equal(ats, 1, 'الأوقات لم تتساوَ، فالفحص لا يُثبت شيئاً');
  const left = q('SELECT DISTINCT batch_id FROM legal_snapshots ORDER BY batch_id').map((r) => r.batch_id);
  assert.deepEqual(left, ['tie-3', 'tie-4', 'tie-5'], 'التقليم أسقط الأحدث عند تساوي الوقت: ' + left.join('، '));
});

await check('٢٢ · والردُّ يُعرض ولا يقع إلا بطلبٍ صريح، ويُقيَّد بما أسقط', () => {
  const routes = readFileSync(path.join(ROOT, 'src', 'routes', 'legal.ts'), 'utf8');
  const body = routes.slice(routes.indexOf("app.post('/revert'"), routes.indexOf("app.get('/stats'"));
  assert.match(body, /requireAdmin/, 'الردّ بلا حارس');
  assert.match(body, /if \(!c\.req\.query\('apply'\)\) return c\.json\(\{ ok: true, applied: false, plan \}\)/,
    'الردّ يقع بلا عرضٍ سابق');
  assert.match(body, /audit\(c, 'legal\.revert'/, 'الردّ بلا قيدٍ في سجلّ التدقيق');
  assert.match(body, /review_lost: plan\.review_lost\.map/, 'القيد بلا ما أسقطه من قرارات مراجعة');
  assert.match(body, /embedPending/, 'ما صُفِّر متجهُه يبقى بلا فهرسةٍ إلى الليلة القادمة');
  assert.match(routes, /app\.get\('\/revertable', requireAdmin/, 'لا مسار يعرض الدفعات القابلة للردّ');
});

// ═══ ٢٣) الإصدارات الرابع إلى السادس: بطاقة النظام، والمرفقات، ومواد «مكرر»، والملاحق ═══
//
// `status` صار حالَ **النظام** من بطاقته في البوابة، فكان السطر يُرفض بقيمتين
// من أربع، وكانت المادة المستبقاة بعد إلغاء نظامها تُقلب «ملغاة» وهي نافذة.
// والملحق رقمُه اصطلاحيّ (`1001`) لا يُفهرَس ولا يُستشهد به ولا يُستدعى.
//
// والتاريخان بعيدان عن اليوم عمداً: فحصٌ يمرّ اليوم ويفشل غداً لأن تاريخاً
// حلّ ليس فحصاً.

const FUTURE = '2999-01-01';
const PAST = '2000-01-01';
const V6_BASE = {
  law_id: 'sixth', law_name: 'نظام السادسة', doc_type: 'نظام', law_status_source: 'البوابة',
  status: 'ساري', law_repealed: false, has_amendments: false, is_repealed: false, needs_review: false,
  amendment_events: [], instrument_no: 'م/60', date_hijri: '1440/01/01',
};
// ونصُّ التضمين يحمل نصَّ المادة كما يحمله في الملفّات الحقيقية: مسبوقاً بسياقه.
const v6line = (o) => line({ ...V6_BASE, embed_text: `${o.law_name ?? V6_BASE.law_name} — ${o.text ?? o.id}`, ...o });

const V6_LINES = [
  v6line({ id: 'سادسة-معلّق/art-001', law_id: 'sixth-pending', law_name: 'نظام السادسة الجديد',
    status: 'لم يبدأ العمل به', law_pending: true, law_effective_from: FUTURE,
    article_no: 1, article_label: 'المادة الأولى',
    text: 'يُعمل بهذا النظام الجديد في التاريخ المحدّد لنفاذه.',
    retrieval_status: 'نافذ_بتحذير',
    retrieval_warning: 'هذا النظام لم يبدأ العمل به — يُعمل به من 2999-01-01، والنافذ قبله نظام السادسة القديم.' }),
  v6line({ id: 'سادسة-قيد/art-001', law_id: 'sixth-drafting', status: 'جاري العمل على النظام',
    article_no: 1, article_label: 'المادة الأولى', text: 'مادةٌ من نظامٍ جارٍ العملُ عليه.',
    retrieval_status: 'نافذ' }),
  v6line({ id: 'سادسة-قديم/art-001', law_id: 'sixth-old', law_name: 'نظام السادسة القديم',
    status: 'ملغى', status_raw: 'لاغي', law_repealed: true,
    article_no: 1, article_label: 'المادة الأولى', text: 'مادةٌ من نظامٍ ألغاه اللاحقُ كلَّه.',
    retrieval_status: 'ملغى' }),
  v6line({ id: 'سادسة-قديم/art-002', law_id: 'sixth-old', law_name: 'نظام السادسة القديم',
    status: 'ملغى', status_raw: 'لاغي', law_repealed: true, kept_after_repeal: true,
    article_no: 2, article_label: 'المادة الثانية', text: 'مادةٌ مستبقاة تبقى نافذةً بعد إلغاء نظامها.',
    retrieval_status: 'نافذ' }),
  v6line({ id: 'سادسة/art-003', article_no: 3, article_label: 'المادة الثالثة',
    text: 'مادةٌ حلّ تاريخُ إلغائها المجدول قبل رفع الدفعة.', scheduled_repeal_from: PAST,
    retrieval_status: 'نافذ' }),
  v6line({ id: 'سادسة/art-004', article_no: 4, article_label: 'المادة الرابعة',
    text: 'مادةٌ مجدولٌ إلغاؤها في تاريخٍ لم يحلّ.', scheduled_repeal_from: FUTURE,
    retrieval_status: 'نافذ' }),
  v6line({ id: 'سادسة/art-014', article_no: 14, article_label: 'المادة الرابعة عشرة', has_attachment: true,
    text: 'تُفرض الرسوم المبيّنة في الجدول المرفق بهذه المادة.', retrieval_status: 'نافذ' }),
  v6line({ id: 'سادسة/art-014-attach', article_no: 14, article_label: 'مرفق المادة 14',
    is_attachment: true, attachment_of: 'سادسة/art-014', amend_link: 'رقم',
    text: 'جدول الرسوم: الفئة الأولى مئة ريال، والفئة الثانية مئتا ريال.', retrieval_status: 'نافذ' }),
  v6line({ id: 'سادسة/art-015', article_no: 15, article_label: 'المادة الخامسة عشرة',
    text: 'يُنشأ سجلٌّ للمنشآت في الوزارة.', retrieval_status: 'نافذ' }),
  v6line({ id: 'سادسة/art-015-mukarrar', article_no: 15, article_label: 'المادة الخامسة عشرة مكرر',
    text: 'تُحدَّث بيانات السجلّ سنوياً.', retrieval_status: 'نافذ' }),
  v6line({ id: 'سادسة/art-231', article_no: 231, former_article_no: 240,
    article_label: 'المادة الحادية والثلاثون بعد المائتين',
    text: 'مادةٌ نُقلت من موضعها السابق إلى موضعها الحالي.', retrieval_status: 'نافذ' }),
  v6line({ id: 'سادسة/annex-01', article_no: 1001, is_annex: true, article_label: 'جدول المخالفات رقم (6)',
    text: 'مخالفة السرعة: غرامةٌ من ثلاثمئة إلى خمسمئة ريال.', retrieval_status: 'نافذ' }),
];
const v6 = lib.parseJsonl(V6_LINES.join('\n'));
const v6by = Object.fromEntries(v6.rows.map((r) => [r.id, r]));

await check('٢٣ · حالُ النظام بقيمها الأربع تُقرأ ولا تُرفض — ولا تُقرأ حالاً للمادة', () => {
  assert.equal(v6.errors.length, 0, JSON.stringify(v6.errors));
  assert.equal(v6.rows.length, V6_LINES.length);
  assert.equal(v6by['سادسة-معلّق/art-001'].law_status, 'لم يبدأ العمل به');
  assert.equal(v6by['سادسة-قيد/art-001'].law_status, 'جاري العمل على النظام');
  assert.equal(v6by['سادسة-قديم/art-001'].law_status_raw, 'لاغي');
  assert.equal(v6by['سادسة-معلّق/art-001'].law_pending, 1);
  assert.equal(v6by['سادسة-معلّق/art-001'].law_effective_from, FUTURE);
  // والنظام الذي لم يبدأ العمل به نافذٌ بتحذير، ونصُّ تحذيره من الملف كما ورد.
  assert.equal(v6by['سادسة-معلّق/art-001'].retrieval_status, lib.RETRIEVAL_WARNING);
  assert.match(v6by['سادسة-معلّق/art-001'].retrieval_warning, /لم يبدأ العمل به/);
});

await check('٢٣ · والمستبقاة بعد إلغاء نظامها نافذة، وسائرُ مواد النظام اللاغي ملغاة', () => {
  const kept = v6by['سادسة-قديم/art-002'];
  assert.equal(kept.retrieval_status, lib.RETRIEVAL_EFFECTIVE, '«ملغى» في status قلبت المستبقاة ملغاة');
  assert.equal(kept.is_repealed, 0, 'إلغاءُ النظام قُرئ إلغاءً للمادة');
  assert.equal(kept.status, 'active');
  assert.equal(kept.kept_after_repeal, 1);
  assert.equal(kept.law_repealed, 1);
  const gone = v6by['سادسة-قديم/art-001'];
  assert.equal(gone.retrieval_status, lib.RETRIEVAL_REPEALED);
  assert.equal(gone.status, 'repealed', 'عمودُ الحال يقول غيرَ ما يقوله حالُ الاسترجاع');
  // وحارسُ الاتجاه الآمن: نظامٌ لاغٍ ومادةٌ غيرُ مستبقاة وحالٌ تقول «نافذ» — تناقضٌ يُحسم ملغى.
  const conflict = lib.parseJsonl(v6line({ id: 'سادسة-قديم/art-009', law_id: 'sixth-old', status: 'ملغى',
    law_repealed: true, text: 'نصّ', retrieval_status: 'نافذ' }));
  assert.equal(conflict.rows[0].retrieval_status, lib.RETRIEVAL_REPEALED);
  // وقرارُ صاحب البيانات الصريح يغلب لفظ البطاقة: `law_repealed: false` مع «ملغى».
  const decided = lib.parseJsonl(v6line({ id: 'سادسة-قرار/art-001', law_id: 'sixth-decided', status: 'ملغى',
    law_repealed: false, law_status_source: 'قرار', text: 'نصّ', retrieval_status: 'نافذ' }));
  assert.equal(decided.rows[0].retrieval_status, lib.RETRIEVAL_EFFECTIVE, 'قرارٌ صريح غلبه لفظُ البطاقة');
});

await check('٢٣ · والإلغاء المجدول يُحسم بيومه: ما حلّ يومه ملغى، وما لم يحلّ نافذ', () => {
  assert.equal(v6by['سادسة/art-003'].retrieval_status, lib.RETRIEVAL_REPEALED, 'إلغاءٌ حلّ يومه بقي نافذاً');
  assert.equal(v6by['سادسة/art-004'].retrieval_status, lib.RETRIEVAL_EFFECTIVE);
  assert.equal(v6by['سادسة/art-004'].scheduled_repeal_from, FUTURE);
});

await check('٢٣ · والتاريخان ميلاديّان: هجريٌّ فيهما يُرفض برمزه ولا يُقارَن', () => {
  const bad = lib.parseJsonl(v6line({ id: 'سادسة/art-090', text: 'نصّ', scheduled_repeal_from: '1448/01/01هـ' }));
  assert.equal(bad.rows.length, 0, 'هجريٌّ حُفظ في حقلٍ يُقارَن بتاريخ الخادم نصّاً');
  assert.equal(bad.errors[0].code, 'bad_date:scheduled_repeal_from');
  const bad2 = lib.parseJsonl(v6line({ id: 'سادسة/art-091', text: 'نصّ', law_pending: true, law_effective_from: '1449/05/01' }));
  assert.equal(bad2.errors[0]?.code, 'bad_date:law_effective_from');
});

await check('٢٣ · والتحذير البديل بسببه: نفاذٌ لم يحلّ أو تعديلٌ لم يُدمج', () => {
  const pending = lib.parseJsonl(v6line({ id: 'سادسة-معلّق/art-002', law_id: 'sixth-pending',
    status: 'لم يبدأ العمل به', law_pending: true, law_effective_from: FUTURE, text: 'نصّ',
    retrieval_status: 'نافذ' }));
  // نافذٌ في الملف ونظامُه لم يبدأ العمل به: يُحسم بتحذير، ونصُّه البديل للنفاذ لا للتعديل.
  assert.equal(pending.rows[0].retrieval_status, lib.RETRIEVAL_WARNING);
  assert.equal(pending.rows[0].retrieval_warning, lib.DEFERRED_NOTICE);
  const amended = lib.parseJsonl(v6line({ id: 'سادسة/art-092', text: 'نصّ', has_amendments: true,
    amendment_applied: false, retrieval_status: 'نافذ_بتحذير' }));
  assert.equal(amended.rows[0].retrieval_warning, lib.AMENDMENT_NOTICE);
});

await check('٢٣ · والملحق لا يُفهرَس برقمه الاصطلاحيّ، والمنقولة تُفهرَس بالرقمين', () => {
  const annex = v6by['سادسة/annex-01'];
  assert.equal(annex.is_annex, 1);
  assert.ok(!annex.handle_norm.includes('1001'), 'الرقم الاصطلاحيّ دخل الفهرس: ' + annex.handle_norm);
  assert.ok(annex.handle_norm.includes('جدول المخالفات'), 'الملحق بلا عنوانه في الفهرس');
  const moved = v6by['سادسة/art-231'];
  assert.equal(moved.former_article_no_norm, '240');
  assert.ok(moved.handle_norm.includes('الماده 240'), 'الرقم السابق غائبٌ عن الفهرس');
  assert.ok(moved.handle_norm.includes('الماده 231'));
});

await check('٢٣ · والمرفق ومادة «مكرر» يُعرفان بحقولهما ولاحقة معرّفهما', () => {
  const att = v6by['سادسة/art-014-attach'];
  assert.equal(att.is_attachment, 1);
  assert.equal(att.attachment_of, 'سادسة/art-014');
  assert.equal(att.amend_link, 'رقم');
  assert.equal(v6by['سادسة/art-014'].has_attachment, 1);
  assert.equal(v6by['سادسة/art-015-mukarrar'].is_mukarrar, 1);
  assert.equal(v6by['سادسة/art-015'].is_mukarrar, 0);
  // ومادة «مكرر» ليست تكراراً (§3-8): لا وسمَ رقمٍ مكرّر عليها.
  assert.equal(v6by['سادسة/art-015-mukarrar'].is_duplicate, 0);
  // والحقول الجديدة أعمدةٌ لا `meta_json`.
  for (const r of v6.rows) {
    const meta = r.meta_json ? JSON.parse(r.meta_json) : {};
    for (const k of ['law_status_source', 'law_repealed', 'is_annex', 'is_attachment', 'former_article_no']) {
      assert.ok(!(k in meta), `«${k}» بقي في meta_json في ${r.id}`);
    }
  }
});

await check('٢٣ · والملفّ القديم يُقرأ كما كان: «ملغى» بلا بطاقةٍ حالُ المادة', () => {
  const legacy = lib.parseJsonl(line({ id: 'قديم/1', law_id: 'legacy', text: 'نصّ', embed_text: 'نصّ', status: 'ملغى' }));
  assert.equal(legacy.rows[0].is_repealed, 1, 'المعنى القديم لـstatus ضاع');
  assert.equal(legacy.rows[0].retrieval_status, lib.RETRIEVAL_REPEALED);
  assert.equal(legacy.rows[0].law_status, null);
  // وقيمةٌ لا تكون إلا حالَ نظام تُقرأ كذلك ولو بلا بطاقة — لا تُرفض ومعها النظام كلُّه.
  const lawOnly = lib.parseJsonl(line({ id: 'قديم/2', law_id: 'legacy', text: 'نصّ', embed_text: 'نصّ',
    status: 'لم يبدأ العمل به' }));
  assert.equal(lawOnly.errors.length, 0, JSON.stringify(lawOnly.errors));
  assert.equal(lawOnly.rows[0].law_pending, 1);
  assert.equal(lawOnly.rows[0].retrieval_status, lib.RETRIEVAL_WARNING);
});

await check('٢٣ · وما فاته الختم يُعدّ ويُقال في تقرير الاستيراد', () => {
  assert.equal(v6.unstamped, 0);
  const mixed = lib.parseJsonl([
    v6line({ id: 'ختم/1', text: 'نصّ' }),
    line({ id: 'ختم/2', law_id: 'sixth', text: 'نصّ', embed_text: 'نصّ' }),
  ].join('\n'));
  assert.equal(mixed.unstamped, 1);
  const routes = readFileSync(path.join(ROOT, 'src', 'routes', 'legal.ts'), 'utf8');
  assert.match(routes, /unstamped: parsed\.unstamped/, 'التقرير لا يقول ما فاته الختم');
});

await lib.upsertLegalChunks(env, v6.rows, { importId: 'imp-v6', batchId: 'batch-v6' });

await check('٢٣ · والحقول تُكتب في أعمدتها وتبقى بإعادة الرفع', async () => {
  const row = q("SELECT law_status, law_status_source, kept_after_repeal, law_repealed, is_annex, is_mukarrar, former_article_no_norm, attachment_of, scheduled_repeal_from FROM legal_chunks WHERE id = 'سادسة-قديم/art-002'")[0];
  assert.equal(row.law_status, 'ملغى');
  assert.equal(row.law_status_source, 'البوابة');
  assert.equal(row.kept_after_repeal, 1);
  assert.equal(row.law_repealed, 1);
  assert.equal(q("SELECT attachment_of FROM legal_chunks WHERE id = 'سادسة/art-014-attach'")[0].attachment_of, 'سادسة/art-014');
  assert.equal(q("SELECT is_annex FROM legal_chunks WHERE id = 'سادسة/annex-01'")[0].is_annex, 1);
  assert.equal(q("SELECT is_mukarrar FROM legal_chunks WHERE id = 'سادسة/art-015-mukarrar'")[0].is_mukarrar, 1);
  // إعادةُ رفع الدفعة نفسها لا تُضيف ولا تُغيّر شيئاً.
  const again = await lib.upsertLegalChunks(env, v6.rows, { importId: 'imp-v6b', batchId: 'batch-v6b' });
  assert.equal(again.inserted, 0);
  assert.equal(again.archived, 0, 'إعادةُ رفع الملف نفسه أرشفت نسخاً');
});

// ═══ ٢٤) الاسترجاع في الإصدار السادس: الحال والتاريخ والرقم والمرفق ═══
//
// كلُّ شرطٍ هنا في طبقة الاسترجاع لا في الواجهة (§5): المحادثة والتقرير
// والواجهة البرمجية يمرّون به سواء.

await lib.embedPending(env, 200);
const ids = (hits) => hits.map((h) => h.id);

await check('٢٤ · المستبقاة بعد إلغاء نظامها تدخل البحث، وسائرُ مواد النظام اللاغي لا تدخله', async () => {
  const kept = await lib.searchLegal(env, 'مادةٌ مستبقاة تبقى نافذةً بعد إلغاء نظامها', { limit: 10, lexicalOnly: true });
  assert.ok(ids(kept).includes('سادسة-قديم/art-002'), 'المستبقاة غابت عن البحث وهي نافذة');
  const gone = await lib.searchLegal(env, 'مادةٌ من نظامٍ ألغاه اللاحقُ كلَّه', { limit: 10, lexicalOnly: true });
  assert.ok(!ids(gone).includes('سادسة-قديم/art-001'), 'مادةٌ من نظامٍ لاغٍ دخلت البحث');
  const archive = await lib.searchLegal(env, 'مادةٌ من نظامٍ ألغاه اللاحقُ كلَّه', {
    limit: 10, lexicalOnly: true, includeRepealed: true,
  });
  const found = archive.find((h) => h.id === 'سادسة-قديم/art-001');
  assert.ok(found, 'ولا يُستدعى بوسمه صراحةً');
  assert.equal(found.lawRepealed, true);
  assert.equal(found.retrievalStatus, lib.RETRIEVAL_REPEALED);
  // ولا متجهَ لها: الملغاة لا تُفهرَس أصلاً.
  const seq = q("SELECT seq FROM legal_chunks WHERE id = 'سادسة-قديم/art-001'")[0].seq;
  assert.ok(!vectorStore.has(`legal:${seq}`), 'مادةُ نظامٍ لاغٍ فُهرست');
});

await check('٢٤ · الإلغاء المجدول يُقيَّم وقت الاستعلام، لا حين تُرفع دفعةٌ بعده (§6-8)', async () => {
  // دفعةٌ رُفعت قبل اليوم والتاريخ لم يحلّ؛ ثم حلّ ولم تُرفع دفعة.
  const before = await lib.searchLegal(env, 'مادةٌ مجدولٌ إلغاؤها في تاريخٍ لم يحلّ', { limit: 10, lexicalOnly: true });
  const hit = before.find((h) => h.id === 'سادسة/art-004');
  assert.ok(hit, 'مادةٌ لم يحلّ تاريخُ إلغائها غابت');
  assert.equal(hit.scheduledRepealFrom, FUTURE);
  q("UPDATE legal_chunks SET scheduled_repeal_from = ? WHERE id = 'سادسة/art-004'", PAST);
  try {
    const after = await lib.searchLegal(env, 'مادةٌ مجدولٌ إلغاؤها في تاريخٍ لم يحلّ', { limit: 10, lexicalOnly: true });
    assert.ok(!ids(after).includes('سادسة/art-004'), 'إلغاءٌ حلّ يومه ينتظر دفعةً تقوله');
    const direct = await lib.getChunkById(env, 'سادسة/art-004', true);
    assert.equal(direct.retrievalStatus, lib.RETRIEVAL_REPEALED, 'الاستدعاء المباشر لا يقول إنها ملغاة');
    // والتنظيف يحذف متجهها في أوّل دورة بعد يومها.
    await lib.embedPending(env, 50);
    const seq = q("SELECT seq FROM legal_chunks WHERE id = 'سادسة/art-004'")[0].seq;
    assert.ok(!vectorStore.has(`legal:${seq}`), 'بقي متجهُ مادةٍ حلّ إلغاؤها');
  } finally {
    q("UPDATE legal_chunks SET scheduled_repeal_from = ? WHERE id = 'سادسة/art-004'", FUTURE);
    q("UPDATE legal_chunks SET embedded_at = NULL WHERE id = 'سادسة/art-004'");
    await lib.embedPending(env, 50);
  }
});

await check('٢٤ · وتحذيرُ نظامٍ لم يبدأ العمل به يسقط وحده حين يحلّ يومه', async () => {
  const pending = await lib.getChunkById(env, 'سادسة-معلّق/art-001');
  assert.equal(pending.lawPending, true);
  assert.equal(pending.retrievalStatus, lib.RETRIEVAL_WARNING);
  assert.match(pending.retrievalWarning, /لم يبدأ العمل به/);
  q("UPDATE legal_chunks SET law_effective_from = ? WHERE id = 'سادسة-معلّق/art-001'", PAST);
  try {
    const started = await lib.getChunkById(env, 'سادسة-معلّق/art-001');
    assert.equal(started.lawPending, false, 'نظامٌ حلّ يومُ نفاذه بقي «لم يبدأ العمل به»');
    assert.equal(started.retrievalStatus, lib.RETRIEVAL_EFFECTIVE);
    assert.equal(started.retrievalWarning, null, 'تحذيرُ النفاذ بقي بعد يومه');
    // وتعديلٌ لم يُدمج يبقى تحذيرُه ولو حلّ يومُ النظام.
    q("UPDATE legal_chunks SET has_amendments = 1, amendment_applied = 0 WHERE id = 'سادسة-معلّق/art-001'");
    const amended = await lib.getChunkById(env, 'سادسة-معلّق/art-001');
    assert.equal(amended.retrievalStatus, lib.RETRIEVAL_WARNING);
    assert.equal(amended.retrievalWarning, lib.AMENDMENT_NOTICE, 'سقط تحذيرُ التعديل مع تحذير النفاذ');
    const [law] = (await lib.listLaws(env)).filter((l) => l.law_id === 'sixth-pending');
    assert.equal(law.law_pending, 0, 'قائمة الأنظمة تقول «لم يبدأ العمل به» بعد يومه');
  } finally {
    q("UPDATE legal_chunks SET law_effective_from = ?, has_amendments = 0 WHERE id = 'سادسة-معلّق/art-001'", FUTURE);
  }
  const [law] = (await lib.listLaws(env)).filter((l) => l.law_id === 'sixth-pending');
  assert.equal(law.law_pending, 1);
  assert.equal(law.law_effective_from, FUTURE);
});

await check('٢٤ · الاستدعاء بالرقم: المرفق بعد مادته، و«مكرر» وحدها، والملحق لا برقمه، والمنقولة بالرقمين', async () => {
  assert.deepEqual(ids(await lib.getArticle(env, { lawId: 'sixth', articleNo: '14' })),
    ['سادسة/art-014', 'سادسة/art-014-attach'], 'المرفق لم يُرجَع مع مادته بعدها');
  assert.deepEqual(ids(await lib.getArticle(env, { lawId: 'sixth', articleNo: '15' })),
    ['سادسة/art-015'], 'مادة «مكرر» رُدّت مع الأصل');
  assert.deepEqual(ids(await lib.getArticle(env, { lawId: 'sixth', articleNo: '15 مكرر' })),
    ['سادسة/art-015-mukarrar'], 'مادة «مكرر» لا تُستدعى بعنوانها');
  assert.deepEqual(ids(await lib.getArticle(env, { lawId: 'sixth', articleNo: '1001' })), [],
    'الملحق استُدعي برقمه الاصطلاحيّ');
  assert.deepEqual(ids(await lib.getArticle(env, { lawId: 'sixth', articleNo: '240' })), ['سادسة/art-231'],
    'المنقولة لا تُستدعى برقمها السابق');
  assert.deepEqual(ids(await lib.getArticle(env, { lawId: 'sixth', articleNo: '231' })), ['سادسة/art-231']);
});

await check('٢٤ · والبحث يرجّح بالشرط نفسه، والملحق يُجد بعنوانه', async () => {
  const byNo = await lib.searchLegal(env, 'ما نصّ المادة 14', { lawId: 'sixth', limit: 10, lexicalOnly: true });
  const order = ids(byNo);
  assert.ok(order.includes('سادسة/art-014-attach'), 'البحث بالرقم لم يُرجع المرفق مع مادته');
  const mk = await lib.searchLegal(env, 'المادة 15 مكرر', { lawId: 'sixth', limit: 10, lexicalOnly: true });
  assert.equal(mk[0]?.id, 'سادسة/art-015-mukarrar', 'مادة «مكرر» لم تتصدّر حين طُلبت بعنوانها');
  const annex = await lib.searchLegal(env, 'المادة 1001', { lawId: 'sixth', limit: 10, lexicalOnly: true });
  assert.ok(!annex.some((h) => h.isAnnex && h.signals.includes('article')), 'الملحق رُجِّح برقمه الاصطلاحيّ');
  const table = await lib.searchLegal(env, 'جدول المخالفات', { limit: 10, lexicalOnly: true });
  assert.ok(ids(table).includes('سادسة/annex-01'), 'الملحق لا يُجد بعنوانه');
});

await check('٢٤ · تحذيرُ الحال يبلغ سياق المساعد بنصّه، والملحق يُستشهد به بعنوانه (§6-4)', async () => {
  const rag = await lib.retrieve(env, ['يُعمل بهذا النظام الجديد في التاريخ المحدّد لنفاذه'], 10);
  const context = lib.formatRagContext(rag);
  assert.match(context, /تنبيه: هذا النظام لم يبدأ العمل به/, 'تحذيرُ النفاذ لم يبلغ البرومبت: ' + context.slice(0, 2400));
  const annexRag = await lib.retrieve(env, ['مخالفة السرعة غرامة'], 5);
  const annexCtx = lib.formatRagContext(annexRag);
  assert.match(annexCtx, /جدول المخالفات رقم \(6\)/, 'الملحق بلا عنوانه في سطر الإسناد');
  assert.ok(!/المادة 1001/.test(annexCtx), 'الملحق استُشهد به برقمه الاصطلاحيّ');
  assert.match(context, /أحِل إلى سجل التعديلات/, 'السياق لا يمنع صياغة نصٍّ نافذٍ غير متاح');
});

await check('٢٤ · الملغاة بإلغاء نظامها لا تدخل الطابور، ولا تُعدّ فيه', async () => {
  q("UPDATE legal_chunks SET needs_review = 1 WHERE id IN ('سادسة-قديم/art-001', 'سادسة-قديم/art-002')");
  try {
    const queue = await lib.listReviewQueue(env, { lawId: 'sixth-old', limit: 50 });
    assert.ok(!ids(queue.articles).includes('سادسة-قديم/art-001'), 'مادةُ نظامٍ لاغٍ دخلت الطابور');
    assert.ok(ids(queue.articles).includes('سادسة-قديم/art-002'), 'والمستبقاة النافذة غابت عنه');
    const dash = await lib.reviewDashboard(env, { lawId: 'sixth-old' });
    assert.ok(dash.repealed >= 1, 'عدُّ الملغاة لا يرى مادةَ النظام اللاغي');
  } finally {
    q("UPDATE legal_chunks SET needs_review = 0 WHERE id IN ('سادسة-قديم/art-001', 'سادسة-قديم/art-002')");
  }
  const law = (await lib.listLaws(env)).find((l) => l.law_id === 'sixth-old');
  assert.equal(law.repealed, 1, 'قائمة الأنظمة تعدّ الملغاة بحقلٍ واحد');
  assert.equal(law.effective, 1);
  assert.equal(law.law_repealed, 1);
});

await check('٢٤ · اسمٌ يطابق نظامين لا يُفتح أقربُهما', async () => {
  await lib.upsertLegalChunks(env, lib.parseJsonl(v6line({ id: 'سادسة-ثانية/art-001', law_id: 'sixth-twin',
    law_name: 'نظام السادسة القديم', instrument_no: 'م/99', date_hijri: '1446/01/01', article_no: 1,
    text: 'مادةٌ من نظامٍ آخر بالاسم نفسه.', retrieval_status: 'نافذ' })).rows, { importId: 'imp-twin' });
  const twin = await lib.resolveLawByTitle(env, 'نظام السادسة القديم');
  assert.deepEqual(twin, { lawId: null, ambiguous: true }, 'فُتح أحدُ نظامين بالاسم وحده');
  const single = await lib.resolveLawByTitle(env, 'نظام السادسة الجديد');
  assert.deepEqual(single, { lawId: 'sixth-pending', ambiguous: false });
  const routes = readFileSync(path.join(ROOT, 'src', 'routes', 'legal.ts'), 'utf8');
  assert.match(routes, /في المنصة أكثر من نظام بهذا الاسم — افتح المادة من صفحة نظامها/);
  assert.match(routes, /ambiguous: true \},\s*409/, 'الاسم المشترك لا يُردّ بما يميّزه');
});

await check('٢٤ · الاعتماد لا يُسقط تحذيرَ نظامٍ لم يبدأ العمل به، والتحرير يُبقي الخطّ الزمني صادقاً', async () => {
  q("UPDATE legal_chunks SET needs_review = 1 WHERE id = 'سادسة-معلّق/art-001'");
  const res = await lib.reviewChunk(env, 'سادسة-معلّق/art-001', 'approve', 'مراجع');
  assert.equal(res.ok, true);
  const row = q("SELECT retrieval_status, retrieval_warning FROM legal_chunks WHERE id = 'سادسة-معلّق/art-001'")[0];
  assert.equal(row.retrieval_status, lib.RETRIEVAL_WARNING, 'الاعتماد أسقط تحذيرَ نظامٍ لم يبدأ العمل به');
  assert.match(row.retrieval_warning, /لم يبدأ العمل به/);

  await lib.reviewChunk(env, 'سادسة/art-015', 'edit', 'مراجع', { text: 'يُنشأ سجلٌّ للمنشآت التجارية في الوزارة.' });
  const edited = q("SELECT text, text_versions, embed_text FROM legal_chunks WHERE id = 'سادسة/art-015'")[0];
  const current = JSON.parse(edited.text_versions).filter((v) => v.current);
  assert.equal(current.length, 1);
  assert.equal(current[0].text, edited.text, 'النسخة المعتمدة في الخطّ الزمني تخالف النصّ المحرَّر');
  await lib.reviewChunk(env, 'سادسة/art-015', 'undo', 'مراجع');
  const undone = q("SELECT text, text_versions FROM legal_chunks WHERE id = 'سادسة/art-015'")[0];
  assert.equal(undone.text, 'يُنشأ سجلٌّ للمنشآت في الوزارة.');
  assert.equal(JSON.parse(undone.text_versions).find((v) => v.current).text, undone.text, 'التراجع ترك الخطّ الزمني على المحرَّر');

  // ونصُّ التضمين للملحق بعنوانه: تحريرُه لا يُدخل رقمه الاصطلاحيّ المتجه.
  await lib.reviewChunk(env, 'سادسة/annex-01', 'edit', 'مراجع', { text: 'مخالفة السرعة: غرامةٌ من ثلاثمئة إلى ستمئة ريال.' });
  const annexEmbed = q("SELECT embed_text FROM legal_chunks WHERE id = 'سادسة/annex-01'")[0].embed_text;
  assert.ok(!annexEmbed.includes('1001'), 'نصّ تضمين الملحق المحرَّر يحمل رقمه الاصطلاحيّ: ' + annexEmbed);
  assert.match(annexEmbed, /جدول المخالفات رقم \(6\)/);
  await lib.reviewChunk(env, 'سادسة/annex-01', 'undo', 'مراجع');
});

await check('٢٤ · صحّة القاعدة: الفهرس يُقابَل بسجلاته، والمتجه بلا سجلٍّ يُعدّ (§6-7)', async () => {
  await lib.embedPending(env, 500);
  const clean = await lib.legalStats(env, { vectors: true });
  assert.ok(clean.vectors, 'صحّة القاعدة بلا عدّ الفهرس');
  assert.equal(clean.vectors.orphans, 0, 'متجهٌ بلا سجلٍّ في قاعدةٍ نظيفة: ' + JSON.stringify(clean.vectors));
  vectorStore.set('legal:999999', { id: 'legal:999999', values: new Array(DIM).fill(0), metadata: {} });
  try {
    const dirty = await lib.legalStats(env, { vectors: true });
    assert.equal(dirty.vectors.orphans, 1, 'متجهٌ بلا سجلّ لم يُعدّ');
    const nightly = await lib.vectorCheck(env);
    assert.equal(nightly.orphans, 1, 'والدورة الليلية لا تراه');
  } finally {
    vectorStore.delete('legal:999999');
  }
  // وجسُّ الشريط لا يسأل الفهرس: `vectors` بطلبٍ صريح.
  assert.equal((await lib.legalStats(env)).vectors, undefined);
  const cron = readFileSync(path.join(ROOT, 'src', 'cron.ts'), 'utf8');
  assert.match(cron, /vectorCheck\(env\)/, 'الدورة الليلية لا تفحص المتجه بلا سجلّ');
  assert.match(cron, /vectorHealth\(env\)/, 'الدورة الليلية تكتب شرط التضمين بيدها');
});

await check('٢٤ · فحصُ الملف قبل رفعه يقبل مادةَ النظام اللاغي، ويرفض ما فاته الختم وما تناقض', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = path.join(ROOT, 'node_modules', '.cache');
  const withVersions = (o) => ({ ...o, text_versions: [{ seq: 0, text: o.text, current: true }] });
  const run = async (name, rows) => {
    const file = path.join(dir, name);
    await writeFile(file, rows.map((o) => JSON.stringify(withVersions(o))).join('\n') + '\n');
    return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-legal.mjs'), '--file', file], { encoding: 'utf8' });
  };
  const base = { ...V6_BASE, article_label: 'المادة', embed_text: 'نصّ', retrieval_status: 'نافذ' };
  // مادةٌ من نظامٍ لاغٍ حالُها «ملغى» و`is_repealed` فيها `false` — ليس تناقضاً.
  const good = await run('verify-v6-good.jsonl', [
    { ...base, id: 'فحص/1', article_no: 1, text: 'نصّ نافذ.' },
    { ...base, id: 'فحص-قديم/1', law_id: 'v-old', status: 'ملغى', law_repealed: true, article_no: 1,
      text: 'نصّ من نظامٍ لاغٍ.', retrieval_status: 'ملغى' },
    { ...base, id: 'فحص-قديم/2', law_id: 'v-old', status: 'ملغى', law_repealed: true, kept_after_repeal: true,
      article_no: 2, text: 'نصّ مستبقى.' },
  ]);
  assert.equal(good.status, 0, 'الفحص رفض ملفاً سليماً من الإصدار السادس:\n' + good.stdout.slice(-1200));
  assert.match(good.stdout, /مستبقاة بعد إلغاء نظامها/, 'البيان بلا أصناف الإصدار السادس');

  const bad = await run('verify-v6-bad.jsonl', [
    { ...base, id: 'فحص/2', article_no: 2, text: 'مستبقاةٌ قيل إنها ملغاة.', kept_after_repeal: true,
      law_repealed: true, status: 'ملغى', retrieval_status: 'ملغى' },
    { id: 'فحص/3', law_id: 'sixth', law_name: 'نظام السادسة', doc_type: 'نظام', article_no: 3,
      article_label: 'المادة', text: 'سجلٌّ فاته الختم.', embed_text: 'نصّ', retrieval_status: 'نافذ',
      amendment_events: [], has_amendments: false, is_repealed: false, needs_review: false },
  ]);
  assert.equal(bad.status, 1, 'الفحص قبل ملفاً متناقضاً فاته الختم');
  assert.match(bad.stdout, /✗ الحالة والإلغاء لا يتناقضان/);
  assert.match(bad.stdout, /✗ كل سجلٍّ يحمل ختم الحالة/);
});

await check('٢٤ · ولا حذفَ لأيتام دفعةٍ تُخطّيت منها أسطر', () => {
  const routes = readFileSync(path.join(ROOT, 'src', 'routes', 'legal.ts'), 'utf8');
  const body = routes.slice(routes.indexOf("app.post('/finalize'"), routes.indexOf("app.get('/revertable'"));
  assert.match(body, /SUM\(failed\)/, 'الختام لا ينظر فيما تُخطّي من الدفعة');
  assert.match(body, /if \(skipped > 0\)/, 'الحذف يقع على دفعةٍ ناقصة');
  const script = readFileSync(path.join(ROOT, 'scripts', 'import-legal.mjs'), 'utf8');
  assert.match(script, /seen\.skipped/, 'السكربت يطلب الحذف على دفعةٍ ناقصة');
});

// ═══ ٢٥) بقاءُ التحرير البشري عبر الدفعات (§6-6)، ومرشّحُ نوع التعديل (§6-3) ═══
//
// إعادةُ رفع نظامٍ رُوجعت موادُّه كانت تدهس التحرير وتُسقط الاعتماد بلا أثر —
// ولو لم يتغيّر في المصدر حرف.

const R6 = (o) => v6line({ law_id: 'seventh', law_name: 'نظام السابعة', needs_review: true,
  has_amendments: true, amendment_applied: false, retrieval_status: 'نافذ_بتحذير', ...o });
const SEVENTH = [
  R6({ id: 'سابعة/1', article_no: 1, text: 'نصُّ المصدر للمادة الأولى قبل تحرير المراجع.',
    amendment_kind: 'تعديل فقرة', amendments_raw: 'تُعدَّل الفقرة (أ).' }),
  R6({ id: 'سابعة/2', article_no: 2, text: 'نصُّ المادة الثانية.', amendment_kind: 'إضافة مادة',
    amendments_raw: 'تُضاف مادةٌ جديدة.' }),
  R6({ id: 'سابعة/3', article_no: 3, text: 'نصُّ المادة الثالثة.', amendment_kind: 'تعديل فقرة',
    amendments_raw: 'تُعدَّل الفقرة (ب).' }),
];
await lib.upsertLegalChunks(env, lib.parseJsonl(SEVENTH.join('\n')).rows, { importId: 'imp-7a', actorId: 'مسؤول' });
await lib.reviewChunk(env, 'سابعة/1', 'edit', 'مراجعٌ أوّل', {
  text: 'نصُّ المادة الأولى بعد أن حرّره المراجع ودمج تعديلها.', note: 'دُمجت الفقرة (أ) يدوياً.',
});

await check('٢٥ · تحريرُ المراجع يبقى بإعادة رفع مصدرٍ لم يتغيّر، وقرارُه معه', async () => {
  const preview = await lib.diffChunks(env, lib.parseJsonl(SEVENTH.join('\n')).rows);
  assert.equal(preview.changed, 0, 'المقارنة تعدّ التحرير الباقي تغيّراً: ' + JSON.stringify(preview.changes.map((c) => c.id)));
  const before = q("SELECT embed_hash FROM legal_chunks WHERE id = 'سابعة/1'")[0].embed_hash;
  const res = await lib.upsertLegalChunks(env, lib.parseJsonl(SEVENTH.join('\n')).rows, { importId: 'imp-7b', actorId: 'مسؤول' });
  assert.equal(res.archived, 0, 'أُرشف التحرير كأنه أُزيح');
  const row = q("SELECT text, text_original_import, review_status, reviewed_by, review_note, embed_hash, text_versions FROM legal_chunks WHERE id = 'سابعة/1'")[0];
  assert.match(row.text, /بعد أن حرّره المراجع/, 'دفعةٌ لم يتغيّر مصدرُها دهست التحرير');
  assert.equal(row.text_original_import, 'نصُّ المصدر للمادة الأولى قبل تحرير المراجع.');
  assert.equal(row.review_status, 'edited');
  assert.equal(row.reviewed_by, 'مراجعٌ أوّل');
  assert.equal(row.review_note, 'دُمجت الفقرة (أ) يدوياً.');
  assert.equal(row.embed_hash, before, 'أُعيد تضمينُ ما لم يتغيّر');
  assert.equal(JSON.parse(row.text_versions).find((v) => v.current).text, row.text, 'الخطّ الزمني يكذّب النصّ الباقي');
});

await check('٢٥ · ومصدرٌ تغيّر يُعيدها إلى الطابور بأثر اعتمادها — لا مصفَّرة', async () => {
  const changed = SEVENTH.map((l, i) => (i === 0
    ? R6({ id: 'سابعة/1', article_no: 1, text: 'نصُّ المصدر للمادة الأولى بعد تعديلٍ ثانٍ صدر لاحقاً.',
        amendment_kind: 'تعديل فقرة', amendments_raw: 'تُعدَّل الفقرة (أ) ثم الفقرة (ج).' })
    : l));
  await lib.upsertLegalChunks(env, lib.parseJsonl(changed.join('\n')).rows, { importId: 'imp-7c', actorId: 'مسؤول الاستيراد' });
  const row = q("SELECT text, review_status, reviewed_by, prior_review_status, prior_reviewed_by, prior_review_text, prior_review_note FROM legal_chunks WHERE id = 'سابعة/1'")[0];
  assert.match(row.text, /تعديلٍ ثانٍ/);
  assert.equal(row.review_status, 'pending', 'نصٌّ جديد بقي معتمداً بقرارٍ على غيره');
  assert.equal(row.reviewed_by, null);
  assert.equal(row.prior_review_status, 'edited', 'سقط الاعتماد بلا أثر');
  assert.equal(row.prior_reviewed_by, 'مراجعٌ أوّل');
  assert.match(row.prior_review_text, /بعد أن حرّره المراجع/, 'النصّ الذي اعتُمد لم يُحفظ');
  assert.equal(row.prior_review_note, 'دُمجت الفقرة (أ) يدوياً.');
  const amendment = await lib.getChunkAmendment(env, 'سابعة/1');
  assert.equal(amendment.prior_review?.status, 'edited', 'نافذة المراجعة لا ترى الاعتماد السابق');
  assert.match(amendment.prior_review.text, /بعد أن حرّره المراجع/);
  // والمادة في الطابور ليراها المراجع — لم تُحجب ولم تُعتمد تلقائياً.
  const queue = await lib.listReviewQueue(env, { lawId: 'seventh', limit: 50 });
  assert.ok(ids(queue.articles).includes('سابعة/1'));
});

await check('٢٥ · وسقوطُ القرار يُقيَّد في سجلّ التدقيق بصاحب الدفعة', async () => {
  const trail = await lib.listReviewAudit(env, { chunkId: 'سابعة/1' });
  const reset = trail.find((e) => e.via === 'import');
  assert.ok(reset, 'سقوطُ الاعتماد بدفعةٍ لم يُقيَّد: ' + JSON.stringify(trail.map((e) => [e.field, e.via])));
  assert.equal(reset.field, 'review_status');
  assert.equal(reset.old_value, 'edited');
  assert.equal(reset.new_value, 'pending');
  assert.equal(reset.actor_id, 'مسؤول الاستيراد');
  // ودفعةٌ لم تُسقط قراراً لا تُقيِّد شيئاً.
  assert.equal(trail.filter((e) => e.via === 'import').length, 1, 'قُيِّد سقوطٌ لم يقع');
});

await check('٢٥ · مرشّحُ نوع التعديل حيٌّ من القاعدة، ويحصر الطابور', async () => {
  const kinds = await lib.listReviewKinds(env, { lawId: 'seventh' });
  const byKind = Object.fromEntries(kinds.map((k) => [k.kind, k.pending]));
  assert.equal(byKind['تعديل فقرة'], 2, JSON.stringify(kinds));
  assert.equal(byKind['إضافة مادة'], 1);
  const one = await lib.listReviewQueue(env, { lawId: 'seventh', amendmentKind: 'إضافة مادة', limit: 50 });
  assert.deepEqual(ids(one.articles), ['سابعة/2']);
  assert.equal(one.total, 1);
  const routes = readFileSync(path.join(ROOT, 'src', 'routes', 'legal.ts'), 'utf8');
  assert.match(routes, /app\.get\('\/review\/kinds', requireAdmin/, 'لا مسار لأنواع التعديل');
  assert.equal((routes.match(/amendmentKind: c\.req\.query\('amendment_kind'\)/g) ?? []).length, 3,
    'مرشّح النوع لا يصل الطابور واللوحة والتحديد الشامل معاً');
});

console.log('\nفحص عقد استيراد المحتوى النظامي — NAF-legal\n');
console.log(results.join('\n'));
console.log(
  process.exitCode
    ? '\nالعقد مخروق — راجِع ما فشل أعلاه.\n'
    : `\n${results.length} فحصاً مرّت — العقد سليم.\n`
);
