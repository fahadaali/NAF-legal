// عرض المبدأ القضائي — بإسناده وحاله وتحذيره.
//
// المبدأ سابقةٌ لا نصٌّ ملزم (docs/legal-import.md §١٦): يُعرض في قسمٍ وحده
// بعد الموادّ، ولا يأخذ شيئاً من مكوّنات المادة — شاراتُ المادة تقول حالَ نصٍّ
// نافذ، وحالُ المبدأ حالُ ما بُني عليه.
//
// والألفاظ مسجَّلة في `naf-terms.md` تحت «المبادئ القضائية» (§٣) ورسائلُ
// الاستيراد في §٤، والأيقونات في `naf-icons.md` تحت «المبادئ القضائية».
import { useEffect, useState } from 'react';
import { api, type Principle, type PrincipleBook, type PrincipleCollection, type PrincipleStatus } from '../lib/api';
import { formatNumber, isolate } from '../lib/format';
import { Icon, ICON_SM } from '../lib/icons';
import { useScrollReset } from '../lib/scrollBox';

/**
 * حالُ المبدأ — لفظاً وأيقونةً ولوناً، والأيقونتان بمعناهما المسجَّل للمادة
 * («عليها تعديل» و«ملغاة»): المعنى واحد والنطاق ما بُني عليه المبدأ.
 *
 * و«نافذ» و«نافذ بتحذير» بلا شارة كالمادة: النافذةُ بتحذير يحمل حالَها شريطُ
 * التنبيه فوق النصّ، وشارةٌ تكرّره ضجيجٌ يُطفئ الحالين اللتين تُغيّران
 * الاستشهاد فعلاً.
 */
const STATUS: Record<PrincipleStatus, { label: string; cls: string; icon: keyof typeof Icon } | null> = {
  'نافذ': null,
  'نافذ_بتحذير': null,
  'أساسه معدَّل': { label: 'أساسه معدَّل', cls: 'warn', icon: 'warning' },
  'أساسه ملغى': { label: 'أساسه ملغى', cls: 'error', icon: 'repealedArticle' },
};

/** مرشّحُ الحال في التصفّح — الأربع بألفاظها. */
export const PRINCIPLE_STATUS_FILTERS: [PrincipleStatus, string][] = [
  ['نافذ', 'نافذ'],
  ['نافذ_بتحذير', 'نافذ بتحذير'],
  ['أساسه معدَّل', 'أساسه معدَّل'],
  ['أساسه ملغى', 'أساسه ملغى'],
];

export function PrincipleStatusPill({ status }: { status: PrincipleStatus }) {
  const s = STATUS[status];
  if (!s) return null;
  const Glyph = Icon[s.icon];
  return (
    <span className={`pill ${s.cls}`}>
      <Glyph size={ICON_SM} aria-hidden /> {s.label}
    </span>
  );
}

/**
 * سطر الإسناد: القرار وتاريخه كما طُبعا والقضية التي صدر فيها، ثم مجلدُه
 * وصفحتُه في المدوّنة — والمجلد قبل الصفحة: صفحاتُ كلِّ مجلدٍ تبدأ من أوّله.
 *
 * رقمُ القرار «431/1/81» وتاريخُه الهجريّ نصٌّ مطبوع يُنقل كما هو — لا تاريخٌ
 * يُعاد تنسيقه — فيُعزل اتجاهُه وحده (§2): بلا عزلٍ يقرؤه العربيّ «81/1/431».
 */
function citationLine(p: Principle): string | null {
  const parts: string[] = [];
  const inCase = p.caseRef ? `${p.caseRef.kind === 'استئناف' ? 'الاستئناف' : 'الدعوى'} رقم ${isolate(p.caseRef.no)}` : '';
  if (p.decisionNo) {
    const date = p.decisionDateH ? ` وتاريخ ${isolate(p.decisionDateH)}هـ` : '';
    parts.push(`القرار ${isolate(p.decisionNo)}${date}${inCase ? ` الصادر في ${inCase}` : ''}`);
  } else if (inCase) {
    parts.push(inCase);
  }
  if (p.volume) parts.push(`المجلد ${isolate(String(p.volume))}`);
  if (p.sourcePages) parts.push(`ص ${isolate(p.sourcePages)}`);
  return parts.length ? parts.join(' — ') : null;
}

