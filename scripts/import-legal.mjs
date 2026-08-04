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
//
// وهاتان مطفأتان هنا وإن كانتا مفعَّلتين في شاشة الإدارة: أمرٌ في طرفية
// يُكتب مرّة ويُعاد ألف مرّة في أتمتة، فتغييرُ افتراضه يغيّر ما لا يُراجَع.

import { readFile } from 'node:fs/promises';
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

const endpoint = `${origin}/api/legal/import?${new URLSearchParams({
  filename: path.basename(file),
  ...(partial ? { partial: '1' } : {}),
  ...(buildEmbedText ? { build_embed_text: '1' } : {}),
})}`;

console.log(`الملف: ${file}`);
console.log(
  `الأسطر: ${lines.length} · الدفعة: ${batchSize} سطراً · الوضع: ${partial ? 'قبول الصالح' : 'صارم'}` +
    (buildEmbedText ? ' · بناء نصّ التضمين عند غيابه' : '')
);
console.log(`الوجهة: ${endpoint}\n`);

const totals = { inserted: 0, updated: 0, failed: 0, pending: 0 };

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
  for (const w of report.warnings ?? []) console.log(`  تنبيه: ${w}`);
  if (report.embed_text_truncated) {
    console.log(`  ${report.embed_text_truncated} مقطعاً قُصَّ مدخل متجهه (النصّ المعروض كامل)`);
  }
  console.log(`الدفعة ${no}/${of}: جديد ${report.inserted} · مستبدَل ${report.updated} · مرفوض ${report.failed}`);
}

console.log(
  `\nاكتمل: جديد ${totals.inserted} · مستبدَل ${totals.updated} · مرفوض ${totals.failed} · ينتظر التضمين ${totals.pending}`
);
if (totals.pending) {
  console.log('التضمين المتبقّي يصرّفه الـCron الليلي، أو: POST /api/legal/embed-pending');
}
