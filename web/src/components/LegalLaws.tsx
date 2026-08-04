// تصفّح الأنظمة المستوردة — نظاماً نظاماً، بمواده ولوائحه.
//
// المستورَد كان يدخل القاعدة ولا يظهر في أي شاشة: يعمل في البحث ولا يُرى.
// وهذه الشاشة تجعله نظاماً يُتصفَّح لا مقاطعَ في جدول.
//
// وهي **للاطّلاع لا للتحرير**: المصدر ملفُّ الاستيراد، وتعديلُ مادةٍ هنا
// يضيع عند أوّل إعادة رفع للنظام — الاستبدال على `id` يكتب فوقها. فما
// يُصحَّح يُصحَّح في الملف ثم يُعاد استيراده.
import { useEffect, useState } from 'react';
import { api, type LegalArticle, type LegalChunkVersion, type LegalLaw } from '../lib/api';
import { formatDate, formatNumber } from '../lib/format';

/** أسماء الحقول التي تُقارَن، بالعربية — كما في نافذة إعادة الرفع. */
const FIELD_LABELS: Record<string, string> = {
  text: 'النصّ',
  article_no: 'رقم المادة',
  status: 'الحالة',
  is_repealed: 'النسخ',
  instrument_no: 'رقم الأداة',
  issue_date: 'تاريخ الإصدار',
};

/** مواد الصفحة الواحدة في التصفّح. */
const PAGE = 25;

/**
 * أنواع الأدوات النظامية بالعربية.
 *
 * `doc_type` يأتي من الملف كما كتبه مُعِدُّه، وعرضُ `law` في ترويسةٍ عربية
 * ركاكة. والمقابلات هنا للعرض وحده — المخزَّن يبقى كما ورد، فالتصفية على
 * النوع تُطابق ما في الملف لا ما نعرضه.
 */
const DOC_TYPE_LABELS: Record<string, string> = {
  law: 'نظام',
  regulation: 'لائحة',
  decision: 'قرار',
  circular: 'تعميم',
};

const docTypeLabel = (t: string | null) => (t ? (DOC_TYPE_LABELS[t] ?? t) : '—');

