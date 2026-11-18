// رفع تقرير الفحص الشهري إلى المنصة — بديلُ زرّ «رفع تقرير الفحص» في لوحة الإدارة.
//
// التقرير `report.json` من مجلد الفحص في مشروع الاستيراد:
//   data/reports/updates/<YYYY-MM-DD>/report.json   (والسريع في <YYYY-MM-DD>-quick/)
//
// التشغيل:
//   npm run upload:update-check -- --file ~/nezam/data/reports/updates/2026-11-18/report.json \
//     --url https://advisor.naflaw.sa --cookie "naf_session=…"
//
// الخيارات:
//   --file    مسار report.json (إلزامي)
//   --url     أصل المنصة (الافتراضي http://localhost:8787)
//   --cookie  كوكي جلسة مسؤول (أو متغيّر البيئة NAF_COOKIE)
//
// والملف نفسه يُرفع مرّةً: إعادته تُقال «مرفوعٌ من قبل» ولا تُكتب. والفحص الكامل
// الأقدم من آخر كاملٍ مرفوع يُرفض. العقد في docs/legal-import.md §١٥.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

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
  console.error('المطلوب: --file <report.json>');
  process.exit(1);
}
const origin = (args.get('url') ?? 'http://localhost:8787').replace(/\/$/, '');
const cookie = args.get('cookie') ?? process.env.NAF_COOKIE ?? '';

const text = await readFile(file, 'utf8');
const res = await fetch(`${origin}/api/legal/update-checks?filename=${encodeURIComponent(path.basename(path.dirname(file)) + '/report.json')}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: text,
});
const data = await res.json().catch(() => ({}));
if (res.status === 401) {
  console.error('✗ الجلسة غير صالحة — سجّل الدخول وانسخ الكوكي من جديد (--cookie أو NAF_COOKIE)');
  process.exit(1);
}
if (!res.ok || !data.ok) {
  console.error(`✗ ${data.error ?? `ردّ الخادم ${res.status}`}`);
  process.exit(1);
}
if (data.duplicate) {
  console.log(`مرفوعٌ من قبل: فحص ${data.run} (${data.mode === 'full' ? 'كامل' : 'سريع'}) — لم يُكتب شيء.`);
} else {
  console.log(`✓ رُفع فحص ${data.run} (${data.mode === 'full' ? 'كامل' : 'سريع'})`);
  console.log(`  بنود جديدة: ${data.added} · محدَّثة: ${data.updated} · أُغلقت (لم تعد تُرصد): ${data.resolved}` +
    (data.skipped_dismissed ? ` · مستبعدة سابقاً: ${data.skipped_dismissed}` : ''));
  console.log(`  موادّ عليها تنبيه الآن: ${data.notices}`);
}
