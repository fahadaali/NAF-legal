// استيراد ملف المبادئ القضائية (`principles.jsonl` من مشروع nezam) إلى المنصة.
//
// الملف يُجمع في المنصة على أجزاء بالأسطر، ثم يُكتب في عبارةٍ واحدة تستبدل
// مدوّناته: فإمّا الجديد كاملاً وإمّا القديم كما كان (`docs/legal-import.md` §١٦).
// وجزءٌ يُرفض يوقف الاستيراد ويُسقط ما جُمع قبله.
//
// التشغيل:
//   npm run import:principles -- --file principles.jsonl --url https://advisor.naflaw.sa --cookie "naf_session=…"
//
// الخيارات:
//   --file    مسار الملف (إلزامي)
//   --url     أصل المنصة (الافتراضي http://localhost:8787)
//   --cookie  كوكي جلسة مسؤول (أو متغيّر البيئة NAF_COOKIE)
//   --batch   عدد الأسطر في الجزء (الافتراضي 200)
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (!next || next.startsWith('--')) args.set(a.slice(2), 'true');
  else {
    args.set(a.slice(2), next);
    i++;
  }
}

const file = args.get('file');
if (!file) {
  console.error('المطلوب: --file <principles.jsonl>');
  process.exit(1);
}
const origin = (args.get('url') ?? 'http://localhost:8787').replace(/\/$/, '');
const cookie = args.get('cookie') ?? process.env.NAF_COOKIE ?? '';
const batch = Math.max(1, Number(args.get('batch') ?? 200));

const raw = await readFile(file);
const sha = createHash('sha256').update(raw).digest('hex');
const lines = raw.toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
const filled = lines.filter((l) => l.trim()).length;
const importId = randomUUID();
console.log(`الملف: ${file}\nSHA-256: ${sha}\nالأسطر: ${filled}\nمعرّف الاستيراد: ${importId}\n`);

const headers = { accept: 'application/json', cookie };

async function abort() {
  await fetch(`${origin}/api/principles/abort`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ import_id: importId }),
  }).catch(() => {});
}

let staged = 0;
for (let i = 0; i < lines.length; i += batch) {
  const part = lines.slice(i, i + batch).join('\n');
  if (!part.trim()) continue;
  const res = await fetch(`${origin}/api/principles/stage?import_id=${importId}&first_line=${i + 1}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/x-ndjson' },
    body: part,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`رُفض الجزء الذي يبدأ بالسطر ${i + 1} (${res.status}): ${body.error ?? ''}`);
    for (const e of body.errors ?? []) console.error(`  السطر ${e.line}: ${e.error}`);
    await abort();
    console.error('أُلغي الاستيراد، ولم يُكتب شيء.');
    process.exit(1);
  }
  staged += body.staged;
  console.log(`جُمع ${staged} من ${filled}`);
}

const res = await fetch(`${origin}/api/principles/commit`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ import_id: importId }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`تعذّرت الكتابة (${res.status}): ${body.error ?? ''}`);
  await abort();
  process.exit(1);
}
console.log(`\nكُتب: ${body.written} · استُبدل: ${body.replaced}\nالمدوّنات: ${body.collections.join('، ')}`);