export function LegalLaws() {
  const [laws, setLaws] = useState<LegalLaw[] | null>(null);
  const [openLaw, setOpenLaw] = useState<string | null>(null);

  useEffect(() => {
    api.legalLaws().then((r) => setLaws(r.laws)).catch(() => setLaws([]));
  }, []);

  if (openLaw) return <LawDetail lawId={openLaw} onBack={() => setOpenLaw(null)} onOpen={setOpenLaw} />;
  if (!laws?.length) return null;

  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>النظام</th>
            <th>النوع</th>
            <th>المواد</th>
            <th>السارية</th>
            <th>المنسوخة</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {laws.map((l) => (
            <tr key={l.law_id}>
              <td><bdi>{l.law_title || l.law_id}</bdi></td>
              <td>{docTypeLabel(l.doc_type)}</td>
              <td><bdi>{formatNumber(l.chunks)}</bdi></td>
              <td><bdi>{formatNumber(l.effective)}</bdi></td>
              <td><bdi>{formatNumber(l.repealed)}</bdi></td>
              <td>
                <button className="btn-sm primary" onClick={() => setOpenLaw(l.law_id)}>عرض</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LawDetail({ lawId, onBack, onOpen }: { lawId: string; onBack: () => void; onOpen: (id: string) => void }) {
  const [law, setLaw] = useState<LegalLaw | null>(null);
  const [regulations, setRegulations] = useState<LegalLaw[]>([]);
  const [parentTitle, setParentTitle] = useState<string | null>(null);
  const [changes, setChanges] = useState<LegalChunkVersion[]>([]);
  const [articles, setArticles] = useState<LegalArticle[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    setOffset(0);
    api
      .legalLaw(lawId)
      .then((r) => {
        setLaw(r.law);
        setRegulations(r.regulations);
        setParentTitle(null);
        if (r.law?.parent_law_id) {
          api
            .legalLaw(r.law.parent_law_id)
            .then((p) => setParentTitle(p.law?.law_title ?? null))
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, [lawId]);

  useEffect(() => {
    api
      .legalLawChanges(lawId, 0, PAGE)
      .then((r) => setChanges(r.changes))
      .catch(() => setChanges([]));
  }, [lawId]);

  useEffect(() => {
    api
      .legalLawArticles(lawId, offset, PAGE)
      .then((r) => {
        setArticles(r.articles);
        setTotal(r.total);
      })
      .catch(() => {});
  }, [lawId, offset]);

  return (
    <div>
      <button className="btn-sm" onClick={onBack}>رجوع</button>

      {law ? (
        <div className="law-head">
          <h3><bdi>{law.law_title || law.law_id}</bdi></h3>
          <p>
            {[
              docTypeLabel(law.doc_type) === '—' ? null : docTypeLabel(law.doc_type),
              law.instrument_no,
              // التاريخ ميلاديّ يتبعه الهجريّ بين قوسين — تاريخ أداةٍ نظامية.
              law.issue_date && law.issue_date_hijri
                ? `${law.issue_date} (${law.issue_date_hijri})`
                : law.issue_date || law.issue_date_hijri,
            ]
              .filter(Boolean)
              .map((part, i) => (
                <span key={i}>
                  {i > 0 ? ' — ' : ''}
                  <bdi>{part}</bdi>
                </span>
              ))}
          </p>
          {law.source_url ? (
            <p>
              <a href={law.source_url} target="_blank" rel="noreferrer">المصدر</a>
            </p>
          ) : null}
        </div>
      ) : null}

      {/* الصلة تُقرأ من الطرفين: النظام يعدّد لوائحه، واللائحة تدلّ على
          نظامها. وبطرفٍ واحد يصل القارئ إلى اللائحة من البحث فلا يعرف
          لأيّ نظام هي. */}
      {law?.parent_law_id ? (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>النظام الأصل</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><bdi>{parentTitle ?? law.parent_law_id}</bdi></td>
                <td>
                  <button className="btn-sm primary" onClick={() => onOpen(law.parent_law_id!)}>عرض</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}

      {regulations.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>اللوائح</th>
                <th>المواد</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {regulations.map((r) => (
                <tr key={r.law_id}>
                  <td><bdi>{r.law_title || r.law_id}</bdi></td>
                  <td><bdi>{formatNumber(r.chunks)}</bdi></td>
                  <td>
                    <button className="btn-sm primary" onClick={() => onOpen(r.law_id)}>عرض</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* سجلّ التحديث: ما أُزيح من نصوص هذا النظام ومتى. وقضيةٌ وقعت وقت
          سريان النصّ القديم تُحاكَم به لا بالجاري، فبقاؤه ليس ترفاً. */}
      {changes.length > 0 && (
        <>
          <div className="kb-section">سجل التحديث</div>
          {changes.map((v) => (
            <div key={v.id} className="compare-row">
              <h4>
                المادة <bdi>{v.article_no ?? v.chunk_id}</bdi>
                {v.changed_fields.split(',').map((f) => (
                  <span key={f} className="pill warn">{FIELD_LABELS[f] ?? f}</span>
                ))}
                <span className="compare-label"><bdi>{formatDate(v.archived_at)}</bdi></span>
              </h4>
              {v.article_no !== v.current_article_no ? (
                <p>
                  رقم المادة: <bdi>{v.article_no ?? '—'}</bdi> ← <bdi>{v.current_article_no ?? '—'}</bdi>
                </p>
              ) : null}
              {v.changed_fields.split(',').includes('text') ? (
                <div className="compare-pair">
                  <div>
                    <div className="compare-label">النصّ السابق</div>
                    <p>{v.text}</p>
                  </div>
                  <div>
                    <div className="compare-label">النصّ المعتمد</div>
                    <p>{v.current_text ?? '—'}</p>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </>
      )}

      <div className="kb-section">المواد</div>
      {articles.map((a) => (
        <article key={a.id} className="legal-article">
          <h4>
            {a.articleNo ? <>المادة <bdi>{a.articleNo}</bdi></> : <bdi>{a.id}</bdi>}
            {a.isRepealed || a.status === 'repealed' ? <span className="pill error">منسوخة</span> : null}
          </h4>
          <p>{a.text}</p>
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
    </div>
  );
}