/**
 * بطاقة المبدأ.
 *
 * والتحذير **فوق** النصّ كتنبيه المادة: ما يُقرأ بعد النصّ يُقرأ متأخراً، وقد
 * نُسخ المبدأ إلى مذكرةٍ على أنه جارٍ وأساسُه ملغى.
 */
export function PrincipleCard({ p, showCollection = true }: { p: Principle; showCollection?: boolean }) {
  const cite = citationLine(p);
  const basis = p.related.filter((r) => r.article_no);
  const similar = p.similar.filter((s) => s.decision_no);
  return (
    <article className="legal-article">
      <h4>
        {showCollection ? <bdi>{p.collectionTitle}</bdi> : null}
        <span className="pill pending">
          <Icon.principle size={ICON_SM} aria-hidden /> <bdi>{p.principleLabel}</bdi>
        </span>
        <PrincipleStatusPill status={p.retrievalStatus} />
      </h4>
      {cite ? <p className="legal-notice-meta">{cite}</p> : null}
      {p.retrievalStatus !== 'نافذ' && p.retrievalWarning ? (
        <div className="legal-notice">
          <Icon.warning size={ICON_SM} aria-hidden />
          <div>
            <p>{p.retrievalWarning}</p>
          </div>
        </div>
      ) : null}
      <p>{p.text}</p>
      {basis.length ? (
        <p className="legal-notice-meta">
          الموادّ التي بُني عليها:{' '}
          {basis.map((r, i) => (
            <span key={i}>
              {i > 0 ? '، ' : ''}
              المادة <bdi>{r.article_no}</bdi>
              {r.law ? <> من <bdi>{r.law}</bdi></> : null}
              {r.state ? <> ({r.state})</> : null}
            </span>
          ))}
        </p>
      ) : null}
      {similar.length ? (
        <p className="legal-notice-meta">
          قرارات مشابهة:{' '}
          {similar.map((s, i) => (
            <span key={i}>
              {i > 0 ? '، ' : ''}
              <bdi>{s.decision_no}</bdi>
            </span>
          ))}
        </p>
      ) : null}
    </article>
  );
}

/** عددُ المبادئ في جدول المدوّنات — وشرطةٌ لا صفر ما لم يكن للحال مبادئ. */
function cell(n?: number) {
  return n ? <bdi>{formatNumber(n)}</bdi> : '—';
}

/** مبادئ الصفحة الواحدة في التصفّح. */
const PAGE = 25;

/**
 * تصفّح المدوّنات — مدوّنةً مدوّنة، ثم باباً باباً.
 *
 * للاطّلاع لا للتحرير كتصفّح الأنظمة: المصدرُ ملفُّ المبادئ من مشروع nezam،
 * وتصحيحٌ هنا يضيع عند أوّل إعادة رفع.
 */
