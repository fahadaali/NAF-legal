// فحصُ ملف الدفعة قبل رفعه — وطباعةُ ما تُقارَن به القاعدة بعده.
//
// **لا يكتب شيئاً ولا يتّصل بشيء.** يقرأ الملف، ويفحص تماسكه بشروطه، ويطبع
// بصمته وأرقامه. وإن أخفق شرطٌ خرج بالرمز 1 — فلا يُرفع ملفٌّ لم يُفحص.
//
// والشروط تسعةٌ من وثيقة الاستيراد، وزِيد عليها اثنان من إصدارها السادس: ختمُ
// الحالة، وصيغةُ التاريخين اللذين يُقارَنان بتاريخ الخادم. «صالح للرفع» من
// فحص البنية وحده لا يعني صحّة الحالات — فملفٌّ فاته الختم كان يجتازه.
//
// التشغيل:
//   npm run verify:legal -- --file ./data/all-articles.jsonl
//   node scripts/verify-legal.mjs --file ./data/all-articles.jsonl --samples 5
//
// والأرقام المطبوعة هي مرجع قائمة التحقّق بعد الرفع: عددُ السجلات
// والمعرّفات الفريدة والأنظمة وما يُفهرَس وتوزيعُ الحالات. لا تُكتب في
// وثيقةٍ دائمة — رقمٌ مكتوب يتقادم مع أوّل دفعة، فيُقارَن به ويُظَنّ
// الاستيراد ناقصاً.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (!next || next.startsWith('--')) args.set(a.slice(2), 'true');
  else { args.set(a.slice(2), next); i++; }
}

const file = args.get('file');
if (!file) {
  console.error('الاستعمال: node scripts/verify-legal.mjs --file <ملف.jsonl> [--samples 3]');
  process.exit(2);
}
const SAMPLES = Number(args.get('samples') ?? 3);

const buf = await readFile(file);
const sha = createHash('sha256').update(buf).digest('hex');
let content = buf.toString('utf8');
const hadBom = content.charCodeAt(0) === 0xfeff;
if (hadBom) content = content.slice(1);

// ── القراءة ──
const rows = [];
const failures = [];
const lines = content.split(/\r?\n/);
lines.forEach((raw, i) => {
  const line = raw.trim();
  if (!line) return;
  try {
    const o = JSON.parse(line);
    if (o && typeof o === 'object' && !Array.isArray(o)) rows.push({ n: i + 1, o });
    else failures.push({ n: i + 1, why: 'السطر ليس كائن JSON' });
  } catch (e) {
    failures.push({ n: i + 1, why: `JSON غير صالح: ${String(e.message).slice(0, 80)}` });
  }
});

// ── الشروط ──
// كلُّ شرطٍ يجمع مخالفاته بأرقام أسطرها: «فشل الشرط» بلا موضعٍ يتركك تبحث
// في مئة ألف سطر عمّا لم يُقَل لك.
const RETRIEVAL = new Set(['نافذ', 'نافذ_بتحذير', 'ملغى']);
const REQUIRED = [
  'id', 'law_id', 'law_name', 'doc_type', 'article_no', 'article_label',
  'text', 'embed_text', 'retrieval_status', 'text_versions', 'amendment_events',
  'has_amendments', 'is_repealed', 'needs_review',
];

const conditions = [];
const cond = (name, bad, note) => conditions.push({ name, bad, note });

cond('كل سطر كائن JSON مستقلّ، والملف بلا BOM',
  failures.map((f) => `سطر ${f.n}: ${f.why}`).concat(hadBom ? ['الملف يبدأ بعلامة BOM'] : []));

const missing = [];
for (const { n, o } of rows) {
  const gone = REQUIRED.filter((k) => o[k] === undefined || o[k] === null || o[k] === '');
  if (gone.length) missing.push(`سطر ${n} (${o.id ?? '—'}): ${gone.join('، ')}`);
}
cond('الحقول الإلزامية حاضرة في كل سجلّ', missing);

const seen = new Map();
const dupIds = [];
for (const { n, o } of rows) {
  const id = String(o.id ?? '');
  if (seen.has(id)) dupIds.push(`«${id}» في السطرين ${seen.get(id)} و${n}`);
  else seen.set(id, n);
}
cond('المعرّفات فريدة داخل الملف', dupIds);

