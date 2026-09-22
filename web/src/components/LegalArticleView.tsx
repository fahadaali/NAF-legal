// عرض المادة النظامية — بشاراتها وتنبيهاتها.
//
// شاشتان تعرضان المادة: تصفّح النظام ومراجعة المواد. وعرضُها في موضعين بنسختين
// يجعل تنبيهاً يُصلَح في إحداهما ويبقى في الأخرى — والتنبيه هنا ليس زينة:
// مادةٌ عُدِّلت ونصُّها المعروض أصليّ، ومن يستشهد به يستشهد بما نُسخ.
//
// والنصوص كلُّها مسجَّلة في `naf-terms.md` تحت «مصطلحات المحتوى النظامي»
// و«تنبيهات المادة». والأيقونتان مسجَّلتان في `naf-icons.md`: «تحذير»
// (`TriangleAlert`) و«بانتظار المراجعة» (`Clock`) — ولا ثالثة هنا.
import { useEffect, useState, type ReactNode } from 'react';
import { api, type LegalAmendment, type LegalArticle } from '../lib/api';
import { DiffText } from '../lib/diff';
import { formatDualDate, formatNumber } from '../lib/format';
import { Icon, ICON_SM } from '../lib/icons';
import { modalCardProps, useModalDismiss } from '../lib/modal';

/**
 * تنبيهات المادة — نصُّها من السجلّ حرفاً بحرف.
 *
 * ونسختُها الأخرى في `src/lib/legal.ts` تصحب المقطع إلى البرومبت: مسار
 * التوليد لا يمرّ بهذه الشاشة، فلو انفرد التنبيه بها لوصل النصُّ الأصليّ إلى
 * الإجابة مجرَّداً. حزمتان لا تتشاركان ملفاً، والسجلّ هو ما يجمع نصَّيهما.
 */
const AMENDMENT_NOTICE = 'هذه المادة عُدّلت، والنص المعروض هو الأصلي — راجع نص التعديل';
const DEFERRED_NOTICE = 'هذه المادة نافذة من تاريخٍ لم يحل بعد — راجع تاريخ النفاذ قبل الاستشهاد';
const DUPLICATE_NOTICE = 'في هذا النظام أكثر من مادة بهذا الرقم — اقرأها كلَّها';

/**
 * يومٌ ميلاديّ `YYYY-MM-DD` تاريخاً محلياً — لا منتصفَ ليلٍ بتوقيتٍ عالميّ
 * ينقلب إلى اليوم السابق في منطقةٍ غربيّ غرينتش.
 */
function isoDay(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/**
 * تاريخٌ نظاميّ — نفاذُ نظامٍ أو إلغاؤه: ميلاديٌّ يتبعه الهجريّ بين قوسين
 * (CLAUDE.md §8). والصيغةُ من المكتبة المشتركة لا مركّبةٌ هنا.
 */
function statutoryDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDualDate(isoDay(value)) : value;
}

/**
 * تُعرض بعناوينها لا بأرقامها: الملحق رقمُه اصطلاحيّ (`1001`) لا يُعرض ولا
 * يُستشهد به أبداً (§3-12)، ورقمُ المرفق ومادة «مكرر» رقمُ مادةٍ أخرى.
 */
function byLabel(a: LegalArticle): boolean {
  return !!(a.isAnnex || a.isAttachment || a.isMukarrar);
}

/**
 * اسمُ المادة القصير — لسطر النتيجة وشارة الطابور.
 *
 * «المادة 74» لما يُستدعى برقمه، وعنوانُه كما ورد لما لا يُستدعى به. والمرفقُ
 * بلا عنوانٍ في ملفه يأخذ «مرفق» المسجَّلة، والملحقُ بلا عنوانٍ لا يُسمّى برقمه
 * بل بمعرّفه.
 */
export function ArticleName({ a }: { a: LegalArticle }) {
  if (byLabel(a)) {
    return <bdi>{a.articleLabel || (a.isAttachment ? 'مرفق' : a.id)}</bdi>;
  }
  return a.articleNo ? (
    <>
      المادة <bdi>{a.articleNo}</bdi>
    </>
  ) : (
    <bdi>{a.id}</bdi>
  );
}

