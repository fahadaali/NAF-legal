// تصفّح الأنظمة المستوردة — نظاماً نظاماً، بمواده ولوائحه.
//
// المستورَد كان يدخل القاعدة ولا يظهر في أي شاشة: يعمل في البحث ولا يُرى.
// وهذه الشاشة تجعله نظاماً يُتصفَّح لا مقاطعَ في جدول.
//
// وهي **للاطّلاع لا للتحرير**: المصدر ملفُّ الاستيراد، وتعديلُ مادةٍ هنا
// يضيع عند أوّل إعادة رفع للنظام — الاستبدال على `id` يكتب فوقها. فما
// يُصحَّح يُصحَّح في الملف ثم يُعاد استيراده.
import { Fragment, useEffect, useState } from 'react';
import { api, type LegalArticle, type LegalChunkVersion, type LegalLaw, type LegalStats } from '../lib/api';
import { formatDate, formatNumber } from '../lib/format';
import { Icon, ICON_SM } from '../lib/icons';
import { useScrollReset } from '../lib/scrollBox';
import { docTypeLabel } from '../lib/labels';
import {
  ArticleCard,
  ArticleFlags,
  ArticleName,
  ArticleNotices,
  LawIdentity,
  LawTags,
  groupWithAttachments,
} from './LegalArticleView';

/** أسماء الحقول التي تُقارَن، بالعربية — كما في نافذة إعادة الرفع. */
const FIELD_LABELS: Record<string, string> = {
  text: 'النصّ',
  article_no: 'رقم المادة',
  status: 'الحالة',
  is_repealed: 'النسخ',
  instrument_no: 'رقم الأداة',
  issue_date: 'تاريخ الإصدار',
  amendment_applied: 'تطبيق التعديل',
};

/** مواد الصفحة الواحدة في التصفّح. */
const PAGE = 25;

/**
 * موضع المادة من نظامها: الباب والفصل والعنوان الحرّ.
 *
 * نصُّها من الملف كما ورد — «الباب الخامس: علاقات العمل» — فلا لفظَ من عندنا
 * ولا ترجمة. وفارغُها لا يُنتج عنواناً فارغاً.
 */
const sectionHeading = (a: LegalArticle) => [a.book, a.chapter, a.section].filter(Boolean).join(' — ');

