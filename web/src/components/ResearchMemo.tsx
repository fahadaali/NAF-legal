// مذكرة البحث — ما بُني عليه الدور قبل أن يُصاغ: المسائل وموادّها، وما لم يُوجد له سند.
//
// تُعرض في موضعين: مفتوحةً حين يتمّ بحثٌ معمّق ولم يُصَغ منه بعد — هنا يراجع
// المحامي أسانيده قبل الكتابة؛ ومطويّةً تحت كل ردٍّ بُني على مذكرة — لمن أراد أن
// يعرف من أين جاء الردّ، أو يعدّل أسانيده ويصوغ منها ثانيةً.
//
// والتعديل نسخةٌ جديدة لا تعديلٌ في المكان (`PATCH /api/research/memos/:id`):
// الردُّ الذي صيغ من النسخة الأولى يبقى منسوباً إليها.
//
// النصوص من `lib/researchTerms.ts` — مقترحةٌ بانتظار تسجيلها في naf-ui.
import { useState } from 'react';
import { api, type Citation, type MemoItem, type ResearchMemo as Memo } from '../lib/api';
import { formatNumber } from '../lib/format';
import { Icon, ICON_SM } from '../lib/icons';
import { RT, LAYER_LABELS, articlesUnit, excludedUnit } from '../lib/researchTerms';

/** ما تُفتح به المادة في نافذة المصدر. الوثيقة المرفوعة لا مادةَ لها تُفتح. */
export function citationOfMemoItem(it: MemoItem): Citation | null {
  if (it.source === 'document' || it.key.startsWith('doc:')) return null;
  // مذكراتٌ حُفظت قبل أن تحمل معرّف المقطع: المفتاحُ معرّفُ المادة نفسه.
  const id = it.id ?? (it.key.startsWith('legal:') ? it.key.slice('legal:'.length) : undefined);
  if (!id && !it.articleNo) return null;
  return {
    title: it.lawTitle ?? it.title,
    id,
    lawId: it.lawId,
    articleNo: it.articleNo,
    ref: it.articleNo ? `المادة ${it.articleNo}` : undefined,
    source: 'legal',
    score: 0,
  };
}

function StatusPill({ status }: { status: Memo['status'] }) {
  // `auto` بلا شارة: مذكرةٌ بُنيت وصيغ منها في الدور نفسه — لا قرار فيها لأحد.
  if (status === 'approved') {
    return (
      <span className="pill success">
        <Icon.approved size={ICON_SM} aria-hidden /> معتمد
      </span>
    );
  }
  if (status === 'draft') {
    return (
      <span className="pill pending">
        <Icon.draft size={ICON_SM} aria-hidden /> مسودة
      </span>
    );
  }
  return null;
}

