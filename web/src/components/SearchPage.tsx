// البحث في المنصة — محادثاتك ومخرجاتك وقاعدة المعرفة.
//
// لفظيٌّ بالافتراض: تُطابَق كلماتك كما كتبتَها، فلا انتظارَ نموذجٍ ولا كلفةَ
// نداء. و«بحث دلالي» خيارٌ يُطلب لا سلوكٌ يُبدَّل — من يبحث عن رقم مادةٍ
// يحفظه لا يريد تقريباً بالمعنى. والاسترجاع في المحادثة يبقى كما هو: ذاك
// استشهادٌ في إجابةٍ مولَّدة، وهذا بحثٌ مباشر.
//
// والمصادر الخارجية مجموعاتٌ على حدة بأسمائها وحالاتها، وترتيبُ العرض
// يضع موادَّ الأنظمة أولاً: شاشةُ منصّةٍ سعودية يتصدّرها النظام.
import { useEffect, useMemo, useState } from 'react';
import { api, type PlatformSearch, type ExternalGroup, type LegalLaw, type LegalSearchFilters } from '../lib/api';
import { formatDate } from '../lib/format';
import { Icon, ICON_SM } from '../lib/icons';
import { docTypeLabel } from '../lib/labels';
import { ArticleFlags, ArticleName, ArticleNotices, LawIdentity, LawTags } from './LegalArticleView';

const INTERNAL_SCOPES: [string, string][] = [
  ['all', 'الكل'],
  ['chats', 'المحادثات'],
  ['outputs', 'المخرجات'],
  ['kb', 'قاعدة المعرفة'],
];

