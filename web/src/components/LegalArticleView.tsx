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
import { formatNumber } from '../lib/format';
import { Icon, ICON_SM } from '../lib/icons';

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
      {a.articleNo ? (
        <>
          المادة <bdi>{a.articleNo}</bdi>
        </>
      ) : (
        <bdi>{a.id}</bdi>
      )}
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
      {a.needsReview ? <ReviewStatusPill status={a.reviewStatus} /> : null}
      {a.duplicateOf ? <span className="pill pending">رقم مكرّر</span> : null}
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
  // نصّ التحذير يأتي جاهزاً من طبقة الاسترجاع حين يأتي: هي التي تعرف حالَ
  // المادة، والشاشة تعرضه ولا تركّبه. وما لم يأتِ يقع على اللفظ المسجَّل.
  const pendingAmendment = a.retrievalStatus === 'effective_warning' || (a.hasAmendments && !a.amendmentApplied);
  const warning = a.retrievalWarning || AMENDMENT_NOTICE;
  const effectiveOn = a.effectiveFrom || a.effectiveFromHijri;
  if (!pendingAmendment && !a.effectivePending && !a.duplicateOf) return null;

  return (
    <>
      {pendingAmendment ? (
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
            {onOpenAmendment ? (
              <button className="btn-sm" onClick={onOpenAmendment}>
                نصّ التعديل
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {a.effectivePending ? (
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const TABS: [typeof tab, string, keyof typeof Icon][] = [
    ['log', 'سجل التعديلات', 'amendmentLog'],
    ['timeline', 'الخط الزمني', 'versionTimeline'],
    ['original', 'الأصل', 'originalText'],
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card amendment-card" onClick={(e) => e.stopPropagation()}>
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
            <span className={`pill ${e.applied ? 'success' : 'pending'}`}>
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

/**
 * نافذة التعديلات الخام — تبقى للوحة المراجعة الثلاثية.
 *
 * شاشة المراجعة تعرض الألواح جنباً إلى جنب لا في نافذة: المراجع يقابل بينها
 * وهو يحرّر، وفتحُ نافذةٍ فوق نصٍّ يحرّره يحجب ما يحرّره.
 */
export function AmendmentPanel({ id }: { id: string }) {
  const [data, setData] = useState<LegalAmendment | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setData(null);
    setFailed(false);
    api
      .legalAmendment(id)
      .then((r) => setData(r.amendment))
      .catch(() => setFailed(true));
  }, [id]);

  if (failed) return <p className="legal-notice-meta">تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة</p>;
  if (!data) return <p className="legal-notice-meta">جارٍ التحميل</p>;

  return (
    <div className="legal-amendment">
      {data.amend_note ? (
        <div>
          <div className="compare-label">سبب الإحالة للمراجعة</div>
          <p><bdi>{data.amend_note}</bdi></p>
        </div>
      ) : null}
      {data.amendments_raw ? (
        <div>
          <div className="compare-label">نصّ التعديل</div>
          <p>{data.amendments_raw}</p>
        </div>
      ) : null}
      {data.text_superseded ? (
        <div>
          <div className="compare-label">النصّ السابق</div>
          <p>{data.text_superseded}</p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * المادة كاملةً: ترويستها وشاراتها وتنبيهاتها ونصُّها.
 *
 * والمدخل مجموعةُ أجزاءٍ لا جزءاً واحداً: `#a` و`#b` أجزاءُ مادةٍ واحدة
 * تُعرض متتابعةً، لا مادتان يفصل بينهما عنوانان. وأكثر المواد جزءٌ واحد،
 * فتمرّ مجموعةً من عنصرٍ واحد.
 */
export function ArticleCard({ group, children }: { group: LegalArticle[]; children?: ReactNode }) {
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
      {children}
      {openAmendment ? <AmendmentWindow id={a.id} onClose={() => setOpenAmendment(false)} /> : null}
    </article>
  );
}

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
