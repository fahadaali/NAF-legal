// مراجعة المواد — وحدةٌ مستقلّة فوق الاستيراد.
//
// **الفصل التام.** المواد الجاهزة تدخل الاسترجاع فور الاستيراد، والموسومة
// تنتظر هنا. فالمراجعة لا توقف شيئاً: خمسة آلاف مادة تعمل بينما الطابور
// ممتلئ — وهو جوهر هذه الوحدة لا أثرٌ جانبيّ لها.
//
// وهي **للاعتماد والتحرير**: ما يُحرَّر هنا يُحفظ في القاعدة ويُعاد تضمينه.
// والمصدر يبقى ملفَّ الاستيراد، فإعادة رفعه بنصٍّ جديد تُسقط الاعتماد وتعيد
// المادة إلى الطابور — واعتمادُ نصٍّ لم يعد هو النصّ ليس اعتماداً.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  REVIEW_BULK_LIMIT,
  type AmendmentEvent,
  type LegalAmendment,
  type LegalArticle,
  type LegalLaw,
  type ReviewAction,
  type ReviewAuditEntry,
  type ReviewDashboard,
  type ReviewFilters,
} from '../lib/api';
import { DiffText } from '../lib/diff';
import { formatDate, formatNumber, formatTime } from '../lib/format';
import { Icon, ICON_SM } from '../lib/icons';
import { useScrollReset } from '../lib/scrollBox';
import { ReviewStatusPill } from './LegalArticleView';

/**
 * أسماء الطوابير بترتيب أولويتها: ما يُفسد الاسترجاع أوّلاً.
 *
 * والمفاتيح تقابل ما في `src/lib/legal.ts` — الشرط هناك والاسم هنا، فالطابور
 * يُعرَّف مرّةً واحدة ولا يُعاد بناء منطقه في الشاشة.
 */
const QUEUES: [string, string][] = [
  ['duplicate', 'رقم مكرّر'],
  ['truncated', 'مشبوه الاقتطاع'],
  ['preamble', 'تسرّب ديباجة'],
  ['partial', 'تعديل جزئي'],
  ['collective', 'تعديل جماعي'],
  ['addition', 'إضافة'],
  ['unclassified', 'غير مصنَّف'],
];

/** موضع المراجع محفوظ: الخروج والعودة لا يفقدان الطابور ولا المرشّحات. */
const SEAT_KEY = 'naf-legal:review-seat';

interface Seat {
  queue: string | null;
  filters: ReviewFilters;
}

function readSeat(): Seat {
  try {
    const raw = localStorage.getItem(SEAT_KEY);
    if (raw) return JSON.parse(raw) as Seat;
  } catch {
    // تخزينٌ محليّ معطَّل أو ممتلئ — يبدأ المراجع من أوّل الطابور، لا أكثر.
  }
  return { queue: null, filters: {} };
}

