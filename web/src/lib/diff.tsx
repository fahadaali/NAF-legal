// فرقُ نصّين — يُقرأ في شاشتين.
//
// المراجعة تعرضه بين النصّ النافذ والنصّ السابق، والاستعراض بين نسختين في
// الخطّ الزمني. ونسختان منه في ملفّين تجعلان إصلاحاً يقع في إحداهما ويبقى في
// الأخرى، فسكن هنا.
import { useMemo } from 'react';

/**
 * فرقُ نصّين بالكلمات.
 *
 * بالكلمة لا بالحرف: نصٌّ قانونيّ يُقرأ كلماتٍ، وفرقٌ بالحروف يجعل «الخامسة»
 * و«السادسة» سلسلةً من الإدراج والحذف لا تُقرأ. والمقارنة بأطول تتابعٍ مشترك
 * — وهي تربيعيّة، فيُتخطّى النصّ الطويل جداً ويُعرض كما هو: فرقٌ لا يُقرأ لا
 * يستحقّ إبطاء الشاشة.
 */
export const DIFF_MAX_WORDS = 1200;

export function DiffText({ from, to }: { from: string; to: string }) {
  const parts = useMemo(() => diffWords(from, to), [from, to]);
  if (!parts) return <p className="review-raw">{from}</p>;
  return (
    <p className="review-raw">
      {parts.map((p, i) =>
        p.kind === 'same' ? (
          <span key={i}>{p.text}</span>
        ) : p.kind === 'del' ? (
          <del key={i}>{p.text}</del>
        ) : (
          <ins key={i}>{p.text}</ins>
        )
      )}
    </p>
  );
}

type DiffPart = { kind: 'same' | 'del' | 'ins'; text: string };

function diffWords(from: string, to: string): DiffPart[] | null {
  const a = from.split(/(\s+)/).filter(Boolean);
  const b = to.split(/(\s+)/).filter(Boolean);
  if (a.length > DIFF_MAX_WORDS || b.length > DIFF_MAX_WORDS) return null;

  // جدول أطول تتابعٍ مشترك، ثم تتبّعُه من أوّله.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const parts: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) push('same', a[i++]), j++;
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) push('del', a[i++]);
    else push('ins', b[j++]);
  }
  while (i < a.length) push('del', a[i++]);
  while (j < b.length) push('ins', b[j++]);
  return parts;
}