export default function ResearchMemo({
  memo,
  onChange,
  onOpenSource,
  onDraft,
  disabled = false,
}: {
  memo: Memo;
  /** نسخةٌ جديدة بعد الاستبعاد، أو المذكرة بعد اعتمادها. */
  onChange: (memo: Memo) => void;
  onOpenSource: (c: Citation) => void;
  /** «صياغة من المذكرة». غيابُه يُخفي الزرّ — قارئٌ لا يكتب. */
  onDraft?: (memo: Memo) => void;
  /** دورٌ يجري في المحادثة: لا صياغة عليه. */
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = memo.groups.reduce((n, g) => n + g.items.length, 0);

  const toggle = (key: string) =>
    setExcluded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const run = async (fn: () => Promise<{ memo: Memo }>) => {
    setBusy(true);
    setError(null);
    try {
      onChange((await fn()).memo);
      setEditing(false);
      setExcluded(new Set());
    } catch (e: any) {
      setError(e?.message ?? 'تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="research-memo" aria-label={RT.memo}>
      <header className="research-memo-head">
        <span className="research-memo-title">
          <Icon.researchMemo size={ICON_SM} aria-hidden /> {RT.memo}
        </span>
        <span className="research-memo-count">
          <bdi>{formatNumber(count)}</bdi> {articlesUnit}
        </span>
        <StatusPill status={memo.status} />
      </header>

      {memo.groups.map((g, gi) => (
        <div key={`${gi}:${g.title}`} className="research-memo-group">
          <h4 className="research-memo-group-title">{g.title}</h4>
          <ul className="research-memo-items">
            {g.items.map((it) => {
              const citation = citationOfMemoItem(it);
              const out = excluded.has(it.key);
              return (
                <li key={it.key} className={out ? 'is-excluded' : undefined}>
                  {citation ? (
                    <button type="button" className="citation-chip is-open" onClick={() => onOpenSource(citation)}>
                      <bdi>{it.title}</bdi>
                    </button>
                  ) : (
                    <span className="citation-chip">
                      <bdi>{it.title}</bdi>
                    </span>
                  )}
                  {editing && (
                    <button
                      type="button"
                      className="btn-sm research-memo-exclude"
                      aria-pressed={out}
                      onClick={() => toggle(it.key)}
                    >
                      <Icon.exclude size={ICON_SM} aria-hidden /> استبعاد
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {memo.gaps.length > 0 && (
        <div className="research-memo-gaps">
          <h4 className="research-memo-group-title">
            <Icon.warning size={ICON_SM} aria-hidden /> {RT.gapsHeading}
          </h4>
          <p className="research-memo-gap-line">{RT.gapLine}</p>
          <ul>
            {memo.gaps.map((g, i) => (
              <li key={i}>
                <bdi>{g.title}</bdi>
                {g.layer ? ` (${LAYER_LABELS[g.layer]})` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p className="research-memo-error" role="alert">
          <Icon.failed size={ICON_SM} aria-hidden /> {error}
        </p>
      )}

      <div className="msg-actions">
        {editing ? (
          <>
            <button
              type="button"
              disabled={busy || excluded.size === 0}
              onClick={() => run(() => api.editResearchMemo(memo.id, [...excluded]))}
            >
              <Icon.save size={ICON_SM} aria-hidden /> حفظ
              {excluded.size > 0 && (
                <span className="research-memo-pending">
                  {' · '}
                  <bdi>{formatNumber(excluded.size)}</bdi> {excludedUnit}
                </span>
              )}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setExcluded(new Set());
              }}
            >
              <Icon.close size={ICON_SM} aria-hidden /> إلغاء
            </button>
          </>
        ) : (
          <>
            {onDraft && (
              <button type="button" disabled={disabled || busy || count === 0} onClick={() => onDraft(memo)}>
                <Icon.write size={ICON_SM} aria-hidden /> {RT.draftFromMemo}
              </button>
            )}
            {count > 0 && (
              <button type="button" disabled={busy} onClick={() => setEditing(true)}>
                <Icon.edit size={ICON_SM} aria-hidden /> {RT.editSources}
              </button>
            )}
            {memo.status === 'draft' && (
              <button type="button" disabled={busy} onClick={() => run(() => api.approveResearchMemo(memo.id))}>
                <Icon.approved size={ICON_SM} aria-hidden /> اعتماد
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * المذكرة تحت ردٍّ محفوظ — مطويّة، وتُجلب أوّلَ ما تُفتح.
 *
 * الجلب عند الفتح لا مع المحادثة: أكثرُ الردود لا تُفتح مذكرتها، وجلبُها كلِّها
 * مع كل تحميلٍ للمحادثة نداءٌ لكل ردّ بلا قارئ.
 */
export function MemoDisclosure({
  memoId,
  onOpenSource,
  onDraft,
  disabled,
}: {
  memoId: string;
  onOpenSource: (c: Citation) => void;
  onDraft?: (memo: Memo) => void;
  disabled?: boolean;
}) {
  const [memo, setMemo] = useState<Memo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    if (memo) return;
    setError(null);
    api
      .researchMemo(memoId)
      .then((r) => setMemo(r.memo))
      .catch((e: any) => setError(e?.message ?? 'تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة'));
  };

  return (
    <details
      className="research-memo-disclosure"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) load();
      }}
    >
      <summary>
        <Icon.researchMemo size={ICON_SM} aria-hidden /> {RT.memo}
      </summary>
      {memo ? (
        <ResearchMemo memo={memo} onChange={setMemo} onOpenSource={onOpenSource} onDraft={onDraft} disabled={disabled} />
      ) : error ? (
        <p className="research-memo-error" role="alert">
          <Icon.failed size={ICON_SM} aria-hidden /> {error}
        </p>
      ) : (
        <p className="typing-note">
          <Icon.running size={ICON_SM} aria-hidden className="icon-spin" /> جارٍ التحميل
        </p>
      )}
    </details>
  );
}