cond('`retrieval_status` من الثلاث المسجَّلة',
  rows.filter(({ o }) => o.retrieval_status && !RETRIEVAL.has(String(o.retrieval_status)))
      .map(({ n, o }) => `سطر ${n}: «${o.retrieval_status}»`));

// الإلغاء في الإصدار السادس ثلاثة أسباب لا سبب: المادة أو بابها (`is_repealed`)،
// والنظام كلُّه (`law_repealed`) إلا المستبقاة، والإلغاء المجدول بعد يومه. فمادةٌ من
// نظامٍ لاغٍ حالُها «ملغى» و`is_repealed` فيها `false` — وليس ذلك تناقضاً. وكان
// الشرط يقابل الحال بـ`is_repealed` وحده فيرفض كل مادةٍ من نظامٍ لاغٍ.
//
// والتناقض ما تقول الوثيقة عكسه صراحةً: مادةٌ ملغاة بنفسها وحالُها غير «ملغى»،
// ومستبقاةٌ حالُها «ملغى»، ومادةٌ من نظامٍ لاغٍ غيرُ مستبقاة وحالُها غير «ملغى».
// وملفّات ما قبل البطاقة تُقابَل كما كانت.
const lawCard = (o) => ['law_status_source', 'status_raw', 'law_repealed', 'kept_after_repeal', 'law_pending']
  .some((k) => o[k] !== undefined && o[k] !== null && o[k] !== '');
const statusBad = [];
for (const { n, o } of rows) {
  const repealed = o.retrieval_status === 'ملغى';
  if (!lawCard(o)) {
    if (repealed !== !!o.is_repealed) statusBad.push(`سطر ${n} (${o.id}): ${o.retrieval_status} مع is_repealed=${!!o.is_repealed}`);
    continue;
  }
  if (o.is_repealed && !repealed) statusBad.push(`سطر ${n} (${o.id}): المادة ملغاة بنفسها وحالُها ${o.retrieval_status}`);
  if (o.kept_after_repeal && repealed) statusBad.push(`سطر ${n} (${o.id}): مستبقاةٌ بعد إلغاء نظامها وحالُها «ملغى»`);
  if (o.law_repealed && !o.kept_after_repeal && !repealed) {
    statusBad.push(`سطر ${n} (${o.id}): من نظامٍ لاغٍ وليست مستبقاة وحالُها ${o.retrieval_status}`);
  }
}
cond('الحالة والإلغاء لا يتناقضان', statusBad);

const versionBad = [];
for (const { n, o } of rows) {
  const v = o.text_versions;
  if (!Array.isArray(v)) { versionBad.push(`سطر ${n} (${o.id}): ليست مصفوفة`); continue; }
  const current = v.filter((x) => x && x.current);
  if (current.length !== 1) { versionBad.push(`سطر ${n} (${o.id}): ${current.length} نسخة معتمدة`); continue; }
  if (String(current[0].text ?? '').trim() !== String(o.text ?? '').trim()) {
    versionBad.push(`سطر ${n} (${o.id}): النسخة المعتمدة تخالف \`text\``);
  }
}
cond('`text_versions`: نسخةٌ معتمدة واحدة نصُّها مطابق لـ`text`', versionBad);

const eventBad = [];
for (const { n, o } of rows) {
  const ev = o.amendment_events;
  if (!Array.isArray(ev)) { eventBad.push(`سطر ${n} (${o.id}): ليست مصفوفة`); continue; }
  ev.forEach((e, i) => {
    if (e && !e.applied && !String(e.reason ?? '').trim()) {
      eventBad.push(`سطر ${n} (${o.id}): الحدث ${i + 1} لم يُطبَّق بلا سبب`);
    }
  });
}
cond('كل حدث لم يُطبَّق معه سببه', eventBad);

cond('وجودُ أحداثٍ يوجب `has_amendments`',
  rows.filter(({ o }) => Array.isArray(o.amendment_events) && o.amendment_events.length && !o.has_amendments)
      .map(({ n, o }) => `سطر ${n} (${o.id})`));

