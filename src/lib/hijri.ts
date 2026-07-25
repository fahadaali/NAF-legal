// تحويل التواريخ بين الميلادي والهجري (تقويم أم القرى) عبر Intl المتاح في Workers.

const HIJRI_FMT = 'ar-SA-u-ca-islamic-umalqura-nu-latn';

// يحوّل تاريخًا ميلاديًا (Date أو YYYY-MM-DD) إلى نصّ هجري مثل 1447/01/15هـ
export function toHijri(input: Date | string): string {
  const d = typeof input === 'string' ? parseFlexibleDate(input) : input;
  if (!d) return '';
  try {
    const parts = new Intl.DateTimeFormat(HIJRI_FMT, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: 'UTC',
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const y = get('year').replace(/[^\d]/g, '');
    const m = get('month').replace(/[^\d]/g, '');
    const day = get('day').replace(/[^\d]/g, '');
    if (!y || !m || !day) return '';
    return `${y}/${m}/${day}هـ`;
  } catch {
    return '';
  }
}

// يحوّل تاريخًا هجريًا (YYYY/MM/DD أو YYYY-MM-DD) إلى ميلادي YYYY-MM-DD
// بالبحث التقريبي ثم الضبط عبر Intl (لا يوجد محوّل عكسي مباشر في Intl).
export function hijriToGregorian(hijri: string): string {
  const m = hijri.match(/(\d{3,4})\s*[/\-–]\s*(\d{1,2})\s*[/\-–]\s*(\d{1,2})/);
  if (!m) return '';
  const [hy, hm, hd] = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  // تقدير أولي: الهجري ≈ (الميلادي - 622) * 33/32
  const approxGregYear = Math.floor(hy * 0.970224 + 621.5774);
  let guess = Date.UTC(approxGregYear, 0, 1);
  // ابحث في نطاق ±400 يوم عن مطابقة تامة
  for (let offset = 0; offset <= 400; offset++) {
    for (const sign of [1, -1]) {
      const t = guess + sign * offset * 86_400_000;
      const d = new Date(t);
      const h = toHijri(d);
      const hm2 = h.match(/(\d{3,4})\/(\d{2})\/(\d{2})/);
      if (hm2 && parseInt(hm2[1], 10) === hy && parseInt(hm2[2], 10) === hm && parseInt(hm2[3], 10) === hd) {
        return d.toISOString().slice(0, 10);
      }
    }
  }
  return '';
}

// يقبل ميلاديًا (YYYY-MM-DD) أو هجريًا (1447/01/15هـ) ويعيد Date ميلاديًا
export function parseFlexibleDate(input: string): Date | null {
  const s = (input ?? '').trim();
  if (!s) return null;
  // هجري صريح (يحتوي هـ أو سنة ≥ 1300 و < 1600)
  const looksHijri = /هـ|ه\b/.test(s) || /^1[3-5]\d{2}[/\-]/.test(s);
  if (looksHijri) {
    const g = hijriToGregorian(s);
    return g ? new Date(g + 'T00:00:00Z') : null;
  }
  const iso = s.match(/(\d{4})\s*[-/]\s*(\d{1,2})\s*[-/]\s*(\d{1,2})/);
  if (iso) {
    const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// يضيف عددًا من الأيام إلى تاريخ ويعيد YYYY-MM-DD
export function addDays(date: Date, days: number): string {
  return new Date(date.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

// عرض مزدوج: 2025-07-10 (1447/01/15هـ)
export function dualDate(input: Date | string): string {
  const d = typeof input === 'string' ? parseFlexibleDate(input) : input;
  if (!d) return typeof input === 'string' ? input : '';
  const greg = d.toISOString().slice(0, 10);
  const h = toHijri(d);
  return h ? `${greg} (${h})` : greg;
}