/**
 * وسوم حال النظام بجانب اسمه (§7-2) — لفظاً وأيقونةً ولوناً كما سُجّلت في
 * `naf-terms.md` و`naf-icons.md` تحت «حالُ النظام».
 *
 * و«لم يبدأ العمل به» مُقيَّمةٌ بتاريخ اليوم في طبقة الاسترجاع: نظامٌ حلّ يومُ
 * نفاذه يسقط وسمُه ولو لم تُرفع دفعةٌ بعده (§6-8).
 */
export function LawTags({ repealed, pending, from }: { repealed?: boolean; pending?: boolean; from?: string | null }) {
  return (
    <>
      {repealed ? (
        <span className="pill error">
          <Icon.repealedLaw size={ICON_SM} aria-hidden /> نظام لاغٍ
        </span>
      ) : null}
      {pending ? (
        <span className="pill warn">
          {/* اللفظ وتاريخه عنصرٌ واحد في الوسم: عنصران يلتفّ كلٌّ منهما في
              عموده على الشاشة الضيّقة، فيُقرأ «من» تحت اللفظ والتاريخُ مشطوراً
              بجانبه. والتاريخ لا ينكسر في منتصفه. */}
          <Icon.lawPending size={ICON_SM} aria-hidden />
          <span>
            لم يبدأ العمل به
            {from ? (
              <>
                {' — من '}
                <bdi className="pill-date">{statutoryDate(from)}</bdi>
              </>
            ) : null}
          </span>
        </span>
      ) : null}
    </>
  );
}

/**
 * نظامان باسمٍ واحد يُميَّز بينهما بأداة الإصدار وتاريخه لا بالاسم (§7-2):
 * القديم اللاغي والجديد قد يجتمعان في نتائج بحثٍ واحدة.
 */
export function LawIdentity({ a }: { a: LegalArticle }) {
  const parts = [[a.instrument, a.instrumentNo].filter(Boolean).join(' '), a.issueDateHijri].filter(
    (p): p is string => !!p
  );
  if (!parts.length) return null;
  return (
    <p className="legal-notice-meta">
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 ? ' — ' : ''}
          <bdi>{part}</bdi>
        </span>
      ))}
    </p>
  );
}

/**
 * ترويسة المادة: رقمها وعنوانها.
 *
 * و`shown` عددُ أجزائها المعروضة هنا: المادة الطويلة تُقسَّم في الملف إلى
 * `#a` و`#b`، وتُعرض متتابعةً كمادةٍ واحدة. فإن حضرت أجزاؤها كلُّها فلا شأن
 * للقارئ بالتقسيم؛ وإن قطعت الصفحةُ بينها قيل له أيّ جزءٍ بين يديه، وإلا ظنّ
 * المادة ناقصة.
 */
function ArticleHeading({ a, shown }: { a: LegalArticle; shown: number }) {
  const partial = a.part && a.partsTotal ? shown < a.partsTotal : false;
  return (
    <>
      {/* بلفظها في النظام حين يرد (§7-2): «المادة الخامسة والأربعون» كما في
          المصدر. وما يُعرض بعنوانه يُعرض بعنوانه وحده. */}
      {!byLabel(a) && a.articleLabel ? <bdi>{a.articleLabel}</bdi> : <ArticleName a={a} />}
      {partial ? (
        <span className="pill pending">
          جزء المادة <bdi>{a.part}</bdi> / <bdi>{formatNumber(a.partsTotal ?? 0)}</bdi>
        </span>
      ) : null}
      {a.articleTitle ? (
        <span className="legal-article-title">
          <bdi>{a.articleTitle}</bdi>
        </span>
      ) : null}
    </>
  );
}

