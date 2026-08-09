// استيراد ملف JSONL نظامي إلى المنصة على دفعات.
//
// الملف يُقسَّم إلى دفعات **بالأسطر** لا بالحجم: سطرٌ = مقطع، وقصّ الملف
// بالبايت يشقّ سطراً في منتصفه فتضيع مادة ويُرفض ما بعدها.
//
// والدفعات لا تُنفَّذ معاً: كل دفعة تنتظر تقريرها قبل التي تليها، ليتوقّف
// الاستيراد عند أول دفعة تُرفَض بدل أن تمضي بقيتها على خطأ متكرّر.
//
// التشغيل:
//   npm run import:legal -- --file laws.jsonl --url https://advisor.naflaw.sa --cookie "naf_session=…"
//
// الخيارات:
//   --file    مسار ملف JSONL (إلزامي)
//   --url     أصل المنصة (الافتراضي http://localhost:8787)
//   --cookie  كوكي جلسة مسؤول (أو متغيّر البيئة NAF_COOKIE)
//   --batch   عدد الأسطر في الدفعة (الافتراضي 500)
//   --partial قبول الأسطر الصالحة وتخطّي الفاسدة (الافتراضي: صارم)
//   --build-embed-text  بناء `embed_text` عند غيابه من اسم النظام ورقم المادة
//   --correction        وسمُ «تصحيح بيانات»: الفرق عن الاستيراد السابق خطأُ
//                       سحبٍ لا تعديلٌ نظاميّ، فلا يقول السجلّ إن النظام
//                       عُدِّل اليوم وهو عُدِّل بمرسومه قبل سنوات
//   --check-only        مقارنةٌ بلا كتابة: يُقال ما سيتغيّر ثم يقف
//   --no-preview        تخطّي المقارنة قبل الكتابة (لأتمتةٍ راجعت ملفَّها)
//   --prune             حذفُ اليتيم بعد آخر جزء: ما بقي في القاعدة من أنظمة
//                       هذه الدفعة ولم يرد فيها. ولا يقع بغيرها — الملف
//                       يُرفع مقسَّماً، وقياسُ الزائد على جزءٍ منه محوُ نظام
//                       لا تنظيفُ أثر. وبلا `--prune` تُعرض الأيتام ولا تُحذف
//
// وهاتان مطفأتان هنا وإن كانتا مفعَّلتين في شاشة الإدارة: أمرٌ في طرفية
// يُكتب مرّة ويُعاد ألف مرّة في أتمتة، فتغييرُ افتراضه يغيّر ما لا يُراجَع.
// و«تصحيح بيانات» مطفأةٌ في الموضعين: هي إقرارٌ على ما وقع لا تسهيل.

import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (!next || next.startsWith('--')) args.set(key, 'true');
  else {
    args.set(key, next);
    i++;
  }
}

const file = args.get('file');
if (!file) {
  console.error('المطلوب: --file <ملف JSONL>');
  process.exit(1);
}

const origin = (args.get('url') ?? 'http://localhost:8787').replace(/\/$/, '');
const cookie = args.get('cookie') ?? process.env.NAF_COOKIE ?? '';
const batchSize = Math.max(1, Number(args.get('batch') ?? 500));
const partial = args.has('partial');
const buildEmbedText = args.has('build-embed-text');
const correction = args.has('correction');
const prune = args.has('prune');
const checkOnly = args.has('check-only');
const preview = !args.has('no-preview');
// معرّفٌ يجمع أجزاء الملف الواحد. بلا هذا لا تُعرف الدفعة التامّة عند الختام.
const batchId = randomUUID();

if (!cookie) {
  console.error('المطلوب: --cookie "naf_session=…" أو متغيّر البيئة NAF_COOKIE');
  process.exit(1);
}