export function PrincipleCollections({ refreshKey }: { refreshKey?: unknown }) {
  const [collections, setCollections] = useState<PrincipleCollection[] | null>(null);
  const [open, setOpen] = useState<PrincipleCollection | null>(null);

  useEffect(() => {
    api.principleCollections().then((r) => setCollections(r.collections)).catch(() => setCollections([]));
    // يُعاد بعد كل تحديثٍ للقاعدة — استيرادٌ من بطاقة «استيراد مبادئ» يظهر فوراً.
  }, [refreshKey]);

  useScrollReset(open?.collection_id ?? 'list');

  if (open) return <CollectionDetail c={open} onBack={() => setOpen(null)} />;

  if (collections === null) {
    return (
      <div className="kb-skeleton" aria-hidden>
        <span className="kb-skeleton-row" />
        <span className="kb-skeleton-row" />
      </div>
    );
  }
  if (!collections.length) {
    return <div className="empty-state">لم تُستورد أي مدوّنة مبادئ بعد. ابدأ باستيراد ملف المبادئ.</div>;
  }
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>المدوّنة</th>
            <th>المبادئ</th>
            <th>نافذ</th>
            <th>نافذ بتحذير</th>
            <th>أساسه معدَّل</th>
            <th>أساسه ملغى</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {collections.map((c) => (
            <tr key={c.collection_id}>
              <td><bdi>{c.collection_title}</bdi></td>
              <td>{cell(c.principles)}</td>
              <td>{cell(c.by_status['نافذ'])}</td>
              <td>{cell(c.by_status['نافذ_بتحذير'])}</td>
              <td>{cell(c.by_status['أساسه معدَّل'])}</td>
              <td>{cell(c.by_status['أساسه ملغى'])}</td>
              <td>
                <button className="btn-sm primary" onClick={() => setOpen(c)}>عرض</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CollectionDetail({ c, onBack }: { c: PrincipleCollection; onBack: () => void }) {
  const [books, setBooks] = useState<PrincipleBook[]>([]);
  const [book, setBook] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [principles, setPrinciples] = useState<Principle[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    api.principleBooks(c.collection_id).then((r) => setBooks(r.books)).catch(() => setBooks([]));
  }, [c.collection_id]);

  useEffect(() => setOffset(0), [book, status]);
  useScrollReset(`${book}|${status}|${offset}`);

  useEffect(() => {
    /* مرشّحٌ بُدّل أو صفحةٌ قُلبت قبل وصول سابقتها: ردُّ السابقة لا يكتب فوق اللاحقة. */
    let live = true;
    api
      .browsePrinciples(c.collection_id, { book: book || null, status: status || null, offset, limit: PAGE })
      .then((r) => {
        if (!live) return;
        setPrinciples(r.principles);
        setTotal(r.total);
      })
      .catch(() => live && setPrinciples([]));
    return () => {
      live = false;
    };
  }, [c.collection_id, book, status, offset]);

  return (
    <div>
      <button className="btn-sm" onClick={onBack}>رجوع</button>
      <div className="law-head">
        <h3><bdi>{c.collection_title}</bdi></h3>
        <p>
          <bdi>{formatNumber(c.principles)}</bdi> مبدأً
        </p>
      </div>

      <div className="review-filters">
        <label className="import-option">
          الباب
          <select value={book} onChange={(e) => setBook(e.target.value)}>
            <option value="">كل الأبواب</option>
            {books
              .filter((b) => b.book)
              .map((b) => (
                <option key={b.book} value={b.book!}>
                  {b.book}
                </option>
              ))}
          </select>
        </label>
        <label className="import-option">
          الحال
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">كل الحالات</option>
            {PRINCIPLE_STATUS_FILTERS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {principles === null ? (
        <div className="kb-skeleton" aria-hidden>
          <span className="kb-skeleton-row" />
          <span className="kb-skeleton-row" />
          <span className="kb-skeleton-row" />
        </div>
      ) : !principles.length ? (
        <div className="empty-state">لا مبادئ بهذه المرشّحات. جرّب باباً أو حالاً أخرى.</div>
      ) : (
        principles.map((p, i) => (
          <div key={p.id}>
            {/* البابُ عنوانٌ عند تغيّره وفي رأس كل صفحة — كتصفّح الأنظمة. */}
            {p.book && (i === 0 || p.book !== principles[i - 1].book) ? (
              <div className="kb-section"><bdi>{p.book}</bdi></div>
            ) : null}
            <PrincipleCard p={p} showCollection={false} />
          </div>
        ))
      )}

      {total > PAGE && (
        <div className="law-pager">
          <button className="btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            السابق
          </button>
          <span>
            <bdi>{formatNumber(Math.min(offset + PAGE, total))}</bdi> / <bdi>{formatNumber(total)}</bdi>
          </span>
          <button className="btn-sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
            التالي
          </button>
        </div>
      )}
    </div>
  );
}

/** أسطرُ الجزء الواحد عند الرفع — كأداة سطر الأوامر. */
const STAGE_LINES = 200;

type ImportState =
  | { kind: 'idle' }
  | { kind: 'running'; staged: number; total: number }
  | { kind: 'rejected'; from: number; error: string; errors: { line: number; error: string }[] }
  | { kind: 'failed'; error: string }
  | { kind: 'done'; written: number; replaced: number; collections: string[] };

/**
 * استيراد ملف المبادئ — جمعٌ على أجزاء ثم كتابةٌ واحدة تستبدل مدوّناته.
 *
 * وسطرٌ مرفوض يوقف الاستيراد ويُسقط ما جُمع قبله: لا «قبول الصالح» هنا، لأن
 * مدوّنةً نصفُها جديد ونصفُها قديم أسوأ من مدوّنةٍ لم تُحدَّث.
 */
export function PrinciplesImport({ onDone }: { onDone?: () => void }) {
  const [state, setState] = useState<ImportState>({ kind: 'idle' });

  const run = async (file: File) => {
    const lines = (await file.text()).replace(/^﻿/, '').split(/\r?\n/);
    const total = lines.filter((l) => l.trim()).length;
    const importId = crypto.randomUUID();
    setState({ kind: 'running', staged: 0, total });
    let staged = 0;
    try {
      for (let i = 0; i < lines.length; i += STAGE_LINES) {
        const part = lines.slice(i, i + STAGE_LINES);
        if (!part.some((l) => l.trim())) continue;
        const r = await api.stagePrinciples(importId, i + 1, part);
        if (!r.ok) {
          await api.abortPrinciples(importId).catch(() => {});
          setState({ kind: 'rejected', from: i + 1, error: r.error ?? '', errors: r.errors ?? [] });
          return;
        }
        staged += r.staged ?? 0;
        setState({ kind: 'running', staged, total });
      }
      const done = await api.commitPrinciples(importId);
      setState({ kind: 'done', ...done });
      onDone?.();
    } catch (e: any) {
      await api.abortPrinciples(importId).catch(() => {});
      setState({ kind: 'failed', error: e?.message ?? '' });
    }
  };

  const busy = state.kind === 'running';
  return (
    <div>
      <label className={`dropzone ${busy ? 'busy' : ''}`}>
        <input
          type="file"
          hidden
          accept=".jsonl"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) run(f);
          }}
        />
        {busy ? (
          <>
            <span className="spinner" /> جارٍ الاستيراد <bdi>{formatNumber(state.staged)}</bdi> /{' '}
            <bdi>{formatNumber(state.total)}</bdi>
          </>
        ) : (
          <>
            <Icon.import size={ICON_SM} aria-hidden /> اختر ملف المبادئ — <bdi>principles.jsonl</bdi>
          </>
        )}
      </label>

      {state.kind === 'done' ? (
        <p className="kb-index">
          <Icon.approved size={ICON_SM} aria-hidden />
          <span>
            تم الاستيراد — <bdi>{formatNumber(state.written)}</bdi> مبدأً في{' '}
            {state.collections.map((c, i) => (
              <span key={c}>
                {i > 0 ? '، ' : ''}
                <bdi>{c}</bdi>
              </span>
            ))}
            {state.replaced ? (
              <>
                {' '}
                — حلّت محلّ <bdi>{formatNumber(state.replaced)}</bdi>
              </>
            ) : null}
          </span>
        </p>
      ) : null}

      {state.kind === 'rejected' ? (
        <div className="kb-index warn">
          <Icon.failed size={ICON_SM} aria-hidden />
          <div>
            <p>
              لم يُستورد شيء: في الملف أسطرٌ مرفوضة. صحّحها في المصدر ثم أعد الاستيراد.
            </p>
            <ul>
              {state.errors.slice(0, 20).map((e) => (
                <li key={e.line}>
                  السطر <bdi>{formatNumber(e.line)}</bdi>: {e.error}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {state.kind === 'failed' ? (
        <p className="kb-index warn">
          <Icon.failed size={ICON_SM} aria-hidden />
          <span>لم يُستورد شيء: {state.error}</span>
        </p>
      ) : null}
    </div>
  );
}
