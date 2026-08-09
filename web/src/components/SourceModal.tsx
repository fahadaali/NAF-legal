// نافذة المصدر — المادة التي بُني عليها الرأي، لا اسمُها وحده.
//
// كانت المصادر تُذكر أسفل كل إجابة في شاراتٍ صمّاء: «نظام العمل — المادة ٧٧».
// ومن أراد أن يقرأ ما استُند إليه بحث عنه في شاشة الأنظمة بنفسه، فيقرأ أكثرُ
// الناس الرأيَ ولا يقرأ نصَّه. وهذه النافذة تفتحه في موضعه: نصُّ المادة،
// وتنبيهاتها، وأداةُ إصدار نظامها وتاريخها، وسجلُّ تعديلاتها، ومنفذٌ إلى
// المصدر الرسمي الذي نُسخ عنه.
//
// **ولا تعرض النافذة نصّاً من الاستشهاد نفسه.** الاستشهاد بياناتٌ حُفظت ساعة
// التوليد، وقد عُدِّلت المادة بعده. فتُجلب من القاعدة عند كل فتحة، ويُقرأ
// النافذ اليوم لا ما كان يومها.
import { useEffect, useState } from 'react';
import { api, type Citation, type LegalArticle } from '../lib/api';
import { ArticleCard, groupArticleParts } from './LegalArticleView';
import { Icon, ICON_SM } from '../lib/icons';

/** رقم المادة من الاستشهاد. القديم لا يحمله إلا داخل «المادة ٧٧». */
function articleNoOf(c: Citation): string | undefined {
  if (c.articleNo) return c.articleNo;
  const m = c.ref?.match(/^\s*المادة\s+(.+?)\s*$/);
  return m ? m[1] : undefined;
}

/** هل في الاستشهاد ما يُفتح به؟ الشارة تصير زرّاً حين يكون الجواب نعم. */
export function isOpenableCitation(c: Citation): boolean {
  if (c.source === 'document') return false;
  if (c.id) return true;
  return !!(articleNoOf(c) && (c.lawId || c.title));
}

/** سطرُ التعريف: أداةُ الإصدار ورقمها، ثم الجهة، ثم التاريخ. */
function LawMeta({ parts }: { parts: (string | null | undefined)[] }) {
  const shown = parts.filter((p): p is string => !!p && p.trim().length > 0);
  if (!shown.length) return null;
  return (
    <p>
      {shown.map((part, i) => (
        <span key={i}>
          {i > 0 ? ' — ' : ''}
          <bdi>{part}</bdi>
        </span>
      ))}
    </p>
  );
}

export default function SourceModal({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  const [articles, setArticles] = useState<LegalArticle[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setArticles(null);
    setError(null);

    const articleNo = articleNoOf(citation);
    const by = citation.id
      ? { id: citation.id }
      : citation.lawId
        ? { lawId: citation.lawId, articleNo }
        : { lawTitle: citation.title, articleNo };

    /* المحاولة الثانية تفتح الأرشيف صراحةً.
       التصفية على السريان تحجب الملغاة عن كل مسار — وهو الصواب في الاسترجاع
       — لكن استشهاداً قديماً قد يشير إلى مادةٍ أُلغيت بعده. وقولُ «غير
       موجودة» عنها كذبٌ يجعل المحامي يظنّ الإسناد مختلقاً؛ وعرضُها بشارة
       «ملغاة» يقول الحقيقة كاملة. */
    api
      .legalArticle(by)
      .catch(() => api.legalArticle({ ...by, includeRepealed: true }))
      .then((r) => {
        if (!live) return;
        if (!r.results.length) setError('المادة غير موجودة');
        else setArticles(r.results);
      })
      .catch((e: any) => {
        if (live) setError(e?.message ?? 'تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة');
      });

    return () => {
      live = false;
    };
  }, [citation]);

  // `Esc` تُغلق كما يُغلق النقر خارجها — كما في نافذة سجلّ التعديلات.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const first = articles?.[0];
  // النافذ اليوم يسبق ما حُفظ في الاستشهاد: المادة قد تكون عُدِّلت بعده.
  const lawTitle = first?.lawTitle || citation.title;
  const sourceUrl = first?.sourceUrl || citation.sourceUrl;
  const instrument = [first?.instrument ?? citation.instrument, first?.instrumentNo ?? citation.instrumentNo]
    .filter(Boolean)
    .join(' ');
  const issueDate = first?.issueDate ?? citation.issueDate;
  const issueDateHijri = first?.issueDateHijri ?? citation.issueDateHijri;
  // التاريخ ميلاديّ يتبعه الهجريّ بين قوسين — تاريخ أداةٍ نظامية يُستشهد به.
  const issued = issueDate && issueDateHijri ? `${issueDate} (${issueDateHijri})` : issueDate || issueDateHijri;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card source-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-head">
          <span className="modal-title">
            <Icon.officialSource size={ICON_SM} aria-hidden /> المصدر
          </span>
          <button className="modal-close" onClick={onClose} title="إغلاق" aria-label="إغلاق">
            <Icon.close size={ICON_SM} aria-hidden />
          </button>
        </div>

        <div className="modal-body source-body">
          <div className="law-head">
            <h3>
              <bdi>{lawTitle}</bdi>
            </h3>
            <LawMeta parts={[instrument, first?.authority ?? citation.authority, issued]} />
          </div>

          {/* وثيقةٌ مرفوعة لا مادةٌ مستوردة: لا نصَّ لها في المحتوى النظامي
              ولا صفحةَ مصدرٍ رسمية، ويُقال ذلك ولا يُترك القارئ أمام نافذةٍ
              فارغة يظنّها عطلاً. */}
          {citation.source === 'document' ? (
            <p className="legal-notice-meta">
              هذا المصدر وثيقةٌ مرفوعة إلى قاعدة المعرفة{citation.ref ? <> — <bdi>{citation.ref}</bdi></> : null}
            </p>
          ) : error ? (
            <p className="legal-notice-meta">{error}</p>
          ) : !articles ? (
            <p className="legal-notice-meta">جارٍ التحميل</p>
          ) : (
            groupArticleParts(articles).map((group) => <ArticleCard key={group[0].id} group={group} />)
          )}
        </div>

        {/* منفذُ الاطّلاع على الأصل. واللفظ مسجَّل في naf-terms.md تحت «نافذة
            سجلّ التعديلات»، وهو الموضع الآخر الذي يُعرض فيه هذا الرابط. */}
        {sourceUrl ? (
          <div className="modal-foot">
            <a className="btn-sm primary" href={sourceUrl} target="_blank" rel="noreferrer">
              <Icon.externalLink size={ICON_SM} aria-hidden /> المصدر في بوابة هيئة الخبراء
            </a>
          </div>
        ) : null}
      </div>
    </div>
  );
}
