// قياسُ الاسترجاع على مجموعة القضايا — على المنصة المنشورة لا على نسخةٍ محلية.
//
//   node scripts/eval-retrieval.mjs --url https://advisor.naflaw.sa --cookie "naf_session=…"
//        [--cases eval/cases.jsonl] [--only labor-01,comm-02] [--out eval-result.json]
//
// لكل قضية يُرسَل سؤالها إلى `POST /api/eval/retrieve` (خطّ الاسترجاع نفسه في دور
// المحادثة، دون توليد)، ثم يُقاس ما رجع:
//
//   تغطية الأنظمة   نسبةُ الأنظمة «المطلوبة» التي رجعت منها مادةٌ واحدة على الأقل
//   تغطية الطبقات   نسبةُ الطبقات المطلوبة (موضوعي، إجرائي، إثبات…) التي غُطّيت
//   استدعاء المواد  نسبةُ المواد المتوقَّعة بثقةٍ «عالية» التي رجعت بعينها
//
// والمطابقة بعنوان النظام بعد التطبيع العربي — فالأرقام تُقاس قبل أن يعتمد المحامون
// أرقام المواد. والقضايا الموسومة `draft-unverified` مسودّةٌ لم يراجعها محامٍ: تقيس
// اتجاه التحسّن، ولا يُبنى على أرقامها حكمٌ قبل اعتمادها.
import { readFile, writeFile } from 'node:fs/promises';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
if (!args.url || !args.cookie) {
  console.error('الاستعمال: node scripts/eval-retrieval.mjs --url <عنوان المنصة> --cookie "<ملف تعريف الجلسة>"');
  process.exit(2);
}
const base = args.url.replace(/\/$/, '');
const only = args.only ? new Set(args.only.split(',')) : null;
const cases = (await readFile(args.cases ?? 'eval/cases.jsonl', 'utf8'))
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))
  .filter((c) => !only || only.has(c.id));

/** التطبيع نفسه في `src/lib/arabic.ts`: الهمزات والتاء المربوطة والألف المقصورة والتشكيل. */
const norm = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    .replace(/[ً-ْٓ-ٰٕۖ-ۭ]/g, '')
    .replace(/ـ/g, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();

/** عنوانٌ يطابق المتوقَّع: مساوياً له، أو مبدوءاً به ثم فاصل («نظام العمل الصادر…»). */
const sameLaw = (title, expected) => {
  const a = norm(title);
  const b = norm(expected);
  return a === b || a.startsWith(`${b} `);
};

const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);

const rows = [];
for (const c of cases) {
  const res = await fetch(`${base}/api/eval/retrieve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: args.cookie },
    body: JSON.stringify({ message: c.message, consultation_type: c.consultation_type }),
  });
  if (!res.ok) {
    console.error(`${c.id}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    rows.push({ id: c.id, error: res.status });
    continue;
  }
  const out = await res.json();
  const titles = out.results.map((r) => r.law_title);
  const required = c.expected_laws.filter((l) => l.required);
  const lawsHit = required.filter((l) => titles.some((t) => sameLaw(t, l.title)));
  const layers = [...new Set(required.map((l) => l.layer))];
  const layersHit = layers.filter((layer) =>
    required.filter((l) => l.layer === layer).some((l) => titles.some((t) => sameLaw(t, l.title)))
  );
  const sure = (c.expected_articles ?? []).filter((a) => a.confidence === 'high');
  const articlesHit = sure.filter((a) =>
    out.results.some((r) => sameLaw(r.law_title, a.law) && String(r.article_no ?? '') === String(a.article))
  );
  rows.push({
    id: c.id,
    laws: pct(lawsHit.length, required.length),
    layers: pct(layersHit.length, layers.length),
    articles: pct(articlesHit.length, sure.length),
    missing: required.filter((l) => !lawsHit.includes(l)).map((l) => `${l.layer}: ${l.title}`),
    results: out.results.length,
    failed: out.failed,
    ms: out.ms,
    queries: out.queries,
    got: out.results.map((r) => `${r.law_title} ${r.article_ref ?? ''}`.trim()),
  });
  const r = rows[rows.length - 1];
  console.log(
    `${c.id.padEnd(10)} أنظمة ${String(r.laws ?? '—').padStart(3)}%  طبقات ${String(r.layers ?? '—').padStart(3)}%  ` +
      `مواد ${String(r.articles ?? '—').padStart(3)}%  ${r.failed ? 'تعطّل جزئي' : ''}${r.missing.length ? `  ناقص: ${r.missing.join(' · ')}` : ''}`
  );
}

const ok = rows.filter((r) => !r.error);
const avg = (k) => {
  const v = ok.map((r) => r[k]).filter((x) => x != null);
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
};
const summary = {
  cases: rows.length,
  errors: rows.length - ok.length,
  laws: avg('laws'),
  layers: avg('layers'),
  articles: avg('articles'),
  degraded: ok.filter((r) => r.failed).length,
  median_ms: ok.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(ok.length / 2)] ?? null,
};
console.log(
  `\nالمتوسط — تغطية الأنظمة ${summary.laws}% · تغطية الطبقات ${summary.layers}% · استدعاء المواد ${summary.articles}%` +
    ` · أدوارٌ تعطّل فيها مسار ${summary.degraded} · أخطاء ${summary.errors} · الوسيط ${summary.median_ms}ms`
);
if (args.out) await writeFile(args.out, JSON.stringify({ summary, rows }, null, 2));