/**
 * حالُ المادة عند المراجع — لفظاً وأيقونةً ولوناً، كما في `naf-icons.md`.
 *
 * والمعتمدة والمحرَّرة تشتركان في `success` عن قصد: كلتاهما داخلةٌ في
 * الاسترجاع، واللون يقول العائلة والأيقونة تقول أيّهما.
 */
const REVIEW_STATUS: Record<string, { label: string; cls: string; icon: keyof typeof Icon } | undefined> = {
  pending: { label: 'بانتظار المراجعة', cls: 'warn', icon: 'pendingReview' },
  approved: { label: 'معتمدة', cls: 'ready', icon: 'approved' },
  edited: { label: 'محرَّرة', cls: 'ready', icon: 'reviewEdited' },
  rejected: { label: 'مستبعدة', cls: 'error', icon: 'reviewExcluded' },
  deferred: { label: 'مؤجَّلة', cls: 'pending', icon: 'reviewDeferred' },
};

/** شارة الحال وحدها — تُستعمل في الطابور وفي سطر المادة. */
export function ReviewStatusPill({ status }: { status: string }) {
  const s = REVIEW_STATUS[status];
  if (!s) return null;
  const Glyph = Icon[s.icon];
  return (
    <span className={`pill ${s.cls}`}>
      <Glyph size={ICON_SM} aria-hidden /> {s.label}
    </span>
  );
}

/**
 * شارات حال المادة — لا تُقرأ باللون وحده: لكلٍّ لفظُها وأيقونتها.
 *
 * وحالُ المراجعة تُقرأ من `reviewStatus` لا من `needsReview`: الأول قرارُ
 * المراجع والثاني ما قاله الملف، ومادةٌ اعتُمدت يبقى وسمُها كما ورد.
 */
export function ArticleFlags({ a }: { a: LegalArticle }) {
  // حالُ المادة في النظام أوّلاً، ثم حالُ عملنا عليها: الأولى واقعةٌ نظامية
  // يقرؤها المحامي، والثانية أثرُ عملٍ داخليّ. وأيقونتاهما مختلفتان في
  // `naf-icons.md` لهذا بعينه.
  const repealed = a.retrievalStatus === 'repealed' || a.isRepealed || a.status === 'repealed';
  return (
    <>
      {repealed ? (
        <span className="pill error">
          <Icon.repealedArticle size={ICON_SM} aria-hidden /> ملغاة
        </span>
      ) : null}
      {/* إلغاءٌ مجدول لم يحلّ يومه — وبعده تأخذ المادة «ملغاة» ويخرج الوسم. */}
      {a.scheduledRepealFrom && !repealed ? (
        <span className="pill warn">
          <Icon.scheduledRepeal size={ICON_SM} aria-hidden />
          <span>
            تُلغى في <bdi className="pill-date">{statutoryDate(a.scheduledRepealFrom)}</bdi>
          </span>
        </span>
      ) : null}
      {/* ومستبقاةٌ بجانب «نظام لاغٍ» تبدو خطأً بلا وسمها — لونُه محايد: تفسيرٌ لا تحذير. */}
      {a.keptAfterRepeal && !repealed ? (
        <span className="pill pending">
          <Icon.keptAfterRepeal size={ICON_SM} aria-hidden /> مستبقاة بعد إلغاء النظام
        </span>
      ) : null}
      {a.needsReview ? <ReviewStatusPill status={a.reviewStatus} /> : null}
      {a.duplicateOf ? <span className="pill pending">رقم مكرّر</span> : null}
      {/* الرقم السابق تصنيفٌ لا حالة: من بحث بالقديم يعرف لماذا ظهرت له هذه. */}
      {a.formerArticleNo ? (
        <span className="pill outline">
          الرقم السابق <bdi>{a.formerArticleNo}</bdi>
        </span>
      ) : null}
    </>
  );
}

/**
 * التنبيهات فوق النصّ لا تحته.
 *
 * ما يُقرأ بعد النصّ يُقرأ متأخراً — وقد نُسخ النصُّ إلى مذكرةٍ قبل أن يبلغه
 * القارئ. والتنبيه يقول ما العمل لا الحال وحده، فمعه أداةُ التعديل وتاريخُه
 * ومدخلٌ إلى نصّه.
 */