const raw = await readFile(file, 'utf8');
// BOM يُسقَط هنا أيضاً: العقد يشترط UTF-8 بلا BOM، والمنصة تُسقطه وتُنبّه —
// وإسقاطه قبل الإرسال يجعل التنبيه يظهر مرّة لا مرّةً لكل دفعة.
const lines = raw.replace(/^﻿/, '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());

if (!lines.length) {
  console.error('لا سطور في الملف');
  process.exit(1);
}

// بصمة الملف تُرسل مع كل جزء وتُحفظ في سجلّ الدفعات: بها يُعرف أيُّ ملفٍ
// أنتج ما في القاعدة، وتُطابَق ببصمة المُرسِل.
const sha256 = createHash('sha256').update(raw).digest('hex');

const endpoint = `${origin}/api/legal/import?${new URLSearchParams({
  filename: path.basename(file),
  batch: batchId,
  sha256,
  ...(partial ? { partial: '1' } : {}),
  ...(buildEmbedText ? { build_embed_text: '1' } : {}),
  ...(correction ? { correction: '1' } : {}),
})}`;

console.log(`الملف: ${file}`);
console.log(
  `الأسطر: ${lines.length} · الدفعة: ${batchSize} سطراً · الوضع: ${partial ? 'قبول الصالح' : 'صارم'}` +
    (buildEmbedText ? ' · بناء نصّ التضمين عند غيابه' : '') +
    (correction ? ' · تصحيح بيانات' : '')
);
console.log(`بصمة الملف: ${sha256}`);
console.log(`الوجهة: ${endpoint}\n`);

/**
 * المقارنة قبل الكتابة — الخطوة الأرخص وأنفعُ من أيّ تراجع.
 *
 * التراجع يُصلح بعد أن يقع، والمقارنة تمنع الوقوع: ملفٌّ ينقصه نصفُ نظام
 * يظهر هنا «٢٥٠٠ غائبة» قبل أن يُكتب حرفٌ واحد. وهي تجري على الملف كلِّه لا
 * على جزئه الأوّل — نصفُ ملفٍ لا يُقاس عليه غيابُ شيء.
 */
async function comparefirst() {
  const res = await fetch(`${endpoint}&dry_run=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson', cookie },
    body: lines.join('\n'),
  });
  const r = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`\nالمقارنة رُفضت (${res.status}): ${r.error ?? ''}`);
    for (const g of r.error_summary ?? []) console.error(`  ${g.count} سطراً: ${g.error}`);
    process.exit(1);
  }
  const d = r.diff ?? {};
  console.log('── المقارنة قبل الكتابة ──');
  console.log(`جديد ${d.added ?? 0} · متغيّر ${d.changed ?? 0} · بلا تغيير ${d.unchanged ?? 0} · غائب عن الملف ${d.missing ?? 0}`);
  if (r.needs_review) console.log(`${r.needs_review} مادةً موسومة للمراجعة`);
  if (r.amendment_pending) console.log(`${r.amendment_pending} مادةً نصُّها أصليّ وعليها تعديل`);
  // الغائب يُقال بصوتٍ عالٍ: هو العلامة الوحيدة على ملفٍ ناقص قبل أن يُكتب.
  if (d.missing) {
    console.log(`\nتنبيه: ${d.missing} مادةً في القاعدة لأنظمة هذا الملف ولا وجود لها فيه.`);
    console.log('  إن كان الملف تامّاً فهذا ما حُذف من المصدر — يُعالَج بـ--prune عند الختام.');
    console.log('  وإن كان جزئياً فأنت على وشك رفعِ نصفِ نظام.');
  }
  console.log('');
  return d;
}

const totals = { inserted: 0, updated: 0, failed: 0, pending: 0, withheld: 0, amendmentPending: 0, superseded: 0 };

if (preview || checkOnly) {
  await comparefirst();
  if (checkOnly) {
    console.log('مقارنةٌ بلا كتابة — لم يُكتب شيء.');
    process.exit(0);
  }
}

for (let start = 0; start < lines.length; start += batchSize) {
  const slice = lines.slice(start, start + batchSize);
  const no = Math.floor(start / batchSize) + 1;
  const of = Math.ceil(lines.length / batchSize);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson', cookie },
    body: slice.join('\n'),
  });

  let report;
  try {
    report = await res.json();
  } catch {
    console.error(`الدفعة ${no}/${of}: ردٌّ غير مفهوم (${res.status})`);
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`\nالدفعة ${no}/${of} رُفضت (${res.status}): ${report.error ?? ''}`);
    // الأسباب مجموعةً أولاً: ملفٌّ مولَّد بقالب واحد تفشل أسطره بالسبب نفسه،
    // وطباعةُ خمسين رسالة متطابقة تُخفي ما تقوله واحدة.
    for (const g of report.error_summary ?? []) {
      const lines = g.lines?.length ? ` (أسطر: ${g.lines.join(' · ')}…)` : '';
      console.error(`  ${g.count} سطراً: ${g.error}${lines}`);
      if (g.keys?.length) console.error(`    الحقول الموجودة في هذه الأسطر: ${g.keys.join(' · ')}`);
    }
    process.exit(1);
  }

  totals.inserted += report.inserted ?? 0;
  totals.updated += report.updated ?? 0;
  totals.failed += report.failed ?? 0;
  totals.pending = report.pending_embeddings ?? totals.pending;
  totals.withheld += report.needs_review ?? 0;
  totals.amendmentPending += report.amendment_pending ?? 0;
  totals.superseded += report.superseded ?? 0;
  for (const w of report.warnings ?? []) console.log(`  تنبيه: ${w}`);
  if (report.embed_text_truncated) {
    console.log(`  ${report.embed_text_truncated} مقطعاً قُصَّ مدخل متجهه (النصّ المعروض كامل)`);
  }
  console.log(`الدفعة ${no}/${of}: جديد ${report.inserted} · مستبدَل ${report.updated} · مرفوض ${report.failed}`);
}

console.log(
  `\nاكتمل: جديد ${totals.inserted} · مستبدَل ${totals.updated} · مرفوض ${totals.failed} · ينتظر التضمين ${totals.pending}`
);
// ما حُجب وما سيُعرض بتنبيه يُقالان: ملفٌّ نصفُ مواده محجوب يبدو مستورَداً
// تامّاً في السطر الأخير، ثم لا يجد المحامي أثره في البحث ولا يعرف لماذا.
if (totals.withheld) {
  console.log(`${totals.withheld} مادةً بانتظار المراجعة — محجوبة عن الاسترجاع حتى تُعتمد في شاشة مراجعة المواد`);
}
if (totals.amendmentPending) {
  console.log(`${totals.amendmentPending} مادةً عُدِّلت ونصُّها المعروض أصليّ — تُعرض مع تنبيهها`);
}
if (totals.superseded) {
  console.log(`${totals.superseded} نصّاً سابقاً دخل سجلّ التحديث بتاريخ تعديله`);
}
if (totals.pending) {
  console.log('التضمين المتبقّي يصرّفه الـCron الليلي، أو: POST /api/legal/embed-pending');
}

// ── ختام الدفعة: اليتيم ──
// `upsert` تُحدّث وتُضيف ولا تحذف ما اختفى، فمادةٌ أُسقطت من المصدر تبقى في
// النتائج إلى الأبد. والقياس هنا على الدفعة تامّةً — بعد آخر جزء — وعلى
// أنظمتها وحدها.
const finalize = async (apply) =>
  fetch(`${origin}/api/legal/finalize?${new URLSearchParams({ batch: batchId, ...(apply ? { apply: '1' } : {}) })}`, {
    method: 'POST',
    headers: { cookie },
  }).then((r) => r.json());

try {
  const seen = await finalize(false);
  if (!seen.orphans?.length) {
    console.log('\nلا يتيم: كلُّ ما في القاعدة من أنظمة هذه الدفعة ورد فيها.');
  } else {
    console.log(`\n${seen.count} مادةً في القاعدة لم ترد في هذه الدفعة:`);
    for (const o of seen.orphans.slice(0, 20)) {
      console.log(`  ${o.id}${o.was_edited ? '  (حُرِّرت بشرياً)' : ''}${o.review_status !== 'pending' ? `  (${o.review_status})` : ''}`);
    }
    if (seen.orphans.length > 20) console.log(`  … و${seen.orphans.length - 20} غيرها`);

    if (!prune) {
      console.log('لم تُحذف. لحذفها — السجلّ ومتجهه — أعِد التشغيل مع --prune');
    } else {
      const done = await finalize(true);
      console.log(`حُذف ${done.deleted}. ونصُّ كلٍّ محفوظٌ في سجلّ التحديث قبل ذهابه.`);
    }
  }
} catch (e) {
  console.error(`\nتعذّر ختام الدفعة: ${String(e?.message ?? e)}`);
  console.error('الاستيراد وقع، ولم يُقَس اليتيم. أعِد المحاولة بـ: POST /api/legal/finalize?batch=' + batchId);
}