export function LegalLaws({ stats }: { stats?: LegalStats | null }) {
  const [laws, setLaws] = useState<LegalLaw[] | null>(null);
  const [openLaw, setOpenLaw] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<LegalArticle[] | null>(null);

  useEffect(() => {
    api.legalLaws().then((r) => setLaws(r.laws)).catch(() => setLaws([]));
  }, []);

  /* فتحُ نظامٍ والرجوعُ منه شاشتان تتبادلان الموضع نفسه: من فتح النظام
     الحادي والسبعين من آخر الجدول كان يجد صفحته مفتوحةً من وسطها. */
  useScrollReset(openLaw ?? 'list');

  /* البحث في المحتوى: لفظيٌّ بلا نموذج تضمين — بحثُ مسؤولٍ في نصٍّ مفهرس
     لا استرجاعٌ لإجابة. والاسم يُرشَّح هنا في الصفحة، فقائمة الأنظمة عندها
     كاملةً ولا يستحقّ ترشيحُها نداءً. */
  useEffect(() => {
    if (!q.trim()) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => {
      api.legalSearch(q).then((r) => setHits(r.results)).catch(() => setHits([]));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  if (openLaw) return <LawDetail lawId={openLaw} onBack={() => setOpenLaw(null)} onOpen={setOpenLaw} />;

  /* ريثما يصل الردّ هيكلٌ لا فراغ، وبعده جدولٌ أو دعوةٌ إلى العمل.
     وكان يُرجع `null` في الحالين: فتُرسَم الشاشة بلا هذا القسم، ثم يصل
     واحدٌ وسبعون نظاماً فتُحقَن **فوق** ما يقرأه المسؤول — وهو أصلُ
     «تطلع محتويات فوق لم تكن ظاهرة». */
  if (laws === null) return <div className="kb-skeleton" aria-hidden><span className="kb-skeleton-row" /><span className="kb-skeleton-row" /><span className="kb-skeleton-row" /></div>;
  if (!laws.length) {
    return <div className="empty-state">لم يُستورد أي نظام بعد. ابدأ باستيراد أول ملف مواد.</div>;
  }

  /* الأنظمة المطابقة تُشتقّ من المواد التي طابقت: الفهرس اللفظي يحوي اسم
     النظام ورقم المادة مع نصّها، فالبحث بالاسم يُصيب مواده. ولا يُعاد
     التطبيع في الواجهة — مصدرٌ واحد له في الخادم. */
  const hitLaws = new Set((hits ?? []).map((h) => h.lawId).filter(Boolean));
  const shown = q.trim() ? laws.filter((l) => hitLaws.has(l.law_id)) : laws;

  return (
    <>
      {/* صحّةُ القاعدة (§6-7) — وصفُ ما فيها لا وصفُ إضافةٍ تجري، فموضعُها
          هنا لا في شاشة الاستيراد. */}
      {stats && stats.chunks > 0 ? <KbHealth stats={stats} /> : null}

      <div className="search-page-box">
        <input placeholder="ابحث باسم النظام أو في نصّ مواده" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {hits?.length ? (
        <>
          <div className="kb-section">مواد مطابقة</div>
          {hits.map((a) => (
            <article key={a.id} className="legal-article">
              <h4>
                <bdi>{a.lawTitle ?? ''}</bdi>
                <LawTags repealed={a.lawRepealed} pending={a.lawPending} from={a.lawEffectiveFrom} />
                <span className="pill pending"><ArticleName a={a} /></span>
                <ArticleFlags a={a} />
              </h4>
              {/* نظامان باسمٍ واحد يُفرَّق بينهما هنا — بأداتهما وتاريخهما (§7-2). */}
              <LawIdentity a={a} />
              {/* التنبيه يلاحق النصّ حيث عُرض: نتيجةُ بحثٍ تُنسخ إلى مذكرة
                  كما تُنسخ من صفحة النظام، ونصٌّ أصليّ بلا تنبيهه يُستشهد به
                  على أنه الجاري. */}
              <ArticleNotices a={a} />
              <p>{a.text}</p>
            </article>
          ))}
        </>
      ) : null}

      {q.trim() && hits && !hits.length && !shown.length ? (
        <div className="empty-state">لا نتائج مطابقة لبحثك. جرّب كلمات أخرى.</div>
      ) : null}

      {shown.length ? <LawsTable laws={shown} onOpen={setOpenLaw} /> : null}
    </>
  );
}

/**
 * صحّة القاعدة — عدٌّ حيّ يُقابَل ببيان آخر دفعة (§6-7).
 *
 * توزيعُ حال الاسترجاع بألفاظه المسجَّلة الثلاثة، وما يجب أن يكون في الفهرس
 * المتجهي مقابَلاً بما فيه فعلاً. والفهرسُ يُسأل عن عدده مرّةً عند فتح القسم لا
 * مع جسّ الشريط: نداءٌ خارج القاعدة لا يستحقّ إيقاع خمس ثوانٍ.
 */
function KbHealth({ stats }: { stats: LegalStats }) {
  const [vectors, setVectors] = useState<LegalStats['vectors'] | null>(null);

  useEffect(() => {
    // نداءٌ يبدؤه القارئ بفتح القسم لا مؤقّت، فلا يحمل وسمَ الجسّ الدوريّ.
    api
      .legalStats(false, true)
      .then((r) => setVectors(r.vectors ?? null))
      .catch(() => setVectors(null));
  }, []);

  return (
    <section aria-label="صحّة القاعدة">
      <div className="kb-section">صحّة القاعدة</div>
      <dl className="kb-counts kb-counts--inline">
        <HealthCount label="المواد" value={stats.chunks} />
        <HealthCount label="نافذ" value={stats.retrieval.effective} />
        <HealthCount label="نافذ بتحذير" value={stats.retrieval.warning} />
        <HealthCount label="ملغاة" value={stats.retrieval.repealed} />
        <HealthCount label="تُفهرَس" value={stats.indexed} />
        {/* ما في الفهرس فعلاً — وشرطةٌ لا صفر حين لم يُسأل أو لم يُهيَّأ:
            صفرٌ يُقرأ خبراً عن فهرسٍ فارغ. */}
        <HealthCount label="في الفهرس المتجهي" value={vectors?.actual ?? undefined} />
      </dl>
      {vectors?.orphans ? (
        <p className="kb-index warn">
          <Icon.warning size={ICON_SM} aria-hidden />
          <span>
            في الفهرس المتجهي ما لا سجلَّ له — <bdi>{formatNumber(vectors.orphans)}</bdi>
          </span>
        </p>
      ) : null}
      {stats.stale_vector ? (
        <p className="kb-index warn">
          <Icon.warning size={ICON_SM} aria-hidden />
          <span>
            موادّ ملغاة بقي لها متجه — <bdi>{formatNumber(stats.stale_vector)}</bdi> — يُحذف في دورة التضمين التالية
          </span>
        </p>
      ) : null}
    </section>
  );
}

function HealthCount({ label, value }: { label: string; value?: number }) {
  return (
    <div className="kb-count">
      <dt>{label}</dt>
      <dd>{value === undefined ? '—' : <bdi>{formatNumber(value)}</bdi>}</dd>
    </div>
  );
}

/**
 * نظامان باسمٍ واحد — القديم اللاغي وخلفُه، أو نسختان ساريتان — يُفرَّق بينهما
 * بأداة الإصدار وتاريخه لا بالاسم وحده (§7-2). ويُكتب الفارق حين يلزم وحده:
 * سطرٌ ثانٍ تحت واحدٍ وسبعين اسماً ضجيجٌ لا تمييز.
 */
function sharedTitles(laws: LegalLaw[]): Set<string> {
  const seen = new Map<string, number>();
  for (const l of laws) {
    const t = l.law_title || l.law_id;
    seen.set(t, (seen.get(t) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([t]) => t));
}

function LawsTable({ laws, onOpen }: { laws: LegalLaw[]; onOpen: (id: string) => void }) {
  const shared = sharedTitles(laws);
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
              <td>
                <bdi>{l.law_title || l.law_id}</bdi>
                <LawTags repealed={!!l.law_repealed} pending={!!l.law_pending} from={l.law_effective_from} />
                {shared.has(l.law_title || l.law_id) ? (
                  <p className="legal-notice-meta">
                    <bdi>{[[l.instrument, l.instrument_no].filter(Boolean).join(' '), l.issue_date_hijri].filter(Boolean).join(' — ') || l.law_id}</bdi>
                  </p>
                ) : null}
              </td>
              <td>{docTypeLabel(l.doc_type)}</td>
              <td><bdi>{formatNumber(l.chunks)}</bdi></td>
              <td><bdi>{formatNumber(l.effective)}</bdi></td>
              <td><bdi>{formatNumber(l.repealed)}</bdi></td>
              <td>
                <button className="btn-sm primary" onClick={() => onOpen(l.law_id)}>عرض</button>
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
          <h3>
            <bdi>{law.law_title || law.law_id}</bdi>
            <LawTags repealed={!!law.law_repealed} pending={!!law.law_pending} from={law.law_effective_from} />
          </h3>
          <p>
            {[
              docTypeLabel(law.doc_type) === '—' ? null : docTypeLabel(law.doc_type),
              // نوع الأداة ورقمها معاً: «مرسوم ملكي م/51» أداةٌ واحدة لا سطران.
              [law.instrument, law.instrument_no].filter(Boolean).join(' '),
              law.authority,
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
                {/* «تصحيح بيانات» يميّز خطأ سحبٍ ظهر اليوم عن تعديلٍ نظاميّ
                    وقع بمرسوم — وبلا تمييزهما يبدو النظام معدَّلاً هذا العام
                    وهو معدَّل قبل سنوات. */}
                {v.change_kind === 'correction' ? <span className="pill pending">تصحيح بيانات</span> : null}
                {v.amendment_instrument ? (
                  <span className="compare-label">
                    أداة التعديل <bdi>{v.amendment_instrument}</bdi>
                  </span>
                ) : null}
                {/* التاريخ من `amended_on` حين وُجد: المادة عُدِّلت بمرسومها في
                    تاريخه، وإنما استوردناه اليوم. ووقتُ الأرشفة يبقى بديلاً
                    حين لا يقول الملف تاريخ التعديل. */}
                <span className="compare-label">
                  <bdi>{v.amended_on ?? formatDate(v.archived_at)}</bdi>
                </span>
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
      {/* أجزاء المادة الواحدة تُعرض متتابعةً تحت عنوانٍ واحد: `#a` و`#b` مادةٌ
          واحدة قُسّمت لطولها، وعرضُها مادتين يجعل النظام يبدو ذا مادتين
          برقمٍ واحد. */}
      {groupWithAttachments(articles).map(({ group, attachments }, i, all) => {
        /* الباب والفصل عنوانٌ يظهر عند تغيّره لا مع كل مادة: تكرارُه على
           مئتَي مادة ضجيج، وغيابُه يجعل المواد قائمةً بلا بنية. ونصُّه من
           الملف كما ورد — لا لفظَ من عندنا. ويظهر في رأس كل صفحة ولو لم
           يتغيّر عن سابقتها، فقارئُ الصفحة الثانية لم يرَ الأولى.

           والمرفقُ تحت مادته لا بطاقةً تليها (§7-2)، والملحقُ بعنوانه بعد
           مواد نظامه — والترتيب ترتيبُ الملف. */
        const heading = sectionHeading(group[0]);
        const previous = i > 0 ? sectionHeading(all[i - 1].group[0]) : null;
        return (
          <Fragment key={group[0].id}>
            {heading && (i === 0 || heading !== previous) ? (
              <div className="kb-section"><bdi>{heading}</bdi></div>
            ) : null}
            <ArticleCard group={group} attachments={attachments} />
          </Fragment>
        );
      })}

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
