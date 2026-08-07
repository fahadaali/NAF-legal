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

/** شارات حال المادة — لا تُقرأ باللون وحده: لكلٍّ لفظُها، وللمراجعة أيقونتها. */
export function ArticleFlags({ a }: { a: LegalArticle }) {
  return (
    <>
      {a.isRepealed || a.status === 'repealed' ? <span className="pill error">منسوخة</span> : null}
      {a.needsReview && !a.reviewedAt ? (
        <span className="pill warn">
          <Icon.pendingReview size={ICON_SM} aria-hidden /> بانتظار المراجعة
        </span>
      ) : null}
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
  const pendingAmendment = a.hasAmendments && !a.amendmentApplied;
  const effectiveOn = a.effectiveFrom || a.effectiveFromHijri;
  if (!pendingAmendment && !a.effectivePending && !a.duplicateOf) return null;

  return (
    <>
      {pendingAmendment ? (
        <div className="legal-notice">
          <Icon.warning size={ICON_SM} aria-hidden />
          <div>
            <p>{AMENDMENT_NOTICE}</p>
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
 * نافذة التعديلات الخام.
 *
 * تُطلب عند فتحها لا مع كل نتيجة: نصٌّ قد يبلغ آلاف الأحرف. والتصنيف الآلي
 * يقترح ولا يقرّر، فهذا ما يرجع إليه المراجع البشري بلا إعادة سحب.
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
        <p>
          <span className="compare-label">سبب الإحالة للمراجعة</span>
          <bdi>{data.amend_note}</bdi>
        </p>
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
  if (!a) return null;
  return (
    <article className="legal-article">
      <h4>
        <ArticleHeading a={a} shown={group.length} />
        <ArticleFlags a={a} />
      </h4>
      <ArticleNotices a={a} onOpenAmendment={() => setOpenAmendment(!openAmendment)} />
      {openAmendment ? <AmendmentPanel id={a.id} /> : null}
      {group.map((part) => (
        <p key={part.id}>{part.text}</p>
      ))}
      {children}
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