export function LegalReview() {
  const [seat, setSeat] = useState<Seat>(readSeat);
  const [dash, setDash] = useState<ReviewDashboard | null>(null);
  const [laws, setLaws] = useState<LegalLaw[]>([]);
  const [batches, setBatches] = useState<{ captured_at: string; chunks: number }[]>([]);
  const [articles, setArticles] = useState<LegalArticle[]>([]);
  const [total, setTotal] = useState(0);
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  /** تقدّم الاعتماد الجملي: ما تمّ من إجماليّ ما حُدِّد. `null` حين لا اعتماد يجري. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const { queue, filters } = seat;

  useEffect(() => {
    try {
      localStorage.setItem(SEAT_KEY, JSON.stringify(seat));
    } catch {
      // كما أعلاه: يُفقد الموضع ولا يُفقد العمل.
    }
  }, [seat]);

  useEffect(() => {
    api.legalLaws().then((r) => setLaws(r.laws)).catch(() => {});
    api.legalCaptureBatches().then((r) => setBatches(r.batches)).catch(() => {});
  }, []);

  const load = useCallback(() => {
    api.legalReviewDashboard(filters).then(setDash).catch(() => {});
    api
      .legalReviewQueue({ ...filters, queue }, 0, 25)
      .then((r) => {
        setArticles(r.articles);
        setTotal(r.total);
        setAt((i) => Math.min(i, Math.max(0, r.articles.length - 1)));
      })
      .catch(() => {});
  }, [queue, filters]);

  useEffect(load, [load]);

  /* تبدُّل الطابور أو المرشِّح يُبدّل كلَّ ما تحت اللوحة، فتُفتح الشاشة من
     أعلاها. ولا تُعاد على `at`: بطاقة المادة أسفل الشاشة والمراجع ينظر
     إليها أصلاً، فإعادتُه إلى الأعلى مع كل «التالي» تُبعده عن عمله. */
  useScrollReset(
    [queue ?? '', filters.lawId ?? '', filters.capturedAt ?? '', filters.docType ?? ''].join('|')
  );

  /* أخوات الرقم الواحد تُعرض مجتمعة: الحكم عليها لا يصحّ إلا كذلك — أهي مادة
     مضافة مشروعة أم خطأ تقطيع؟ لا يُعرف إلا بقراءة الاثنتين. والمجموعة
     محطّةٌ واحدة في الطابور لا محطّتان. */
  const groups = useMemo(() => {
    const out: LegalArticle[][] = [];
    const seen = new Set<string>();
    for (const a of articles) {
      if (seen.has(a.id)) continue;
      if (a.duplicateOf) {
        const siblings = articles.filter((x) => x.duplicateOf === a.duplicateOf);
        siblings.forEach((x) => seen.add(x.id));
        out.push(siblings);
      } else {
        seen.add(a.id);
        out.push([a]);
      }
    }
    return out;
  }, [articles]);

  const group = groups[Math.min(at, groups.length - 1)];

  /** أنواع الأدوات المستوردة فعلاً — لا قائمةٌ مكتوبة تشيخ مع أوّل نوعٍ جديد. */
  const docTypes = useMemo(
    () => Array.from(new Set(laws.map((l) => l.doc_type).filter((t): t is string => !!t))).sort(),
    [laws]
  );

  const move = useCallback(
    (step: number) => setAt((i) => Math.max(0, Math.min(groups.length - 1, i + step))),
    [groups.length]
  );

  const act = async (id: string, action: ReviewAction, body: { text?: string; note?: string } = {}) => {
    setBusy(true);
    try {
      await api.legalReview(id, action, body);
      // المادة تخرج من الطابور بقرارها، فتُزال من القائمة في الحال: صفٌّ يبقى
      // بعد البتّ فيه يُبتّ فيه مرّتين. والعدّادات تُعاد من الخادم لا تُحسب هنا.
      setArticles((rows) => rows.filter((r) => r.id !== id));
      setTotal((n) => Math.max(0, n - 1));
      // وآخرُ صفٍّ في الصفحة يستدعي الصفحة التالية لا شاشةَ الفراغ: طابورٌ فيه
      // مئتان يُقال عنه «لا مادة بانتظار المراجعة» لأن خمساً وعشرين نفدت خطأ.
      if (articles.length <= 1) load();
      else api.legalReviewDashboard(filters).then(setDash).catch(() => {});
    } catch {
      load();
    } finally {
      setBusy(false);
    }
  };

  /**
   * اعتمادُ ما حدَّده المراجع.
   *
   * بمعرّفاتٍ بأعيانها لا بشرطٍ يُطابق ما لم يُعرض: العدد الذي رآه المراجع قبل
   * التأكيد هو العدد الذي يقع عليه القرار. وكلُّ مادة تُقيَّد وحدها في سجلّ
   * التدقيق موسومةً بأن اعتمادها وقع جملةً.
   *
   * **والتقسيم على دفعات لا نداءٌ واحد.** سقف النداء خمسون، فتحديدُ الطابور
   * كلِّه يمرّ في دفعاتٍ متتابعة لا متوازية: القاعدة واحدة، والتسابق عليها
   * يُبطئ ولا يُسرع. والتقدّم يُعرض بعد كل دفعة — انتظارٌ صامت على مئتي مادة
   * يُقرأ تعليقاً.
   */
  const approveSelected = async (ids: string[]) => {
    if (!ids.length) return;
    setBusy(true);
    setProgress({ done: 0, total: ids.length });
    const cleared = new Set<string>();
    try {
      for (let i = 0; i < ids.length; i += REVIEW_BULK_LIMIT) {
        const batch = ids.slice(i, i + REVIEW_BULK_LIMIT);
        const res = await api.legalReviewSelected(batch, 'approve');
        // ما تعثّر يُعرف بمعرّفه لا بالطرح من العدّ: الإخفاقات قد تتخلّل
        // الدفعة، فحسبُ الناجح بـ«أوّل كذا» يُسقط الصواب ويُبقي الخطأ.
        const missed = new Set(res.failed.map((f) => f.id));
        batch.forEach((id) => {
          if (!missed.has(id)) cleared.add(id);
        });
        setProgress({ done: cleared.size, total: ids.length });
        setArticles((rows) => rows.filter((r) => !cleared.has(r.id)));
        setTotal((n) => Math.max(0, n - (res.done ?? 0)));
      }
    } catch {
      // النداء المقطوع لا يُبطل ما تمّ قبله: ما اعتُمد اعتُمد، والباقي يظهر
      // في الطابور حين تُعاد القائمة أدناه.
    } finally {
      setProgress(null);
      setBusy(false);
      // والقائمة تُعاد من الخادم في كل حال: بعد الدفعات لا تبقى في هذه الصفحة
      // موادُّ تُعرض، وما بقي في الطابور بعدها لا يُخمَّن هنا.
      load();
    }
  };

  /* هيكلٌ لا `null` ريثما تصل اللوحة. وكانت الشاشة تُرسَم بلا شيء ثم تُحقَن
     اللوحةُ والطوابيرُ والمرشّحاتُ دفعةً واحدة **فوق** ما تحتها، فيقفز
     ما يقرؤه المراجع. */
  if (!dash) {
    return (
      <div className="kb-skeleton" aria-hidden>
        <span className="kb-skeleton-row" />
        <span className="kb-skeleton-row" />
        <span className="kb-skeleton-row" />
        <span className="kb-skeleton-row" />
      </div>
    );
  }

  return (
    <div>
      <ReviewDashboardPanel dash={dash} />

      <div className="kb-section">الطوابير</div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>الطابور</th>
              <th>المنتظرة في الطابور</th>
              <th>المنجز من الإجمالي</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {QUEUES.map(([key, label]) => {
              const c = dash.queues.find((q) => q.key === key);
              const pending = c?.pending ?? 0;
              const done = c?.done ?? 0;
              return (
                <tr key={key}>
                  <td>{label}</td>
                  <td><bdi>{formatNumber(pending)}</bdi></td>
                  <td>
                    <bdi>{formatNumber(done)}</bdi> / <bdi>{formatNumber(done + pending)}</bdi>
                  </td>
                  <td>
                    <button
                      className={`btn-sm ${queue === key ? 'primary' : ''}`}
                      onClick={() => {
                        setSeat({ queue: queue === key ? null : key, filters });
                        setAt(0);
                      }}
                    >
                      {queue === key ? 'كل الطوابير' : 'عرض'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="review-filters">
        <label className="import-option">
          النظام
          <select
            value={filters.lawId ?? ''}
            onChange={(e) => {
              setSeat({ queue, filters: { ...filters, lawId: e.target.value || null } });
              setAt(0);
            }}
          >
            <option value="">كل الأنظمة</option>
            {laws.map((l) => (
              <option key={l.law_id} value={l.law_id}>
                {l.law_title || l.law_id}
              </option>
            ))}
          </select>
        </label>
        <label className="import-option">
          دفعة الاستيراد
          <select
            value={filters.capturedAt ?? ''}
            onChange={(e) => {
              setSeat({ queue, filters: { ...filters, capturedAt: e.target.value || null } });
              setAt(0);
            }}
          >
            <option value="">كل الدفعات</option>
            {batches.map((b) => (
              <option key={b.captured_at} value={b.captured_at}>
                {b.captured_at}
              </option>
            ))}
          </select>
        </label>
        {/* النوع يفصل الأنظمة عن اللوائح. وقيمُه من الملف كما وردت — تُشتقّ
            من الأنظمة المستوردة، فما يُستورد بنوعٍ جديد يظهر بلا تعديل هنا. */}
        <label className="import-option">
          النوع
          <select
            value={filters.docType ?? ''}
            onChange={(e) => {
              setSeat({ queue, filters: { ...filters, docType: e.target.value || null } });
              setAt(0);
            }}
          >
            <option value="">كل الأنواع</option>
            {docTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>

      {total === 0 || !group ? (
        <div className="empty-state">لا مادة بانتظار المراجعة. كل ما استُورد داخلٌ في الاسترجاع.</div>
      ) : (
        <>
          {/* التحديد يسقط بتغيّر الطابور أو المرشّحات: معرّفٌ حُدِّد تحت شرطٍ
              ثم تغيّر الشرط لم يعد ممّا يراه المراجع أمامه. */}
          <QueueList
            key={`${queue ?? ''}|${filters.lawId ?? ''}|${filters.capturedAt ?? ''}|${filters.docType ?? ''}`}
            groups={groups}
            total={total}
            at={at}
            busy={busy}
            progress={progress}
            onOpen={setAt}
            onApproveSelected={approveSelected}
            onSelectQueue={() => api.legalReviewQueueIds({ ...filters, queue })}
          />

          <div className="law-pager">
            <button className="btn-sm" disabled={at === 0} onClick={() => move(-1)}>السابق</button>
            <span>
              <bdi>{formatNumber(Math.min(at + 1, groups.length))}</bdi> / <bdi>{formatNumber(total)}</bdi>
            </span>
            <button className="btn-sm" disabled={at >= groups.length - 1} onClick={() => move(1)}>التالي</button>
            {/* الاختصارات تُقال ولا تُخمَّن: مراجعُ ثلاثمئة مادة يوفّر بها
                عشرات الدقائق، ولا ينتفع بما لا يعلم به. */}
            <span className="review-keys">
              <bdi>Ctrl</bdi> + <bdi>Enter</bdi> اعتماد · <bdi>←</bdi> التالي · <bdi>→</bdi> السابق
            </span>
          </div>

          <ReviewCard
            key={group[0].id}
            group={group}
            busy={busy}
            onAct={act}
            onNext={() => move(1)}
            onPrevious={() => move(-1)}
          />
        </>
      )}
    </div>
  );
}

/**
 * أحداث التعديل في شاشة المراجعة — سطرٌ لكلٍّ لا بطاقة.
 *
 * النافذةُ في الاستعراض تُفصّل لقارئٍ يقرأ مادةً واحدة، وهذه تُوجز لمراجعٍ
 * يمرّ على مئتين: الأداةُ والتاريخ ووصفُ العملية ووسمُ التطبيق في سطر، وسببُ
 * التخطّي تحته لأنه ما يحتاج القرار.
 */
function ReviewEvents({ events }: { events: AmendmentEvent[] }) {
  return (
    <ol className="review-events">
      {events.map((e, i) => (
        <li key={e.seq ?? i}>
          <div className="amendment-event-head">
            <span className="amendment-seq"><bdi>{formatNumber(i + 1)}</bdi></span>
            <span>
              <bdi>{[e.instrument, e.instrument_no].filter(Boolean).join(' ') || '—'}</bdi>
              {e.date_hijri ? <> · <bdi>{e.date_hijri}هـ</bdi></> : null}
            </span>
            <span className={`pill ${e.applied ? 'success' : 'pending'}`}>
              {e.applied ? (
                <><Icon.approved size={ICON_SM} aria-hidden /> مطبَّق</>
              ) : (
                <><Icon.warning size={ICON_SM} aria-hidden /> لم يُطبَّق</>
              )}
            </span>
            {e.result || e.scope ? (
              <span className="audit-value">
                <bdi>{e.result || e.scope}</bdi>
                {e.targets.length ? <> — <bdi>{e.targets.join('، ')}</bdi></> : null}
              </span>
            ) : null}
          </div>
          {e.new_text ? <p className="review-raw">{e.new_text}</p> : null}
          {!e.applied && e.reason ? (
            <p className="review-event-reason"><bdi>{e.reason}</bdi></p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * قائمة الطابور — نظرةٌ على ما ينتظر، وتحديدٌ لما يُعتمد جملةً.
 *
 * **وتحديدان لا واحد.** «تحديد الكل» تختار صفوف هذه الصفحة، و«تحديد الطابور
 * كلَّه» تتجاوزها إلى ما لم يُعرض. والثانية لا تظهر إلا بعد الأولى — من أراد
 * الطابور كلَّه يمرّ بصفحته أوّلاً — وتحمل عدَّه في لفظها: من لا جدول أمامه
 * يعدّه لا يعرف كم يختار إلا بما يُكتب له.
 *
 * **والمعرّفات تُجلب صريحةً في الحالين.** الشامل يطلبها من الخادم ثم يعيدها
 * إليه واحدةً واحدة، ولا يرسل شرطاً يُطابق ما لم يُحصَ. فالعدد المعروض قبل
 * التأكيد هو العدد الواقع، وكلُّ اعتماد يبقى مقيَّداً وحده في سجلّ التدقيق.
 */
function QueueList({
  groups,
  total,
  at,
  busy,
  progress,
  onOpen,
  onApproveSelected,
  onSelectQueue,
}: {
  groups: LegalArticle[][];
  total: number;
  at: number;
  busy: boolean;
  progress: { done: number; total: number } | null;
  onOpen: (index: number) => void;
  onApproveSelected: (ids: string[]) => void;
  onSelectQueue: () => Promise<{ ids: string[]; total: number; truncated: number }>;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [wide, setWide] = useState<{ ids: string[]; truncated: number } | null>(null);
  const [fetching, setFetching] = useState(false);
  const [asking, setAsking] = useState(false);

  // المحدَّد على الصفحة يُقصَر على المعروض: صفٌّ خرج من الطابور لا يبقى
  // محدَّداً في الظلّ.
  const shown = useMemo(() => groups.flat().map((a) => a.id), [groups]);
  const onPage = useMemo(() => shown.filter((id) => picked.has(id)), [shown, picked]);
  const allPicked = shown.length > 0 && onPage.length === shown.length;

  /* والتحديد الشامل يسقط بأوّل تغيّرٍ في الطابور: بتٌّ في مادة، أو إعادةُ
     تحميل، تجعل القائمة المجلوبة تصف ما لم يعد قائماً. */
  useEffect(() => setWide(null), [groups]);

  const chosen = wide ? wide.ids : onPage;

  /* وما لم يُعرض يُعدّ بالمطابقة لا بالطرح: الصفحة تعرض أخوات الرقم ولو بُتَّ
     في إحداهنّ، فطرحُ عدد الصفوف من عدد المحدَّد يُنقص ما لم يُنظر إليه. */
  const shownSet = useMemo(() => new Set(shown), [shown]);
  const unseen = wide ? wide.ids.reduce((n, id) => (shownSet.has(id) ? n : n + 1), 0) : 0;

  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const clear = () => {
    setPicked(new Set());
    setWide(null);
  };

  const selectQueue = async () => {
    setFetching(true);
    try {
      const r = await onSelectQueue();
      setWide({ ids: r.ids, truncated: r.truncated });
    } catch {
      // تعذّر الجلب: يبقى تحديد الصفحة كما هو، ولا يُدَّعى شمولٌ لم يقع.
      setWide(null);
    } finally {
      setFetching(false);
    }
  };

  return (
    <>
      <div className="kb-section">المنتظرة في الطابور</div>
      <div className="review-actions">
        <label className="import-option">
          <input
            type="checkbox"
            checked={allPicked || !!wide}
            disabled={busy || fetching || !shown.length}
            onChange={(e) => {
              if (e.target.checked) setPicked(new Set(shown));
              else clear();
            }}
          />
          تحديد الكل
        </label>
        {/* الشاملة بعد الصفحة لا مكانها، وبعدِّها لا مجرّدةً — §٧ من السجلّ.
            والعبارة في عنصرٍ واحد: `btn-sm` صندوقٌ مرن بفجوة، فكلُّ مقطعٍ نصّيّ
            فيه بندٌ مستقلّ — تتباعد الأقواس عن عددها، وينقلب ترتيبها في LTR. */}
        {allPicked && !wide && total > shown.length ? (
          <button className="btn-sm" disabled={busy || fetching} onClick={selectQueue}>
            <span>
              تحديد الطابور كلَّه (<bdi>{formatNumber(total)}</bdi>)
            </span>
          </button>
        ) : null}
        <button
          className="btn-sm primary"
          disabled={busy || fetching || !chosen.length}
          onClick={() => setAsking(true)}
        >
          اعتماد المحدَّد
        </button>
        <span className="review-keys">
          {progress ? (
            <>
              جارٍ الاعتماد <bdi>{formatNumber(progress.done)}</bdi> /{' '}
              <bdi>{formatNumber(progress.total)}</bdi>
            </>
          ) : (
            <>
              المحدَّد <bdi>{formatNumber(chosen.length)}</bdi> /{' '}
              <bdi>{formatNumber(wide ? total : shown.length)}</bdi>
            </>
          )}
        </span>
        {chosen.length && !progress ? (
          <button className="btn-sm" disabled={busy || fetching} onClick={clear}>
            إلغاء التحديد
          </button>
        ) : null}
      </div>

      {/* السقف يُقال حين يُبلَغ: «تمّ» على تحديدٍ قُصَّ نصفُه تترك ما بقي بلا
          قرارٍ ولا خبر. */}
      {wide && wide.truncated ? (
        <p className="review-keys">
          حُدِّد أوّل <bdi>{formatNumber(wide.ids.length)}</bdi> مادة، والباقي يبقى في الطابور
        </p>
      ) : null}

      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th></th>
              <th>النظام</th>
              <th>المادة</th>
              <th>سبب الإحالة للمراجعة</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g, i) =>
              g.map((a) => (
                <tr key={a.id} className={i === at ? 'row-open' : undefined}>
                  <td>
                    <input
                      type="checkbox"
                      checked={picked.has(a.id)}
                      disabled={busy}
                      onChange={() => toggle(a.id)}
                      aria-label={`تحديد المادة ${a.articleNo ?? a.id}`}
                    />
                  </td>
                  <td><bdi>{a.lawTitle || a.lawId}</bdi></td>
                  <td>
                    <bdi>{a.articleNo ?? a.id}</bdi>
                    {a.duplicateOf ? <span className="pill pending">رقم مكرّر</span> : null}
                  </td>
                  <td className="audit-value"><bdi>{a.amendNote ?? a.amendmentKind ?? '—'}</bdi></td>
                  <td>
                    <button className="btn-sm" onClick={() => onOpen(i)}>عرض</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* السؤال في نافذة المنصة لا في مربّع المتصفح — §٤ من السجلّ. والعدد في
          نصّ السؤال لا في الزرّ وحده: من حدّد خمساً وعشرين وهو يظنّها خمساً
          يقرأ الرقم قبل أن يضغط. */}
      {asking ? (
        <div className="modal-overlay" onClick={() => setAsking(false)}>
          <div className="modal-card confirm-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span className="modal-title">اعتماد المحدَّد</span>
              <button className="modal-close" onClick={() => setAsking(false)} title="إغلاق">×</button>
            </div>
            <div className="modal-body confirm-body">
              <p>
                ستدخل <bdi>{formatNumber(chosen.length)}</bdi> مادةً الاسترجاع ويُستشهد بها. ويُقيَّد في سجلّ
                التدقيق أنها اعتُمدت جملةً.
              </p>
              {/* وما لم يُعرض يُقال حين يوجد وحده: تنبيهٌ عن خطرٍ غير قائم
                  يُعلّم القارئ تجاهل التنبيهات. */}
              {unseen ? (
                <p>
                  منها <bdi>{formatNumber(unseen)}</bdi> لم تظهر على الشاشة.
                </p>
              ) : null}
            </div>
            <div className="modal-foot">
              <button className="btn-sm" onClick={() => setAsking(false)}>إلغاء</button>
              <button
                className="btn-sm primary"
                disabled={busy}
                onClick={() => {
                  const ids = chosen;
                  setAsking(false);
                  clear();
                  onApproveSelected(ids);
                }}
              >
                اعتماد
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** لوحة الحال: أين وصلت المراجعة، وأيّ طابورٍ يستحقّ الجلسة القادمة. */
function ReviewDashboardPanel({ dash }: { dash: ReviewDashboard }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>المقاطع</th>
            <th>الداخلة في الاسترجاع</th>
            <th>المنتظرة في الطابور</th>
            <th>معتمدة</th>
            <th>محرَّرة</th>
            <th>مستبعدة</th>
            <th>مؤجَّلة</th>
            <th>آخر نشاط مراجعة</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><bdi>{formatNumber(dash.chunks)}</bdi></td>
            <td><bdi>{formatNumber(dash.retrievable)}</bdi></td>
            <td><bdi>{formatNumber(dash.in_queue)}</bdi></td>
            <td><bdi>{formatNumber(dash.approved)}</bdi></td>
            <td><bdi>{formatNumber(dash.edited)}</bdi></td>
            <td><bdi>{formatNumber(dash.rejected)}</bdi></td>
            <td><bdi>{formatNumber(dash.deferred)}</bdi></td>
            <td>
              {dash.last_activity ? (
                <bdi>{formatDate(dash.last_activity)} {formatTime(dash.last_activity)}</bdi>
              ) : (
                '—'
              )}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** بطاقة المراجعة: ترويسةٌ، وثلاثة نصوص متقابلة، وإجراءات. */
function ReviewCard({
  group,
  busy,
  onAct,
  onNext,
  onPrevious,
}: {
  group: LegalArticle[];
  busy: boolean;
  onAct: (id: string, action: ReviewAction, body?: { text?: string; note?: string }) => void;
  onNext: () => void;
  onPrevious: () => void;
}) {
  const first = group[0];
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDrafts({});
    setNote('');
  }, [first.id]);

  const draftOf = (a: LegalArticle) => drafts[a.id] ?? a.text;
  const changed = (a: LegalArticle) => draftOf(a).trim() !== a.text.trim();

  const commit = (a: LegalArticle) =>
    changed(a)
      ? onAct(a.id, 'edit', { text: draftOf(a).trim(), note: note.trim() || undefined })
      : onAct(a.id, 'approve', note.trim() ? { note: note.trim() } : {});

  /* الاختصارات على البطاقة لا على النافذة كلِّها: مراجعٌ يكتب في حقلٍ آخر من
     الشاشة لا يُعتمد عليه بضغطة سهم. و`Ctrl+Enter` يعمل داخل حقل التحرير
     نفسه لأنه لا يُنتج حرفاً، والسهمان لا يعملان فيه لأنهما يحرّكان المؤشّر. */
  const onKey = (e: React.KeyboardEvent) => {
    const inField = (e.target as HTMLElement).matches('textarea, input');
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!busy) commit(first);
      return;
    }
    if (inField) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onNext();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      onPrevious();
    }
  };

  return (
    <div className="review-card" ref={box} onKeyDown={onKey} tabIndex={-1}>
      <ReviewHeading a={first} />

      {group.map((a) => (
        <ArticlePanes
          key={a.id}
          a={a}
          multi={group.length > 1}
          draft={draftOf(a)}
          onDraft={(text) => setDrafts((d) => ({ ...d, [a.id]: text }))}
          busy={busy}
          onAct={onAct}
          onCommit={() => commit(a)}
          changed={changed(a)}
          note={note}
        />
      ))}

      <ArticleAudit id={first.id} />

      <div className="review-actions">
        <label className="compare-label" htmlFor={`note-${first.id}`}>ملاحظة المراجع</label>
        <textarea
          id={`note-${first.id}`}
          className="cfg-prompt review-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button className="btn-sm" disabled={busy || !note.trim()} onClick={() => onAct(first.id, 'note', { note: note.trim() })}>
          حفظ الملاحظة
        </button>
      </div>
    </div>
  );
}

/** ترويسة المادة: من أين هي، وبأيّ أداةٍ عُدِّلت، ولماذا أُحيلت. */
function ReviewHeading({ a }: { a: LegalArticle }) {
  const line = [
    a.lawTitle || a.lawId,
    [a.instrument, a.instrumentNo].filter(Boolean).join(' '),
    [a.book, a.chapter].filter(Boolean).join(' — '),
    a.articleNo ? `المادة ${a.articleNo}` : '',
    a.articleTitle,
    [a.amendmentInstrument, a.amendedOn].filter(Boolean).join(' — '),
  ].filter(Boolean);

  return (
    <div className="law-head">
      <h3>
        <bdi>{a.lawTitle || a.lawId}</bdi>
        <ReviewStatusPill status={a.reviewStatus} />
      </h3>
      <p>
        {line.slice(1).map((part, i) => (
          <span key={i}>
            {i > 0 ? ' — ' : ''}
            <bdi>{part}</bdi>
          </span>
        ))}
      </p>
      {a.amendNote ? (
        <>
          <div className="compare-label">سبب الإحالة للمراجعة</div>
          <p><bdi>{a.amendNote}</bdi></p>
        </>
      ) : null}
      {a.sourceUrl ? (
        <p>
          <a href={a.sourceUrl} target="_blank" rel="noreferrer">المصدر</a>
        </p>
      ) : null}
    </div>
  );
}

/** الأعمدة الثلاثة: نصّ المادة قابلاً للتحرير، والنصّ السابق، ونصّ التعديل. */
function ArticlePanes({
  a,
  multi,
  draft,
  onDraft,
  busy,
  onAct,
  onCommit,
  changed,
  note,
}: {
  a: LegalArticle;
  multi: boolean;
  draft: string;
  onDraft: (text: string) => void;
  busy: boolean;
  onAct: (id: string, action: ReviewAction, body?: { text?: string; note?: string }) => void;
  onCommit: () => void;
  changed: boolean;
  note: string;
}) {
  const [amendment, setAmendment] = useState<LegalAmendment | null>(null);

  useEffect(() => {
    setAmendment(null);
    api.legalAmendment(a.id).then((r) => setAmendment(r.amendment)).catch(() => {});
  }, [a.id]);

  const superseded = amendment?.text_superseded ?? '';

  return (
    <div className="review-panes-wrap">
      {multi ? (
        <div className="kb-section">
          المادة <bdi>{a.articleNo}</bdi>
          {a.duplicateIndex ? <> — <bdi>{formatNumber(a.duplicateIndex)}</bdi></> : null}
          <ReviewStatusPill status={a.reviewStatus} />
        </div>
      ) : null}

      <div className="review-panes">
        <div>
          <label className="compare-label" htmlFor={`text-${a.id}`}>نصّ المادة</label>
          <textarea
            id={`text-${a.id}`}
            className="cfg-prompt review-text"
            value={draft}
            disabled={busy}
            onChange={(e) => onDraft(e.target.value)}
          />
        </div>
        <div>
          <div className="compare-label">النصّ السابق</div>
          {/* إبرازُ الفرق بعنصرَي `ins` و`del` لا باللون وحده: قارئ الشاشة
              ينطقهما إدراجاً وحذفاً، ومن لا يميّز الأحمر عن الأخضر يقرؤهما. */}
          {superseded ? <DiffText from={superseded} to={draft} /> : <p className="legal-notice-meta">—</p>}
        </div>
        <div>
          <div className="compare-label">نصّ التعديل</div>
          <p className="review-raw">{amendment?.amendments_raw || '—'}</p>
        </div>
      </div>

      {/* سجلّ التعديلات مفكَّكاً تحت الألواح الثلاثة.
          به تصير المراجعة تحقّقاً من خطوةٍ معلومة لا قراءةَ نصٍّ خام: المراجع
          يرى ما طُبِّق وما تُخطّي وسببه، فيعرف ما عليه أن يدمجه بيده. */}
      {amendment?.events.length ? (
        <>
          <div className="compare-label">سجل التعديلات</div>
          <ReviewEvents events={amendment.events} />
        </>
      ) : null}

      <div className="review-actions">
        <button className="btn-sm primary" disabled={busy} onClick={onCommit}>
          {changed ? 'تحرير واعتماد' : 'اعتماد'}
        </button>
        <button className="btn-sm" disabled={busy} onClick={() => onAct(a.id, 'exclude', { note: note.trim() || undefined })}>
          استبعاد
        </button>
        <button className="btn-sm" disabled={busy} onClick={() => onAct(a.id, 'defer', { note: note.trim() || undefined })}>
          تأجيل
        </button>
        {a.wasEdited ? (
          <button className="btn-sm" disabled={busy} onClick={() => onAct(a.id, 'undo')}>
            تراجع
          </button>
        ) : null}
        {changed ? (
          <span className="pill warn">
            <Icon.reviewEdited size={ICON_SM} aria-hidden /> محرَّرة
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** أسماء الحقول المقيَّدة، بالعربية. */
const AUDIT_FIELDS: Record<string, string> = {
  review_status: 'حال المراجعة',
  text: 'نصّ المادة',
  review_note: 'ملاحظة المراجع',
};

/** حالُ المراجعة بلفظها في السجلّ — القيمة المخزَّنة إنجليزية والقارئ عربيّ. */
const AUDIT_STATUS: Record<string, string> = {
  pending: 'بانتظار المراجعة',
  approved: 'معتمدة',
  edited: 'محرَّرة',
  rejected: 'مستبعدة',
  deferred: 'مؤجَّلة',
};

const auditValue = (field: string, value: string | null) =>
  value == null || value === '' ? '—' : field === 'review_status' ? (AUDIT_STATUS[value] ?? value) : value;

/**
 * سجلّ تدقيق المادة — من غيّر ماذا ومتى.
 *
 * يُقرأ حيث يُتّخذ القرار لا في شاشةٍ ثانية: مراجعٌ يرى أن غيره استبعدها أمس
 * لا يستبعدها اليوم مرّةً أخرى. وفي منتجٍ قانوني يُسأل المرء لاحقاً من أين
 * جاء نصّ مادةٍ في استشارة ومن اعتمده — فقيدٌ لا يُقرأ نصفُ قيد.
 */
function ArticleAudit({ id }: { id: string }) {
  const [entries, setEntries] = useState<ReviewAuditEntry[]>([]);

  useEffect(() => {
    setEntries([]);
    api.legalReviewAudit(id, 20).then((r) => setEntries(r.entries)).catch(() => {});
  }, [id]);

  if (!entries.length) return null;
  return (
    <>
      <div className="kb-section">سجلّ التدقيق</div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>الحقل</th>
              <th>قبل</th>
              <th>بعد</th>
              <th>المراجع</th>
              <th>التاريخ</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{AUDIT_FIELDS[e.field] ?? e.field}</td>
                <td className="audit-value"><bdi>{auditValue(e.field, e.old_value)}</bdi></td>
                <td className="audit-value"><bdi>{auditValue(e.field, e.new_value)}</bdi></td>
                <td><bdi>{e.actor_id ?? '—'}</bdi></td>
                <td><bdi>{formatDate(e.at)} {formatTime(e.at)}</bdi></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

