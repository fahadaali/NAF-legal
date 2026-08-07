// البحث في المنصة — محادثاتك ومخرجاتك وقاعدة المعرفة.
//
// لفظيٌّ بلا ذكاء اصطناعي: تُطابَق كلماتك كما كتبتَها، فلا انتظارَ نموذجٍ
// ولا كلفةَ نداء. والاسترجاع في المحادثة يبقى كما هو — ذاك استشهادٌ في
// إجابةٍ مولَّدة، وهذا بحثٌ مباشر.
import { useEffect, useState } from 'react';
import { api, type PlatformSearch } from '../lib/api';
import { formatDate } from '../lib/format';
import { ArticleFlags, ArticleNotices } from './LegalArticleView';

type Scope = 'all' | 'chats' | 'outputs' | 'kb';

const SCOPES: [Scope, string][] = [
  ['all', 'الكل'],
  ['chats', 'المحادثات'],
  ['outputs', 'المخرجات'],
  ['kb', 'قاعدة المعرفة'],
];

export default function SearchPage({ initial, onOpenConversation }: { initial: string; onOpenConversation: (id: string) => void }) {
  const [q, setQ] = useState(initial);
  const [scope, setScope] = useState<Scope>('all');
  const [result, setResult] = useState<PlatformSearch | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!q.trim()) {
      setResult(null);
      return;
    }
    // مهلةٌ قصيرة قبل النداء: كل حرفٍ يُكتب نداءٌ، والبحث يمسح جداول.
    const t = setTimeout(() => {
      setBusy(true);
      api
        .search(q, scope)
        .then(setResult)
        .catch(() => setResult(null))
        .finally(() => setBusy(false));
    }, 300);
    return () => clearTimeout(t);
  }, [q, scope]);

  const empty =
    result && !result.chats.length && !result.outputs.length && !result.kb.articles.length && !result.kb.documents.length;

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

        <div className="intake-toggle">
          {SCOPES.map(([s, label]) => (
            <button key={s} className={`seg ${scope === s ? 'on' : ''}`} onClick={() => setScope(s)}>
              {label}
            </button>
          ))}
        </div>

        {busy ? <p className="muted-line"><span className="spinner" /> جارٍ التحميل</p> : null}

        {empty ? <div className="empty-state">لا نتائج مطابقة لبحثك. جرّب كلمات أخرى.</div> : null}

        {result?.kb.articles.length ? (
          <>
            <div className="kb-section">قاعدة المعرفة</div>
            {result.kb.articles.map((a) => (
              <article key={a.id} className="legal-article">
                <h4>
                  <bdi>{a.lawTitle ?? ''}</bdi>
                  {a.articleNo ? <span className="pill pending">المادة <bdi>{a.articleNo}</bdi></span> : null}
                  <ArticleFlags a={a} />
                </h4>
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