const dupBad = [];
for (const { n, o } of rows) {
  const has = ['is_duplicate', 'duplicate_of', 'duplicate_index'].filter((k) => o[k] !== undefined && o[k] !== null);
  if (!o.is_duplicate) {
    // الغياب يُقرأ «ليست مكرّرة» — لا خطأً ولا قيمةً مجهولة.
    if (has.length && has.length !== 3 && o.duplicate_of) dupBad.push(`سطر ${n} (${o.id}): وسمٌ ناقص`);
    continue;
  }
  if (has.length !== 3) dupBad.push(`سطر ${n} (${o.id}): الثلاثة لا تجتمع`);
  else if (!seen.has(String(o.duplicate_of)) && !rows.some(({ o: x }) => x.duplicate_of === o.duplicate_of && x.id !== o.id)) {
    dupBad.push(`سطر ${n} (${o.id}): «${o.duplicate_of}» بلا أخت في الملف`);
  }
}
cond('حقول التكرار الثلاثة تجتمع أو تغيب معاً', dupBad);

// ختمُ الحالة: آخرُ خطوةٍ في سلسلة المُرسِل، وعلامتُه في الملف `law_status_source`
// (§2-1). ملفٌّ فاته يجتاز البنية ولا تصحّ حالاتُه: مادةٌ من نظامٍ لاغٍ قد تصل
// «نافذ» ومادةُ نظامٍ لم يبدأ العمل به بلا تحذير. والمنصة تقبله إن رُفع — ملفّات
// ما قبل الإصدار الرابع لا ختم فيها — لكنّ هذا الفحص يقول إنه لا يُرسَل.
const unstamped = rows.filter(({ o }) => !o.law_status_source);
cond('كل سجلٍّ يحمل ختم الحالة (`law_status_source`)',
  unstamped.map(({ n, o }) => `سطر ${n} (${o.id ?? '—'})`));

// والتاريخان اللذان يُقارَنان بتاريخ الخادم ميلاديّان `YYYY-MM-DD` لا غير: المقارنة
// نصّية، و`1448/01/01` أصغرُ نصّاً من كل تاريخٍ ميلاديّ فتُلغى المادة في غير
// يومها. والمنصة ترفض السطر بهما — وهذا يقوله قبل الرفع.
const ISO = /^\d{4}-\d{2}-\d{2}$/;
cond('`law_effective_from` و`scheduled_repeal_from` ميلاديّان `YYYY-MM-DD`',
  rows.flatMap(({ n, o }) => ['law_effective_from', 'scheduled_repeal_from']
    .filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '' && !ISO.test(String(o[k])))
    .map((k) => `سطر ${n} (${o.id}): ${k} = «${o[k]}»`)));

// ── الأرقام ──
const laws = new Map();
const byStatus = new Map();
for (const { o } of rows) {
  const law = String(o.law_id ?? '—');
  if (!laws.has(law)) laws.set(law, { name: o.law_name ?? o.law_title ?? law, n: 0 });
  laws.get(law).n++;
  const st = String(o.retrieval_status ?? '—');
  byStatus.set(st, (byStatus.get(st) ?? 0) + 1);
}
const indexed = rows.filter(({ o }) => o.retrieval_status !== 'ملغى').length;
// حالُ النظام من بطاقته، وأصنافُ السجلات التي أضافها الإصدار السادس — تُقابَل
// بما تُظهره الشاشة بعد الرفع.
const byLawStatus = new Map();
for (const { o } of rows) {
  const st = String(o.status ?? '—');
  byLawStatus.set(st, (byLawStatus.get(st) ?? 0) + 1);
}
const isAnnex = (o) => !!o.is_annex || /\/annex-\d+$/.test(String(o.id ?? ''));
const isAttachment = (o) => !!o.is_attachment || /-attach\d*$/.test(String(o.id ?? ''));
const isMukarrar = (o) => /-mukarrar\d*(?:--dup\d+)?$/.test(String(o.id ?? ''));
const kinds = [
  ['ملاحق', (o) => isAnnex(o)],
  ['مرفقات', (o) => isAttachment(o)],
  ['مواد «مكرر»', (o) => isMukarrar(o)],
  ['مواد منقولة', (o) => o.former_article_no !== undefined && o.former_article_no !== null && o.former_article_no !== ''],
  ['من نظامٍ لاغٍ', (o) => !!o.law_repealed],
  ['مستبقاة بعد إلغاء نظامها', (o) => !!o.kept_after_repeal],
  ['من نظامٍ لم يبدأ العمل به', (o) => !!o.law_pending],
  ['مجدولٌ إلغاؤها', (o) => !!o.scheduled_repeal_from],
];

const nf = new Intl.NumberFormat('en-US');
const failed = conditions.filter((c) => c.bad.length);