export default function SearchPage({ initial, onOpenConversation }: { initial: string; onOpenConversation: (id: string) => void }) {
  const [q, setQ] = useState(initial);
  const [scope, setScope] = useState<string>('all');
  const [semantic, setSemantic] = useState(false);
  const [result, setResult] = useState<PlatformSearch | null>(null);
  const [busy, setBusy] = useState(false);
  /* رقاقاتُ المصادر تُبنى ممّا ردّه البحث لا من قائمةٍ ثابتة: مصدرٌ يُضاف من
     لوحة الإدارة تظهر رقاقتُه بلا نشرٍ جديد، ومصدرٌ يُعطَّل تختفي. وتُحفظ بين
     الاستعلامات لأن حصرَ النطاق في مصدرٍ بعينه يُخرج البقيّةَ من الردّ. */
  const [known, setKnown] = useState<[string, string][]>([]);
  /* مرشّحات مواد الأنظمة (§6-1): النظام والنوع والباب، و«النافذة فقط»
     افتراضاً. والتصفية في طبقة الاسترجاع لا هنا — هذه تقول ما يُطلب وحده. */
  const [legal, setLegal] = useState<LegalSearchFilters>({});
  const [laws, setLaws] = useState<LegalLaw[]>([]);
  const [books, setBooks] = useState<string[]>([]);
  const kbInScope = scope === 'all' || scope === 'kb';

  useEffect(() => {
    if (!kbInScope || laws.length) return;
    api.legalLaws().then((r) => setLaws(r.laws)).catch(() => {});
  }, [kbInScope, laws.length]);

  useEffect(() => {
    setBooks([]);
    if (!legal.lawId) return;
    api.legalLawBooks(legal.lawId).then((r) => setBooks(r.books)).catch(() => {});
  }, [legal.lawId]);

  /** أنواع الأدوات المستوردة فعلاً — لا قائمةٌ مكتوبة تشيخ مع أوّل نوعٍ جديد. */
  const docTypes = useMemo(
    () => Array.from(new Set(laws.map((l) => l.doc_type).filter((t): t is string => !!t))).sort(),
    [laws]
  );
  /* نظامان باسمٍ واحد يُفرَّق بينهما في القائمة بأداتهما وتاريخهما (§7-2):
     خياران بلفظٍ واحد لا يُختار بينهما. */
  const lawOption = useMemo(() => {
    const count = new Map<string, number>();
    for (const l of laws) count.set(l.law_title || l.law_id, (count.get(l.law_title || l.law_id) ?? 0) + 1);
    return (l: LegalLaw) => {
      const title = l.law_title || l.law_id;
      if ((count.get(title) ?? 0) < 2) return title;
      const id = [[l.instrument, l.instrument_no].filter(Boolean).join(' '), l.issue_date_hijri].filter(Boolean).join(' — ');
      return `${title} — ${id || l.law_id}`;
    };
  }, [laws]);

  useEffect(() => {
    if (!q.trim()) {
      setResult(null);
      return;
    }
    // مهلةٌ قصيرة قبل النداء: كل حرفٍ يُكتب نداءٌ، والبحث يمسح جداول.
    const t = setTimeout(() => {
      setBusy(true);
      api
        .search(q, scope, undefined, semantic, kbInScope ? legal : {})
        .then((r) => {
          setResult(r);
          if (r.external?.length) {
            setKnown((prev) => {
              const map = new Map(prev);
              for (const g of r.external) map.set(g.sourceId, g.sourceLabel);
              return [...map.entries()];
            });
          }
        })
        .catch(() => setResult(null))
        .finally(() => setBusy(false));
    }, 300);
    return () => clearTimeout(t);
  }, [q, scope, semantic, legal, kbInScope]);

  const empty =
    result &&
    !result.chats.length &&
    !result.outputs.length &&
    !result.kb.articles.length &&
    !result.kb.documents.length &&
    !(result.external ?? []).some((g) => g.hits.length);

  return (
    <div className="admin-wrap">
      <div className="admin-inner">
        <h1 className="page-title">بحث</h1>

        <div className="search-page-box">
          <input
            autoFocus
            placeholder="ابحث في محادثاتك ومخرجاتك وقاعدة المعرفة"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        <div className="intake-toggle wrap">
          {[...INTERNAL_SCOPES, ...known].map(([s, label]) => (
            <button key={s} className={`seg ${scope === s ? 'on' : ''}`} onClick={() => setScope(s)}>
              {label}
            </button>
          ))}
        </div>

        {/* ترشيحُ مواد الأنظمة حين تكون في النطاق (§6-1). و«تشمل الملغاة» تُطلب
            ولا تُفرض: الملغاة لا يُستشهد بها، ويحتاجها الباحث القانوني لنزاعٍ
            وقع قبل إلغائها — فتظهر كلٌّ منها بوسم «ملغاة». */}
        {kbInScope ? (
          <>
            <div className="review-filters">
              <label className="import-option">
                النظام
                <select
                  value={legal.lawId ?? ''}
                  onChange={(e) => setLegal({ ...legal, lawId: e.target.value || null, book: null })}
                >
                  <option value="">كل الأنظمة</option>
                  {laws.map((l) => (
                    <option key={l.law_id} value={l.law_id}>
                      {lawOption(l)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="import-option">
                النوع
                <select value={legal.docType ?? ''} onChange={(e) => setLegal({ ...legal, docType: e.target.value || null })}>
                  <option value="">كل الأنواع</option>
                  {docTypes.map((t) => (
                    <option key={t} value={t}>
                      {docTypeLabel(t)}
                    </option>
                  ))}
                </select>
              </label>
              {/* الباب داخل نظامٍ بعينه: أبوابُ الأنظمة كلِّها معاً قائمةٌ لا تُقرأ. */}
              {legal.lawId && books.length ? (
                <label className="import-option">
                  الباب
                  <select value={legal.book ?? ''} onChange={(e) => setLegal({ ...legal, book: e.target.value || null })}>
                    <option value="">كل الأبواب</option>
                    {books.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            <div className="intake-toggle">
              <button
                className={`seg ${legal.includeRepealed ? '' : 'on'}`}
                aria-pressed={!legal.includeRepealed}
                onClick={() => setLegal({ ...legal, includeRepealed: false })}
              >
                النافذة فقط
              </button>
              <button
                className={`seg ${legal.includeRepealed ? 'on' : ''}`}
                aria-pressed={!!legal.includeRepealed}
                onClick={() => setLegal({ ...legal, includeRepealed: true })}
              >
                تشمل الملغاة
              </button>
            </div>
          </>
        ) : null}

        {/* الدلاليُّ يُطلب ولا يُفرض: يمرّ بنموذج تضمين فيأخذ زمناً، ولا يفيد
            من يبحث عن رقم مادةٍ يعرفه. والاسم «دلالي» لا «ذكي» — §6. */}
        <label className="search-semantic">
          <input type="checkbox" checked={semantic} onChange={(e) => setSemantic(e.target.checked)} />
          بحث دلالي
        </label>

        {busy ? <p className="muted-line"><span className="spinner" /> جارٍ التحميل</p> : null}

        {empty ? <div className="empty-state">لا نتائج مطابقة لبحثك. جرّب كلمات أخرى.</div> : null}

        {result?.kb.articles.length ? (
          <>
            <div className="kb-section">قاعدة المعرفة</div>
            {result.kb.articles.map((a) => (
              <article key={a.id} className="legal-article">
                <h4>
                  <bdi>{a.lawTitle ?? ''}</bdi>
                  <LawTags repealed={a.lawRepealed} pending={a.lawPending} from={a.lawEffectiveFrom} />
                  {/* الملحق بعنوانه لا برقمه الاصطلاحيّ (§3-12). */}
                  <span className="pill pending"><ArticleName a={a} /></span>
                  <ArticleFlags a={a} />
                </h4>
                {/* نظامان باسمٍ واحد يُفرَّق بينهما بأداتهما وتاريخهما (§7-2). */}
                <LawIdentity a={a} />
                {/* التنبيه يلاحق النصّ حيث عُرض: هذه شاشةُ كل مستخدم، ونصٌّ
                    أصليّ بلا تنبيهه يُنسخ إلى مذكّرةٍ على أنه الجاري. */}
                <ArticleNotices a={a} />
                <p>{a.text}</p>
              </article>
            ))}
          </>
        ) : null}

        {result?.kb.documents.length ? (
          <>
            <div className="kb-section">الوثائق المرفوعة</div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>النظام</th>
                    <th>التصنيف</th>
                    <th>الجهة</th>
                  </tr>
                </thead>
                <tbody>
                  {result.kb.documents.map((d) => (
                    <tr key={d.id}>
                      <td><bdi>{d.title}</bdi></td>
                      <td>{d.category ?? '—'}</td>
                      <td>{d.source_authority ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        {/* مجموعةٌ لكلّ مصدر — ومصدرٌ لم يُجب تُقال حالُه ولا تُقرأ مجموعتُه
            الفارغة «لا نتائج»، فيظنّ القارئ أن الكتب خَلَت من مسألته وهي لم
            تُسأل أصلاً. */}
        {(result?.external ?? []).map((g: ExternalGroup) => (
          <div key={g.sourceId}>
            <div className="kb-section">
              <Icon.externalSource size={ICON_SM} aria-hidden /> {g.sourceLabel}
            </div>
            {g.status !== 'ok' ? (
              <p className="legal-notice-meta">
                {g.status === 'unconfigured' ? 'المصدر غير مربوط' : 'تعذّر الوصول إلى المصدر'}
              </p>
            ) : !g.hits.length ? (
              <p className="muted-line">لا نتائج في هذا المصدر</p>
            ) : (
              g.hits.map((h, i) => (
                <article key={i} className="legal-article">
                  <h4>
                    <bdi>{h.title}</bdi>
                    {h.ref ? <span className="pill pending">ص. <bdi>{h.ref}</bdi></span> : null}
                    {h.section === 'حاشية' ? <span className="chip-note">حاشية</span> : null}
                  </h4>
                  {h.author || h.category ? (
                    <p className="legal-notice-meta">
                      <bdi>{[h.author, h.category].filter(Boolean).join(' — ')}</bdi>
                    </p>
                  ) : null}
                  <p>{h.text}</p>
                  {h.url ? (
                    <a className="btn-sm" href={h.url} target="_blank" rel="noreferrer">
                      <Icon.externalLink size={ICON_SM} aria-hidden /> المصدر في {g.sourceLabel}
                    </a>
                  ) : null}
                </article>
              ))
            )}
          </div>
        ))}

        {result?.chats.length ? (
          <>
            <div className="kb-section">المحادثات</div>
            {result.chats.map((m) => (
              <button key={m.message_id} className="search-hit" onClick={() => onOpenConversation(m.conversation_id)}>
                <span className="search-hit-title">
                  <bdi>{m.title ?? 'محادثة'}</bdi>
                  <span className="compare-label"><bdi>{formatDate(m.created_at)}</bdi></span>
                </span>
                <span className="search-hit-snippet">{m.snippet}</span>
              </button>
            ))}
          </>
        ) : null}

        {result?.outputs.length ? (
          <>
            <div className="kb-section">المخرجات</div>
            {result.outputs.map((d) => (
              <button key={d.id} className="search-hit" onClick={() => onOpenConversation(d.conversation_id)}>
                <span className="search-hit-title">
                  <bdi>{d.title ?? 'محادثة'}</bdi>
                  <span className="compare-label"><bdi>{formatDate(d.created_at)}</bdi></span>
                </span>
                <span className="search-hit-snippet">{d.snippet}</span>
              </button>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}
