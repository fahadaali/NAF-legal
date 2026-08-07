// مراجعة المواد — ما يُحجب عن الاسترجاع حتى يعتمده إنسان.
//
// التصنيف الآلي يقترح ولا يقرّر. فما وسمه الملف `needs_review` — تعديلٌ جماعي
// لم يُطبَّق، أو رقمٌ مكرّر في المصدر — لا يدخل بحثاً ولا محادثةً ولا تقريراً
// حتى يمرّ من هنا. والحجب في SQL داخل طبقة الاسترجاع، فهذه الشاشة هي الوحيدة
// التي تراه، ولا يفتحه مسارٌ آخر ولو أراد.
//
// وهي **للاعتماد لا للتحرير**: المصدر ملفُّ الاستيراد، والاعتماد قرارٌ على
// النصّ كما ورد. وتصحيحُ النصّ يقع في الملف ثم يُعاد استيراده — وعندها يسقط
// الاعتماد وحده وتعود المادة إلى هذه الشاشة، لأن اعتماد نصٍّ لم يعد هو النصّ
// ليس اعتماداً.
import { useEffect, useState } from 'react';
import { api, type LegalArticle, type LegalLaw } from '../lib/api';
import { formatNumber } from '../lib/format';
import { AmendmentPanel, ArticleFlags } from './LegalArticleView';

/** مواد الصفحة الواحدة. */
const PAGE = 25;

export function LegalReview() {
  const [laws, setLaws] = useState<LegalLaw[]>([]);
  const [lawId, setLawId] = useState('');
  const [articles, setArticles] = useState<LegalArticle[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api.legalLaws().then((r) => setLaws(r.laws)).catch(() => {});
  }, []);

  const load = () => {
    api
      .legalReviewQueue(lawId || null, offset, PAGE)
      .then((r) => {
        setArticles(r.articles);
        setTotal(r.total);
      })
      .catch(() => {});
  };
  useEffect(load, [lawId, offset]);

  /* الاعتماد يُخرج المادة من الطابور، فتُزال من القائمة في الحال ولا تُعاد
     الصفحة كلُّها: صفٌّ يبقى بعد اعتماده يجعل المراجع يعتمده مرّتين. */
  const approve = async (id: string) => {
    setBusy(id);
    try {
      await api.legalSetReviewed(id, true);
      setArticles((rows) => rows.filter((r) => r.id !== id));
      setTotal((n) => Math.max(0, n - 1));
    } catch {
      // يبقى الصفّ كما هو والحجب قائم — لا ضرر يستدعي إنذاراً.
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="import-option">
        <label htmlFor="review-law">النظام</label>
        <select
          id="review-law"
          value={lawId}
          onChange={(e) => {
            setLawId(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">كل الأنظمة</option>
          {laws.map((l) => (
            <option key={l.law_id} value={l.law_id}>
              {l.law_title || l.law_id}
            </option>
          ))}
        </select>
      </div>

      {total === 0 ? (
        <div className="empty-state">لا مادة بانتظار المراجعة. كل ما استُورد داخلٌ في الاسترجاع.</div>
      ) : (
        <>
          <div className="kb-section">
            بانتظار المراجعة: <bdi>{formatNumber(total)}</bdi>
          </div>

          {articles.map((a) => (
            <article key={a.id} className="legal-article">
              <h4>
                <bdi>{a.lawTitle || a.lawId || a.id}</bdi>
                {a.articleNo ? (
                  <span className="pill pending">
                    المادة <bdi>{a.articleNo}</bdi>
                  </span>
                ) : null}
                <ArticleFlags a={a} />
              </h4>
              {a.amendNote ? (
                <p className="legal-notice-meta">
                  <span className="compare-label">سبب الإحالة للمراجعة</span>
                  <bdi>{a.amendNote}</bdi>
                </p>
              ) : null}
              <p>{a.text}</p>
              {/* نافذة التعديلات مفتوحةٌ هنا افتراضاً: هي موضوع المراجعة نفسه،
                  وإخفاؤها خلف نقرةٍ يجعل الاعتماد يقع قبل قراءة ما يُعتمد. */}
              <AmendmentPanel id={a.id} />
              <div className="law-pager">
                <button className="btn-sm primary" disabled={busy === a.id} onClick={() => approve(a.id)}>
                  {busy === a.id ? <><span className="spinner" /> جارٍ الحفظ</> : 'اعتماد'}
                </button>
              </div>
            </article>
          ))}

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
        </>
      )}
    </div>
  );
}