console.log('══ ملفّ الدفعة ══');
console.log(`الملف        ${file}`);
console.log(`بصمة SHA-256 ${sha}`);
console.log('             طابِقها ببصمة المُرسِل قبل الرفع.\n');

console.log(`══ الشروط (${nf.format(conditions.length)}) ══`);
for (const c of conditions) {
  console.log(`${c.bad.length ? '✗' : '✓'} ${c.name}${c.bad.length ? ` — ${nf.format(c.bad.length)} مخالفة` : ''}`);
  for (const b of c.bad.slice(0, 10)) console.log(`    ${b}`);
  if (c.bad.length > 10) console.log(`    … و${nf.format(c.bad.length - 10)} غيرها`);
}

console.log('\n══ الأرقام — تُقارَن بالقاعدة بعد الرفع ══');
console.log(`السجلات         ${nf.format(rows.length)}`);
console.log(`معرّفات فريدة   ${nf.format(seen.size)}`);
console.log(`الأنظمة          ${nf.format(laws.size)}`);
console.log(`تُفهرَس          ${nf.format(indexed)}   (كلُّ ما ليس «ملغى»)`);
console.log('توزيع الحالات:');
for (const [st, n] of [...byStatus].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${st.padEnd(16)} ${nf.format(n)}`);
}
console.log('حالُ الأنظمة من بطاقاتها (موادّ):');
for (const [st, n] of [...byLawStatus].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${st.padEnd(24)} ${nf.format(n)}`);
}
console.log('أصنافٌ تُتحقَّق في الشاشة:');
for (const [label, test] of kinds) {
  console.log(`  ${label.padEnd(26)} ${nf.format(rows.filter(({ o }) => test(o)).length)}`);
}
console.log(`بلا ختم الحالة  ${nf.format(unstamped.length)}`);

console.log('\nالأنظمة:');
for (const [id, l] of [...laws].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${String(l.name).slice(0, 40).padEnd(42)} ${nf.format(l.n)}   (${id})`);
}

// عيّناتٌ تُفتح يدوياً بعد الرفع: عددُ نسخها وأحداثها وحالتها تُقابَل بما
// يظهر في الشاشة. رقمٌ مطبوع بلا عيّنة يقول إن العدد صحيح ولا يقول إن
// المحتوى وصل.
const withHistory = rows.filter(({ o }) => Array.isArray(o.text_versions) && o.text_versions.length > 1);
console.log('\nعيّنات للفتح اليدوي:');
for (const { o } of withHistory.slice(0, SAMPLES)) {
  console.log(`  ${o.id}`);
  console.log(`      نسخ: ${o.text_versions.length} · أحداث: ${(o.amendment_events ?? []).length} · ${o.retrieval_status}`);
}
if (!withHistory.length) console.log('  (لا مادة لها أكثر من نسخة في هذه الدفعة)');

// ولكل صنفٍ من أصناف الإصدار السادس عيّنةٌ تُفتح: قائمة التحقّق بعد الرفع تسأل
// عن كلٍّ منها بعينه (§8) — الملحق بعنوانه بلا رقمه، والمرفق تحت مادته، والمنقولة
// برقميها، ونظامان باسمٍ واحد منفصلَين.
console.log('\nعيّناتٌ لقائمة التحقّق:');
for (const [label, test] of kinds) {
  const hit = rows.find(({ o }) => test(o));
  if (hit) console.log(`  ${label.padEnd(26)} ${hit.o.id}${hit.o.former_article_no ? `   (السابق ${hit.o.former_article_no})` : ''}`);
}
const titles = new Map();
for (const { o } of rows) {
  const t = String(o.law_name ?? o.law_title ?? '');
  if (!t) continue;
  if (!titles.has(t)) titles.set(t, new Set());
  titles.get(t).add(String(o.law_id ?? ''));
}
const twins = [...titles].filter(([, set]) => set.size > 1);
for (const [t, set] of twins.slice(0, 3)) {
  console.log(`  ${'نظامان باسمٍ واحد'.padEnd(26)} «${t}»: ${[...set].join(' · ')}`);
}

if (failed.length) {
  console.log(`\n✗ أخفق ${nf.format(failed.length)} من ${nf.format(conditions.length)} شروط — لا يُرفع الملف.`);
  process.exit(1);
}
console.log(`\n✓ الشروط كلُّها مرّت (${nf.format(conditions.length)}) — الملف صالح للرفع.`);