export function ArticleNotices({ a, onOpenAmendment }: { a: LegalArticle; onOpenAmendment?: () => void }) {
  // الشريط بحال الاسترجاع وحدها (§7-2): «نافذ بتحذير» ⇦ شريطٌ نصُّه من
  // `retrieval_warning`. ولا يُشتقّ من الحقول المنطقية (§3-4) — كان الاشتقاق
  // يعيد التحذير على مادةٍ صعّد مراجعٌ حالها بعد أن قرأ ألواحها.
  //
  // ونصُّ التحذير يأتي جاهزاً من طبقة الاسترجاع: قد يكون تعديلاً لم يُدمج، وقد
  // يكون نظاماً لم يبدأ العمل به بتاريخ نفاذه والنافذ قبله. وما لم يأتِ يقع على
  // اللفظ المسجَّل لسببه.
  const warned = a.retrievalStatus === 'effective_warning';
  const warning = a.retrievalWarning || (a.lawPending && !a.hasAmendments ? DEFERRED_NOTICE : AMENDMENT_NOTICE);
  const effectiveOn = a.effectiveFrom || a.effectiveFromHijri;
  // تنبيه النفاذ المؤجَّل لا يتكرّر إن كان هو نصَّ الشريط نفسه.
  const deferred = a.effectivePending && !(warned && warning === DEFERRED_NOTICE);
  if (!warned && !deferred && !a.duplicateOf) return null;

  return (
    <>
      {warned ? (
        <div className="legal-notice">
          <Icon.warning size={ICON_SM} aria-hidden />
          <div>
            <p>{warning}</p>
            <p className="legal-notice-meta">
              {[
                a.amendmentKind ? `نوع التعديل: ${a.amendmentKind}` : '',
                a.amendmentInstrument ? `أداة التعديل: ${a.amendmentInstrument}` : '',
                a.amendedOn ? `تاريخ التعديل: ${a.amendedOn}` : '',
              ]
                .filter(Boolean)
                .map((part, i) => (
                  <span key={i}>
                    {i > 0 ? ' — ' : ''}
                    <bdi>{part}</bdi>
                  </span>
                ))}
            </p>
            {/* والمدخل إلى نصّ التعديل حين يكون للمادة تعديل — تحذيرُ نظامٍ لم يبدأ
                العمل به لا نافذةَ تعديلٍ وراءه. */}
            {onOpenAmendment && a.hasAmendments ? (
              <button className="btn-sm" onClick={onOpenAmendment}>
                نصّ التعديل
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {deferred ? (
        <div className="legal-notice">
          <Icon.warning size={ICON_SM} aria-hidden />
          <div>
            <p>{DEFERRED_NOTICE}</p>
            {effectiveOn ? (
              <p className="legal-notice-meta">
                <bdi>{effectiveOn}</bdi>
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {a.duplicateOf ? (
        <div className="legal-notice">
          <Icon.warning size={ICON_SM} aria-hidden />
          <div>
            <p>{DUPLICATE_NOTICE}</p>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * نافذة سجلّ التعديلات — ثلاثة تبويبات.
 *
 * **والتاريخ لا يُخفى بل يُطوى خلف زرّ.** البطاقة تعرض النافذ وحده، ومن أراد
 * أن يعرف كيف صار كذلك فتح هذه. وتُطلب عند فتحها لا مع كل نتيجة: نافذةُ
 * البوابة الخام قد تبلغ آلاف الأحرف.
 *
 * وتُفتح برابطٍ مباشر `#amendments` ليصلح الاستشهاد بها من إجابة المساعد،
 * وتُغلق بـ`Esc` وبالنقر خارجها.
 */
export function AmendmentWindow({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<LegalAmendment | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<'log' | 'timeline' | 'original'>('log');

  useEffect(() => {
    setData(null);
    setFailed(false);
    api
      .legalAmendment(id)
      .then((r) => setData(r.amendment))
      .catch(() => setFailed(true));
  }, [id]);

  // `Esc` تُغلق كما يُغلق النقر خارجها — ومن فتحها بلوحة المفاتيح يُغلقها بها.
  useModalDismiss(onClose);

  const TABS: [typeof tab, string, keyof typeof Icon][] = [
    ['log', 'سجل التعديلات', 'amendmentLog'],
    ['timeline', 'الخط الزمني', 'versionTimeline'],
    ['original', 'الأصل', 'originalText'],
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card amendment-card" {...modalCardProps}>
        <div className="modal-head">
          <span className="modal-title">سجل التعديلات</span>
          <button className="modal-close" onClick={onClose} title="إغلاق">×</button>
        </div>

        <div className="amendment-tabs" role="tablist">
          {TABS.map(([key, label, icon]) => {
            const Glyph = Icon[icon];
            return (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                className={`btn-sm ${tab === key ? 'primary' : ''}`}
                onClick={() => setTab(key)}
              >
                <Glyph size={ICON_SM} aria-hidden /> {label}
              </button>
            );
          })}
        </div>

        <div className="modal-body">
          {failed ? <p className="legal-notice-meta">تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة</p> : null}
          {!failed && !data ? <p className="legal-notice-meta">جارٍ التحميل</p> : null}
          {data && tab === 'log' ? <AmendmentLog data={data} /> : null}
          {data && tab === 'timeline' ? <VersionTimeline versions={data.versions} /> : null}
          {data && tab === 'original' ? <OriginalTab data={data} /> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * التبويب الأوّل: بطاقةٌ لكل حدثٍ بترتيبه الزمني.
 *
 * **والحدث غير المطبَّق لا يُخفى ولا يُطوى.** هو بالضبط ما يحتاج المحامي أن
 * يعرفه: ثمّة تعديل صادر ولم يُدمج، وهذا نصُّه وهذا سببه. والمطويّ وحده هو
 * صياغة البوابة الحرفية — لمن أرادها.
 */
function AmendmentLog({ data }: { data: LegalAmendment }) {
  if (!data.events.length) {
    return (
      <>
        {data.amend_note ? (
          <div className="amendment-event">
            <div className="compare-label">سبب الإحالة للمراجعة</div>
            <p><bdi>{data.amend_note}</bdi></p>
          </div>
        ) : null}
        {data.amendments_raw ? (
          <div className="amendment-event">
            <div className="compare-label">نصّ التعديل كما ورد في البوابة</div>
            <p className="review-raw">{data.amendments_raw}</p>
          </div>
        ) : (
          <p className="legal-notice-meta">لا سجلّ تعديلاتٍ مفكَّكاً لهذه المادة</p>
        )}
      </>
    );
  }

  return (
    <>
      {data.events.map((e, i) => (
        <div key={e.seq ?? i} className="amendment-event">
          <div className="amendment-event-head">
            <span className="amendment-seq"><bdi>{formatNumber(i + 1)}</bdi></span>
            <span>
              <bdi>{[e.instrument, e.instrument_no].filter(Boolean).join(' ') || '—'}</bdi>
              {e.date_hijri ? <> · <bdi>{e.date_hijri}هـ</bdi></> : null}
            </span>
            {/* الوسم أيقونةٌ ولفظ لا لونٌ وحده: من لا يميّز الأخضر عن الأصفر
                يقرأ «مطبَّق» و«لم يُطبَّق» كما يقرؤهما غيره. */}
            <span className={`pill ${e.applied ? 'ready' : 'warn'}`}>
              {e.applied ? (
                <><Icon.approved size={ICON_SM} aria-hidden /> مطبَّق</>
              ) : (
                <><Icon.warning size={ICON_SM} aria-hidden /> لم يُطبَّق</>
              )}
            </span>
          </div>

          {e.result || e.scope ? (
            <p className="amendment-result">
              <bdi>{e.result || e.scope}</bdi>
              {e.targets.length ? <> — <bdi>{e.targets.join('، ')}</bdi></> : null}
            </p>
          ) : null}

          {e.effective_from ? (
            <p className="legal-notice-meta">يسري من <bdi>{e.effective_from}</bdi></p>
          ) : null}

          {e.new_text ? (
            <>
              <div className="compare-label">النصّ المستحدَث</div>
              <p className="review-raw">{e.new_text}</p>
            </>
          ) : null}

          {/* السبب بارزٌ لا مطويّ: هو ما يفرّق «لم يُدمج» عن «لا تعديل». */}
          {!e.applied && e.reason ? (
            <div className="legal-notice">
              <Icon.warning size={ICON_SM} aria-hidden />
              <div>
                <div className="compare-label">سبب عدم التطبيق</div>
                <p><bdi>{e.reason}</bdi></p>
              </div>
            </div>
          ) : null}

          {e.raw ? (
            <details>
              <summary>نصّ التعديل كما ورد في البوابة</summary>
              <p className="review-raw">{e.raw}</p>
            </details>
          ) : null}
        </div>
      ))}
    </>
  );
}

/**
 * التبويب الثاني: النسخ، والمعتمدة مفتوحةٌ افتراضاً.
 *
 * **وإبراز الفرق هو أنفع ما في النافذة.** نصّان متجاوران يترك المقابلة على
 * عين القارئ، وهذه تقول له *ما الذي تغيّر*. وبعنصرَي `ins` و`del` لا باللون
 * وحده: قارئ الشاشة ينطقهما إدراجاً وحذفاً.
 */
function VersionTimeline({ versions }: { versions: LegalAmendment['versions'] }) {
  const currentIndex = Math.max(0, versions.findIndex((v) => v.current));
  const [at, setAt] = useState(currentIndex);
  const [copied, setCopied] = useState(false);

  useEffect(() => setAt(currentIndex), [currentIndex]);

  if (!versions.length) return <p className="legal-notice-meta">لا خطَّ زمنيّ لهذه المادة</p>;

  const shown = versions[Math.min(at, versions.length - 1)];
  const previous = at > 0 ? versions[at - 1] : null;

  const copy = () => {
    // النصّ وحده بلا وسوم: من نسخ نسخ نصّاً لا بطاقة.
    navigator.clipboard?.writeText(shown.text).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); },
      () => {}
    );
  };

  return (
    <>
      <ol className="version-list">
        {versions.map((v, i) => (
          <li key={v.seq ?? i}>
            <button
              className={`btn-sm ${i === at ? 'primary' : ''}`}
              aria-current={i === at ? 'true' : undefined}
              onClick={() => setAt(i)}
            >
              <bdi>{v.label || `نسخة ${formatNumber(i + 1)}`}</bdi>
              {v.current ? ' — المعتمد' : ''}
            </button>
          </li>
        ))}
      </ol>

      {/* والوسم يقول ما هي وما لا يُفعل بها معاً: «نسخة تاريخية» وحدها تُقرأ
          تصنيفاً محايداً، فينسخ القارئ ما لم يعد قائماً. */}
      {!shown.current ? (
        <div className="legal-notice">
          <Icon.warning size={ICON_SM} aria-hidden />
          <div><p>نسخة تاريخية — لا يُستشهد بها</p></div>
        </div>
      ) : null}

      <div className="version-actions">
        <button className="btn-sm" onClick={copy}>
          <Icon.copy size={ICON_SM} aria-hidden /> {copied ? 'تم النسخ' : 'نسخ'}
        </button>
        {shown.from_instrument || shown.from_date ? (
          <span className="legal-notice-meta">
            <bdi>{[shown.from_instrument, shown.from_date ? `${shown.from_date}هـ` : ''].filter(Boolean).join(' · ')}</bdi>
          </span>
        ) : null}
      </div>

      {previous ? (
        <>
          <div className="compare-label">الفرق عن سابقتها</div>
          <DiffText from={previous.text} to={shown.text} />
        </>
      ) : (
        <p className="legal-text">{shown.text}</p>
      )}
    </>
  );
}

/** التبويب الثالث: النصّ قبل أوّل تعديل، ونافذة البوابة حرفياً، والمصدر. */
function OriginalTab({ data }: { data: LegalAmendment }) {
  const original = data.text_superseded || data.versions.find((v) => !v.current)?.text || null;
  return (
    <>
      {original ? (
        <>
          <div className="compare-label">الأصل</div>
          <p className="legal-text">{original}</p>
        </>
      ) : (
        <p className="legal-notice-meta">لا نصّ أصليّ محفوظ لهذه المادة — لم تُعدَّل</p>
      )}

      {data.amendments_raw ? (
        <>
          <div className="compare-label">نصّ التعديل كما ورد في البوابة</div>
          <p className="review-raw">{data.amendments_raw}</p>
        </>
      ) : null}

      {data.source_url ? (
        <p>
          <a href={data.source_url} target="_blank" rel="noreferrer">
            <Icon.externalLink size={ICON_SM} aria-hidden /> المصدر في بوابة هيئة الخبراء
          </a>
        </p>
      ) : null}
    </>
  );
}

/* وأُسقطت هنا `AmendmentPanel`: لوحٌ يعرض التعديلات الخام «للوحة المراجعة
   الثلاثية» بنصّ توثيقها — و`LegalReview.tsx` لا يستوردها ولم يستوردها قطّ.
   ومحتواها هو محتوى `AmendmentWindow` أعلاه بعينه، وتلك مستعملة. فمن أراد
   لوحاً غيرَ نافذة يشتقّه منها، ونسخةٌ ثانيةٌ تنتظر مستهلِكاً ليست طريقاً
   إلى ذلك. */

/**
 * المادة كاملةً: ترويستها وشاراتها وتنبيهاتها ونصُّها.
 *
 * والمدخل مجموعةُ أجزاءٍ لا جزءاً واحداً: `#a` و`#b` أجزاءُ مادةٍ واحدة
 * تُعرض متتابعةً، لا مادتان يفصل بينهما عنوانان. وأكثر المواد جزءٌ واحد،
 * فتمرّ مجموعةً من عنصرٍ واحد.
 */
export function ArticleCard({
  group,
  attachments = [],
  showSource = true,
  children,
}: {
  group: LegalArticle[];
  /** مرفقاتُ المادة (§3-11) — تُعرض تحتها بعناوينها. */
  attachments?: LegalArticle[];
  /** رابطُ المصدر في ذيل البطاقة (§7-2) — ونافذة المصدر تحمله في ذيلها فتُسقطه هنا. */
  showSource?: boolean;
  children?: ReactNode;
}) {
  const [openAmendment, setOpenAmendment] = useState(false);
  const a = group[0];

  /* رابطٌ مباشر إلى النافذة: `#amendments` على معرّف المادة. إجابةُ المساعد
     تستشهد بمادة، ورابطُها يجب أن يفتح ما استند إليه لا الصفحة وحدها. */
  useEffect(() => {
    if (!a) return;
    const check = () => {
      const hash = decodeURIComponent(window.location.hash);
      setOpenAmendment(hash === `#${a.id}#amendments` || hash === '#amendments');
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, [a?.id]);

  if (!a) return null;
  return (
    <article className="legal-article" id={a.id}>
      <h4>
        <ArticleHeading a={a} shown={group.length} />
        <ArticleFlags a={a} />
        {/* زرُّ التاريخ يظهر حين يكون له تاريخ، ويحمل عدَّه. */}
        {a.hasAmendments ? (
          <button className="btn-sm" onClick={() => setOpenAmendment(true)}>
            <Icon.amendmentLog size={ICON_SM} aria-hidden /> عليها تعديل
            {a.amendmentsCount ? <> (<bdi>{formatNumber(a.amendmentsCount)}</bdi>)</> : null}
          </button>
        ) : null}
      </h4>
      <ArticleNotices a={a} onOpenAmendment={() => setOpenAmendment(true)} />
      {/* أسطر الفقرات تبقى: التعداد جزءٌ من المعنى النظامي، ودمجُه في فقرةٍ
          واحدة يُفسده — «١ - … ٢ - …» تصير جملةً متّصلة لا تُقرأ حكماً. */}
      {group.map((part) => (
        <p key={part.id} className="legal-text">{part.text}</p>
      ))}
      {/* المرفق تحت مادته بعنوانه (§7-2)، مطويّاً إن طال: غالبُ المرفقات جداول
          ونصوصُ موادَّ مستحدثة، وجدولٌ مبسوط يُبعد القارئ عن المادة التي فتحها.
          والقصير مفتوح — طيُّ سطرين يُخفي ما لا يُثقل. */}
      {attachments.map((att) => (
        <details key={att.id} className="legal-attachment" open={att.text.length <= ATTACHMENT_OPEN_MAX}>
          <summary>
            <Icon.attachment size={ICON_SM} aria-hidden /> <ArticleName a={att} />
            <ArticleFlags a={att} />
          </summary>
          <ArticleNotices a={att} />
          <p className="legal-text">{att.text}</p>
        </details>
      ))}
      {children}
      {showSource && a.sourceUrl ? (
        <p className="legal-source">
          <a href={a.sourceUrl} target="_blank" rel="noreferrer">
            <Icon.externalLink size={ICON_SM} aria-hidden /> المصدر في بوابة هيئة الخبراء
          </a>
        </p>
      ) : null}
      {openAmendment ? <AmendmentWindow id={a.id} onClose={() => setOpenAmendment(false)} /> : null}
    </article>
  );
}

/** طولُ المرفق الذي يُعرض مفتوحاً — ما فوقه يُطوى تحت عنوانه. */
const ATTACHMENT_OPEN_MAX = 400;

/**
 * يجمع أجزاء المادة الواحدة المتتابعة في مجموعةٍ واحدة.
 *
 * الجمع بالمعرّف قبل `#` وبوجود `part`: مادتان متتابعتان بلا تقسيم تبقيان
 * مادتين. والمتتابعُ وحده يُجمع — ترتيب `seq` هو ترتيب الملف، وجزءٌ بعيدٌ عن
 * تتمّته خللٌ في الملف لا شيء تُصلحه الشاشة بإعادة ترتيب النظام على قارئه.
 */
export function groupArticleParts(articles: LegalArticle[]): LegalArticle[][] {
  const base = (id: string) => id.split('#')[0];
  const groups: LegalArticle[][] = [];
  for (const a of articles) {
    const last = groups[groups.length - 1];
    if (last && a.part && last[0].part && base(last[0].id) === base(a.id)) last.push(a);
    else groups.push([a]);
  }
  return groups;
}

/**
 * المواد بأجزائها، والمرفقاتُ تحت أمّهاتها (§5-6، §7-2).
 *
 * المرفق يلي مادته في الملف ويحمل معرّفها في `attachment_of`، فيُضمّ إليها ولا
 * يُعرض بطاقةً مستقلّة تُقرأ مادةً أخرى. ومرفقٌ لم يُعرف موضعه، أو غابت أمُّه عن
 * الصفحة، يبقى بطاقةً بعنوانه — لا يلتصق بما يليه مصادفةً.
 */
export function groupWithAttachments(
  articles: LegalArticle[]
): { group: LegalArticle[]; attachments: LegalArticle[] }[] {
  const parents = new Set(articles.filter((a) => !a.isAttachment).map((a) => a.id));
  const byParent = new Map<string, LegalArticle[]>();
  const rest: LegalArticle[] = [];
  for (const a of articles) {
    if (a.isAttachment && a.attachmentOf && parents.has(a.attachmentOf)) {
      byParent.set(a.attachmentOf, [...(byParent.get(a.attachmentOf) ?? []), a]);
    } else {
      rest.push(a);
    }
  }
  return groupArticleParts(rest).map((group) => ({
    group,
    attachments: group.flatMap((part) => byParent.get(part.id) ?? []),
  }));
}
