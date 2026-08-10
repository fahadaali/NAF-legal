import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api, ConsultConfig, DocTemplate, FieldDef, FieldType, LegalStats, RegulationRequest } from '../lib/api';
import { printDocument, fetchLetterhead, PRINT_TEMPLATE_FALLBACK } from '../lib/print';
import KbViewer, { fileKind, ViewerTarget } from './KbViewer';
import { LegalImport } from './LegalImport';
import { LegalLaws } from './LegalLaws';
import { LegalReview } from './LegalReview';
import ClauseLibrary from './ClauseLibrary';
import { RequestStatusPill } from './Support';
import { formatDate, formatNumber, formatTime } from '../lib/format';
import { Icon, ICON_MD, ICON_SM } from '../lib/icons';
import { ScrollBoxProvider, useScrollReset } from '../lib/scrollBox';

const TRACKING_SOURCES_NOTE =
  'المصادر الرسمية المعتمدة: جريدة أم القرى (uqn.gov.sa) · المركز الوطني للوثائق والمحفوظات (ncar.gov.sa) · هيئة الخبراء بمجلس الوزراء (boe.gov.sa).';

type Tab = 'kb' | 'requests' | 'tracking' | 'news' | 'forms' | 'clauses' | 'analytics' | 'users' | 'settings' | 'audit';

const TABS: [Tab, string][] = [
  ['kb', 'قاعدة المعرفة'],
  ['requests', 'طلبات الأنظمة'],
  ['tracking', 'تتبّع الأنظمة'],
  ['news', 'خلاصة الأخبار'],
  ['forms', 'نماذج الاستشارات'],
  ['clauses', 'بنك البنود'],
  ['analytics', 'التحليلات'],
  ['users', 'المستخدمون'],
  ['settings', 'الإعدادات'],
  ['audit', 'سجل التدقيق'],
];

export default function Admin() {
  const [tab, setTab] = useState<Tab>('kb');
  const [pendingRequests, setPendingRequests] = useState(0);
  /* حاوية التمرير الوحيدة في الشاشة. تُمرَّر إلى الأبناء ليُعيدوها إلى أعلاها
     عند تبدّل ما تعرضه — التفصيل في `lib/scrollBox.tsx`. */
  const box = useRef<HTMLDivElement>(null);

  // عدّاد الطلبات المعلّقة على التبويب — ليعرف مسؤول النظام دون فتحه
  const loadPending = () =>
    api.adminRegulationRequests('pending').then((r) => setPendingRequests(r.pending)).catch(() => {});
  useEffect(() => {
    loadPending();
  }, []);

  return (
    <div className="admin-wrap" ref={box}>
      <ScrollBoxProvider value={box}>
      <AdminScrollReset tab={tab} />
      <div className="admin-inner">
        <h1 className="admin-title">لوحة الإدارة</h1>
        <div className="admin-tabs">
          {TABS.map(([t, label]) => (
            <button key={t} className={`admin-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {label}
              {t === 'requests' && pendingRequests > 0 && (
                <span className="pill warn" title="طلبات بانتظار المراجعة">
                  <bdi>{formatNumber(pendingRequests)}</bdi>
                </span>
              )}
            </button>
          ))}
        </div>
        {tab === 'kb' && <KbTab />}
        {tab === 'requests' && <RequestsTab onChange={loadPending} />}
        {tab === 'tracking' && <TrackingTab />}
        {tab === 'news' && <NewsTab />}
        {tab === 'forms' && <FormsTab />}
        {tab === 'clauses' && <ClauseLibrary mode="admin" />}
        {tab === 'analytics' && <AnalyticsTab />}
        {tab === 'users' && <UsersTab />}
        {tab === 'settings' && <SettingsTab />}
        {tab === 'audit' && <AuditTab />}
      </div>
      </ScrollBoxProvider>
    </div>
  );
}

/** تبديل التبويب شاشةٌ أخرى، فتُفتح من أعلاها لا من موضع سابقتها. */
function AdminScrollReset({ tab }: { tab: Tab }) {
  useScrollReset(tab);
  return null;
}

/**
 * حالُ النظام في الواقع — أنافذٌ هو أم عُدّل أم أُلغي.
 *
 * محورٌ غيرُ محور التضمين أدناه: نظامٌ نافذ قد لا يكون مضمَّناً، وملغىً قد
 * يكون مضمَّناً وقت إلغائه. وكانت شارةٌ واحدة تخدم العمودين فتُقرأ «ساري»
 * جواباً عن «هل تُسترجَع؟».
 *
 * وألفاظُه هي المستعملة قبل هذا التغيير بلا مساس: تسويتُها مع «نافذ» و«ملغاة»
 * المسجَّلتين لحال الاسترجاع قرارُ مفرداتٍ قائم بذاته، موسومٌ في `naf-terms.md`
 * تحت «إدخال قاعدة المعرفة وتضمينها» ليُحسم بقراره لا عرَضاً.
 */
function docStatusPill(s: string) {
  const map: Record<string, [string, string]> = {
    active: ['active', 'ساري'],
    amended: ['warn', 'معدَّل'],
    repealed: ['error', 'ملغى'],
  };
  const [cls, label] = map[s] ?? ['pending', s];
  return <span className={`pill ${cls}`}>{label}</span>;
}

/**
 * حالُ الوثيقة في الفهرس المتجهي — أربعٌ لا خامسة، مسجَّلةٌ بأيقوناتها
 * وألوانها في `naf-icons.md` تحت «تضمين الوثيقة المرفوعة».
 *
 * **و`pending` لا تُقرأ وحدها.** مع فهرسٍ مهيّأ هي عملٌ يجري الآن، ومع غير
 * مهيّأ انتظارٌ لا ينتهي بلا تدخّل — والفرق بينهما هو الفرق بين «انتظرْ» و
 * «افعلْ شيئاً». ولذلك يُمرَّر حالُ الفهرس مع الحال.
 */
function embedPill(status: string, vectorize: boolean) {
  if (status === 'ready') {
    return (
      <span className="pill ready">
        <Icon.vectorIndex size={ICON_SM} aria-hidden /> مضمَّنة
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="pill error">
        <Icon.failed size={ICON_SM} aria-hidden /> تعذّر التضمين
      </span>
    );
  }
  if (!vectorize) {
    return (
      <span className="pill warn">
        <Icon.awaitingIndex size={ICON_SM} aria-hidden /> بانتظار الفهرس
      </span>
    );
  }
  return (
    <span className="pill pending">
      <Icon.embedding size={ICON_SM} aria-hidden /> جارٍ التضمين
    </span>
  );
}

/**
 * أقسام قاعدة المعرفة — ثلاثةٌ تتبع حياة النصّ لا أنواع الملفات.
 *
 * وكان شريطٌ واحد يجمع ثلاثة مصادرِ إدخال مع طابور المراجعة، بلا ما يقول
 * للمسؤول أيُّها فعلٌ يقوم به وأيُّها مكانٌ يقرأ فيه. وتحته قائمتان ثابتتان
 * تظهران في الأوضاع الأربعة — فمن يراجع مادةً يجد تحت شاشته جدولَ الأنظمة
 * كلِّه وجدولَ الوثائق، ولا صلة لهما بما يفعل.
 */
const KB_SECTIONS: [KbSection, string][] = [
  ['content', 'المحتوى'],
  ['intake', 'الإضافة'],
  ['review', 'مراجعة المواد'],
];

type KbSection = 'content' | 'intake' | 'review';

function KbTab() {
  const [section, setSection] = useState<KbSection>('content');
  /* الحال يُقرأ في الأقسام الثلاثة، فيُحمَّل هنا مرّةً ويُمرَّر — لا في كل
     قسمٍ نداءً على حدة. */
  const [stats, setStats] = useState<LegalStats | null>(null);
  const [docs, setDocs] = useState<KbDocs | null>(null);

  const loadDocs = useCallback(
    () => api.kbDocuments().then(setDocs).catch(() => {}),
    []
  );
  const loadStats = useCallback(
    () => api.legalStats().then(setStats).catch(() => {}),
    []
  );
  const reload = useCallback(() => {
    loadDocs();
    loadStats();
  }, [loadDocs, loadStats]);

  useEffect(() => {
    reload();
    // التضمين يمضي في الخادم بعد الردّ، فحالُه يتغيّر بلا فعلٍ من الشاشة.
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [reload]);

  useScrollReset(section);

  const pendingReview = stats?.needs_review ?? 0;

  return (
    <div>
      <KbStatusStrip stats={stats} docs={docs} onDone={reload} />

      <nav className="kb-nav" aria-label="أقسام قاعدة المعرفة">
        {KB_SECTIONS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`kb-nav-item ${section === key ? 'on' : ''}`}
            aria-current={section === key ? 'page' : undefined}
            onClick={() => setSection(key)}
          >
            {label}
            {/* عدّاد الطابور على اسمه: المراجعة عملٌ يتراكم، ومن لا يفتح
                القسم لا يعرف أن فيه مئتين. */}
            {key === 'review' && pendingReview > 0 ? (
              <span className="pill warn"><bdi>{formatNumber(pendingReview)}</bdi></span>
            ) : null}
          </button>
        ))}
      </nav>

      {section === 'content' ? (
        <KbContent stats={stats} docs={docs} onChange={reload} />
      ) : section === 'intake' ? (
        <KbIntake onAdded={reload} />
      ) : (
        <LegalReview />
      )}
    </div>
  );
}

/** ردّ `GET /kb/documents` — الوثائق ومعها حالُ الفهرس وعددُ المنتظر منها. */
type KbDocs = { documents: any[]; vectorize: boolean; pending_embeddings: number };

/**
 * حال قاعدة المعرفة — أعلى التبويب، ظاهرٌ في أقسامه الثلاثة.
 *
 * **وموضعه هنا لأن الحال يعمّ الأقسام.** كان حالُ الفهرس مكتوباً في آخر شاشة
 * الاستيراد وحدها: فمن يراجع المواد يبتّ في قراراتٍ سيبني عليها تضمينٌ لا
 * يقع، ولا يمرّ بتلك الشاشة ليعلم. وحالٌ يظهر في مكانٍ واحدٍ من ثلاثة
 * يُعلَم بالمصادفة.
 *
 * **ولا يُنبّه إلا حين يستحقّ التنبيه.** الفهرسُ مهيّأً ولا شيء ينتظر: أعدادٌ
 * وحدها بلا شارة. وشارةٌ دائمة تُعلّم القارئ تجاهلَ الشارات.
 */
function KbStatusStrip({
  stats,
  docs,
  onDone,
}: {
  stats: LegalStats | null;
  docs: KbDocs | null;
  onDone: () => void;
}) {
  const [draining, setDraining] = useState(false);
  /** تعثّرت دفعةٌ في آخر شوط — يُقال، ولا يُترك العددُ الواقف يقوله وحده. */
  const [stumbled, setStumbled] = useState(false);

  /* الفهرس واحد للطابورين، فحالُه يُقرأ من أيّهما ردّ أوّلاً — ولا يُدَّعى
     أنه مهيّأ قبل أن يردّ أحدهما. */
  const ready = docs?.vectorize ?? stats?.vectorize ?? null;
  const waitingChunks = stats?.pending_embeddings ?? 0;
  const waitingDocs = docs?.pending_embeddings ?? 0;
  const waiting = waitingChunks + waitingDocs;

  /**
   * يصرّف ما ينتظر التضمين في الطابورين.
   *
   * دفعاتٌ متتابعة حتى ينتهي أو يتوقّف التقدّم: لكل مقطعٍ طلبٌ إلى نموذج
   * التضمين وآخر إلى الفهرس، وللنداء الواحد سقف. والطابوران مساران مختلفان
   * — مقاطعُ في جدول واحد، ووثائقُ تُقطَّع كلٌّ وحدها — فلكلٍّ نداؤه.
   */
  const drain = async () => {
    setDraining(true);
    setStumbled(false);
    let stumble = false;
    try {
      for (;;) {
        const r = await api.legalEmbedPending(500);
        if (r.failed) stumble = true;
        if (!r.embedded || !r.remaining) break;
      }
      for (;;) {
        const r = await api.kbEmbedPending(5);
        if (r.failed) stumble = true;
        if (!r.embedded || !r.remaining) break;
      }
    } catch {
      // نداءٌ لم يصل تعثّرٌ كتعثّر الدفعة: المعلَّق باقٍ في الطابور.
      stumble = true;
    } finally {
      setStumbled(stumble);
      setDraining(false);
      onDone();
    }
  };

  return (
    <section className="kb-status" aria-label="حال قاعدة المعرفة">
      <dl className="kb-counts">
        <KbCount label="الأنظمة" value={stats?.laws} />
        <KbCount label="المواد" value={stats?.chunks} />
        <KbCount label="الوثائق" value={docs?.documents.length} />
        <KbCount label="بانتظار المراجعة" value={stats?.needs_review} />
        <KbCount label="ينتظر التضمين" value={stats ? waiting : undefined} />
      </dl>

      {ready === false ? (
        <p className="kb-index warn">
          <Icon.awaitingIndex size={ICON_SM} aria-hidden />
          <span>
            الفهرس المتجهي غير مهيّأ — البحث اللفظي في الأنظمة يعمل، والاسترجاع
            الدلالي والوثائق المرفوعة لا تصل المساعد. يُهيَّأ بمنح صلاحية الفهرس
            المتجهي لرمز النشر، ويصرّفه أوّل نشر تالٍ.
          </span>
        </p>
      ) : ready === true && waiting > 0 ? (
        <p className="kb-index">
          <Icon.vectorIndex size={ICON_SM} aria-hidden />
          <span>
            الفهرس المتجهي مهيّأ — ينتظر التضمين <bdi>{formatNumber(waiting)}</bdi>
          </span>
          <button className="btn-sm" disabled={draining} onClick={drain}>
            {draining ? (
              <><span className="spinner" /> جارٍ التضمين</>
            ) : (
              'تضمين الآن'
            )}
          </button>
        </p>
      ) : null}

      {/* سطرُ التعثّر تحت سطر الحال لا مكانه: العدد المنتظر يبقى معروضاً،
          وهذا يقول لماذا وقف. ويزول عند أوّل شوطٍ يمضي. */}
      {stumbled && !draining ? (
        <p className="kb-index warn">
          <Icon.failed size={ICON_SM} aria-hidden />
          <span>تعذّر تضمين ما تبقّى — يبقى في الطابور ويُعاد تضمينه ليلاً، أو أعد «تضمين الآن».</span>
        </p>
      ) : null}
    </section>
  );
}

/**
 * عددٌ في شريط الحال.
 *
 * وقبل وصول الردّ يُعرض شرطةٌ لا صفر: صفرٌ يُقرأ خبراً — «لا أنظمة في
 * القاعدة» — ثم ينقلب إلى واحدٍ وسبعين بعد جزءٍ من الثانية.
 */
function KbCount({ label, value }: { label: string; value?: number }) {
  return (
    <div className="kb-count">
      <dt>{label}</dt>
      <dd>{value === undefined ? '—' : <bdi>{formatNumber(value)}</bdi>}</dd>
    </div>
  );
}

/**
 * المحتوى — ما دخل القاعدة من مصدريه.
 *
 * والمصدران في قسمٍ واحد بعنوانين: المستورَد يدخل بحدود مواده، والمرفوع
 * يُستخرج ويُقطَّع. وبلا العنوانين كان «لم تُرفع أي وثيقة بعد» يُقرأ نفياً
 * للمحتوى كلِّه — وواحدٌ وسبعون نظاماً في القاعدة.
 */
function KbContent({
  stats,
  docs,
  onChange,
}: {
  stats: LegalStats | null;
  docs: KbDocs | null;
  onChange: () => void;
}) {
  const [versionsFor, setVersionsFor] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);

  const viewDoc = (d: any) => {
    const kind = fileKind(d.r2_key);
    setViewer({ title: d.title, kind, fileUrl: api.kbFileUrl(d.id), textUrl: api.kbTextUrl(d.id) });
  };

  const del = async (id: string) => {
    if (!confirm('حذف هذه الوثيقة ومتجهاتها؟')) return;
    await api.deleteKbDocument(id);
    onChange();
  };

  return (
    <div>
      <div className="kb-section">الأنظمة المستوردة</div>
      <LegalLaws stats={stats} />

      <div className="kb-section">الوثائق المرفوعة</div>
      {/* قبل وصول الردّ هيكلٌ بارتفاع الجدول لا فراغ: الجدول يحلّ محلّه في
          موضعه فلا يُزيح ما تحته، ولا يقرأ المسؤول شاشةً فارغة على قاعدةٍ
          مملوءة. */}
      {docs === null ? (
        <KbSkeleton rows={3} />
      ) : docs.documents.length === 0 ? (
        <div className="empty-state">لم تُرفع أي وثيقة بعد. ابدأ برفع أول وثيقة.</div>
      ) : (
        <div className="table-scroll">
          <table className="data-table kb-docs-table">
            <thead>
              <tr>
                <th>النظام</th>
                <th>التصنيف</th>
                <th>الجهة</th>
                <th>الحالة</th>
                <th>التضمين</th>
                <th>المقاطع</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {docs.documents.map((d) => (
                <Fragment key={d.id}>
                  <tr>
                    <td className="kb-doc-title">
                      <bdi>{d.title}</bdi>
                      {/* محورٌ ثالث غيرُ حال النظام وغيرُ حال التضمين: التتبّع
                          اليوميّ قابل النسخة بمصدرها فوجده تغيّر. وتأخذ أيقونة
                          «تحذير» ولونها — خطرٌ لم يقع بعد. */}
                      {d.needs_update ? (
                        <span className="pill warn">
                          <Icon.warning size={ICON_SM} aria-hidden /> يحتاج مراجعة
                        </span>
                      ) : null}
                    </td>
                    <td>{d.category ?? '—'}</td>
                    <td>{d.source_authority ?? '—'}</td>
                    {/* عمودان لمحورين: حالُ النظام في الواقع، وموضعُ الوثيقة
                        في الفهرس عندنا. وشارةٌ واحدة تخدمهما معاً كانت تجعل
                        «ساري» تُقرأ جواباً عن «هل تُسترجَع؟». */}
                    <td>{docStatusPill(d.status)}</td>
                    <td>{embedPill(d.ingest_status, docs.vectorize)}</td>
                    <td><bdi>{formatNumber(d.chunk_count ?? 0)}</bdi></td>
                    <td className="kb-doc-actions">
                      <button className="btn-sm primary" onClick={() => viewDoc(d)}>عرض</button>{' '}
                      <VersionUpload docId={d.id} version={d.version} onDone={onChange} />{' '}
                      <button className="btn-sm" onClick={() => setVersionsFor(versionsFor === d.id ? null : d.id)}>
                        السجل{d.version > 1 ? <> (<bdi>{formatNumber(d.version)}</bdi>)</> : null}
                      </button>{' '}
                      <button className="btn-sm" onClick={() => api.reingestKbDocument(d.id).then(onChange)}>
                        إعادة تضمين
                      </button>{' '}
                      <button className="btn-sm" onClick={() => del(d.id)}>
                        حذف
                      </button>
                    </td>
                  </tr>
                  {versionsFor === d.id && (
                    <tr>
                      <td colSpan={7} className="kb-doc-versions">
                        <VersionsList docId={d.id} onView={setViewer} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {viewer && <KbViewer target={viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}

/**
 * مصادر الإضافة — ثلاثة مساراتٍ لا ثلاثُ صيغِ ملفّ.
 *
 * **والمكان واحد والمسارات معلَنة.** الفرق بينها ليس في الامتداد بل فيما
 * يُصنع بالنصّ بعده: المرفوع يُستخرج ويُصنَّف ويُقطَّع ثم يُضمَّن، والمستورَد
 * يدخل بحدود مواده كما وردت. فمنطقةُ إفلاتٍ واحدة تُوجّه بالامتداد تُخفي
 * هذا الفرق في حرفين، ثم يُفاجَأ المستورِد بمادةٍ قُطّعت أو بوثيقةٍ دخلت
 * بلا تصنيف. ولذلك بطاقةٌ لكلٍّ تحمل سطرَه.
 */
const KB_SOURCES: { key: KbSource; label: string; note: string; glyph: keyof typeof Icon }[] = [
  {
    key: 'file',
    label: 'رفع وثيقة',
    note: 'ملف PDF أو Word أو صورة أو نصّ — يُستخرج محتواه ويُصنَّف ويُقطَّع ثم يُضمَّن',
    glyph: 'upload',
  },
  {
    key: 'text',
    label: 'لصق النصّ',
    note: 'عنوانٌ ونصّ — يمرّان بما تمرّ به الوثيقة المرفوعة سواء',
    glyph: 'pasteText',
  },
  {
    key: 'import',
    label: 'استيراد مواد',
    note: 'سطرٌ لكل مادة — تدخل بحدودها كما وردت، بلا استخراج ولا تقطيع ولا تصنيف',
    glyph: 'import',
  },
];

type KbSource = 'file' | 'text' | 'import';

function KbIntake({ onAdded }: { onAdded: () => void }) {
  const [source, setSource] = useState<KbSource>('file');
  const [busy, setBusy] = useState(false);
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  // تبدُّل المصدر يُبدّل نموذجاً بنموذج، وطولاهما مختلفان.
  useScrollReset(source);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        const fd = new FormData();
        fd.append('file', f);
        const res = await fetch('/api/kb/documents', { method: 'POST', body: fd, credentials: 'same-origin' });
        if (!res.ok) throw new Error((await res.json()).error);
      }
      onAdded();
    } catch (e: any) {
      alert(e.message ?? 'فشل الرفع');
    } finally {
      setBusy(false);
    }
  };

  const uploadText = async () => {
    if (!pasteText.trim()) return alert('الصق نص النظام/اللائحة');
    if (!pasteTitle.trim()) return alert('أدخل عنوان الوثيقة');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('text', pasteText);
      fd.append('title', pasteTitle);
      const res = await fetch('/api/kb/documents', { method: 'POST', body: fd, credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json()).error);
      setPasteText('');
      setPasteTitle('');
      onAdded();
    } catch (e: any) {
      alert(e.message ?? 'فشل الحفظ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <input
        ref={fileInput}
        type="file"
        hidden
        multiple
        accept=".pdf,.docx,.txt,.md"
        onChange={(e) => {
          upload(e.target.files);
          e.target.value = '';
        }}
      />

      {/* البطاقات باقيةٌ بعد الاختيار: البديلان المتروكان يبقيان مقروءَين،
          فمن اختار الرفع لملف مواد يرى سطرَ الاستيراد قبل أن يُخطئ. */}
      <div className="kb-sources" role="radiogroup" aria-label="مصدر الإضافة">
        {KB_SOURCES.map((s) => {
          const Glyph = Icon[s.glyph];
          return (
            <button
              key={s.key}
              type="button"
              role="radio"
              aria-checked={source === s.key}
              className={`kb-source ${source === s.key ? 'on' : ''}`}
              disabled={busy}
              onClick={() => setSource(s.key)}
            >
              <span className="kb-source-head">
                <Glyph size={ICON_MD} aria-hidden />
                {s.label}
              </span>
              <span className="kb-source-note">{s.note}</span>
            </button>
          );
        })}
      </div>

      {source === 'import' ? (
        <LegalImport />
      ) : source === 'file' ? (
        <div className="dropzone" onClick={() => !busy && fileInput.current?.click()}>
          {busy ? (
            <><span className="spinner" /> جارٍ الرفع</>
          ) : (
            <><Icon.upload size={ICON_SM} aria-hidden /> اختر ملفات — PDF أو Word أو صورة أو نصّ</>
          )}
        </div>
      ) : (
        <div className="kb-paste">
          <div className="field">
            <label htmlFor="kb-paste-title">عنوان الوثيقة</label>
            <input
              id="kb-paste-title"
              placeholder="نظام العمل"
              value={pasteTitle}
              disabled={busy}
              onChange={(e) => setPasteTitle(e.target.value)}
            />
          </div>
          <textarea
            aria-label="نصّ النظام أو اللائحة"
            className="tool-textarea"
            placeholder="الصق نصّ النظام أو اللائحة"
            value={pasteText}
            disabled={busy}
            onChange={(e) => setPasteText(e.target.value)}
          />
          <button className="btn-sm primary" onClick={uploadText} disabled={busy}>
            {busy ? <><span className="spinner" /> جارٍ الحفظ</> : 'حفظ'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * هيكلٌ يشغل موضع المحتوى ريثما يصل.
 *
 * والغرض منعُ الإزاحة لا تزيينُ الانتظار: محتوىً يُحقَن في موضعٍ فارغ يدفع
 * ما تحته، فيقرأ المسؤول شيئاً ثم يجده قد انتقل. وقياسُه تقريبيّ بطبعه —
 * ثلاثةُ صفوفٍ لا تساوي واحداً وسبعين — لكن الأثر يقلّ ولا يبقى الفراغُ
 * صفراً.
 */
function KbSkeleton({ rows }: { rows: number }) {
  return (
    <div className="kb-skeleton" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="kb-skeleton-row" />
      ))}
    </div>
  );
}

// طلبات المستخدمين لإضافة أنظمة غير موجودة في قاعدة المعرفة
const REQUEST_FILTERS: [string, string][] = [
  ['pending', 'بانتظار المراجعة'],
  ['approved', 'معتمد'],
  ['rejected', 'مرفوض'],
  ['all', 'الكل'],
];

function RequestsTab({ onChange }: { onChange: () => void }) {
  const [requests, setRequests] = useState<RegulationRequest[]>([]);
  const [filter, setFilter] = useState('pending');
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => api.adminRegulationRequests(filter).then((r) => setRequests(r.requests)).catch(() => {});
  useEffect(() => {
    load();
  }, [filter]);

  const decide = async (r: RegulationRequest, status: 'approved' | 'rejected') => {
    const note = prompt(
      status === 'approved'
        ? 'ملاحظة لمقدّم الطلب (اختياري):'
        : 'سبب الرفض لمقدّم الطلب (اختياري):'
    );
    if (note === null) return; // ألغى المسؤول
    setBusy(r.id);
    try {
      await api.decideRegulationRequest(r.id, status, note || undefined);
      load();
      onChange();
    } catch (e: any) {
      alert(e.message ?? 'تعذّر الحفظ');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <p style={{ color: 'var(--muted-foreground)', fontSize: '0.875rem', marginTop: 0 }}>
        أنظمة ولوائح طلب المستخدمون إضافتها إلى قاعدة المعرفة — من داخل المحادثة عند تعذّر الإسناد، أو من صفحة الدعم.
        بعد الاعتماد ارفع النظام من تبويب «قاعدة المعرفة».
      </p>

      <div className="intake-toggle" style={{ marginBottom: 16 }}>
        {REQUEST_FILTERS.map(([key, label]) => (
          <button key={key} className={`seg ${filter === key ? 'on' : ''}`} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
      </div>

      {requests.length === 0 ? (
        <div className="empty-state">لا طلبات في هذه الحالة. جرّب حالة أخرى.</div>
      ) : (
        <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>النظام</th>
              <th>اللائحة التنفيذية</th>
              <th>مقدّم الطلب</th>
              <th>المصدر</th>
              <th>الملاحظة</th>
              <th>التاريخ</th>
              <th>الحالة</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 600 }}>
                  {r.url ? (
                    <a href={r.url} target="_blank" rel="noopener">
                      {r.name}
                    </a>
                  ) : (
                    r.name
                  )}
                </td>
                <td>
                  {r.has_bylaw ? (
                    r.bylaw_url ? (
                      <a href={r.bylaw_url} target="_blank" rel="noopener">
                        نعم
                      </a>
                    ) : (
                      'نعم'
                    )
                  ) : (
                    'لا'
                  )}
                </td>
                <td dir="ltr" style={{ textAlign: 'end' }}>
                  {r.requester_email ?? '—'}
                </td>
                <td>{r.source === 'chat' ? 'من المحادثة' : 'من صفحة الدعم'}</td>
                <td style={{ fontSize: '0.875rem', color: 'var(--muted-foreground)' }}>{r.note ?? '—'}</td>
                <td>
                  <bdi>{formatDate(r.created_at)}</bdi>
                </td>
                <td>
                  <RequestStatusPill status={r.status} />
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {r.status === 'pending' && (
                    <>
                      <button className="btn-sm primary" disabled={busy === r.id} onClick={() => decide(r, 'approved')}>
                        اعتماد
                      </button>{' '}
                      <button className="btn-sm" disabled={busy === r.id} onClick={() => decide(r, 'rejected')}>
                        رفض
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

function TrackingTab() {
  const [data, setData] = useState<{ needs_update: any[] }>({ needs_update: [] });
  const [scanning, setScanning] = useState(false);

  const load = () => api.tracking().then(setData).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  const scan = async () => {
    setScanning(true);
    try {
      const r = await api.scanTracking();
      alert(`اكتمل الفحص: فُحص ${r.checked} نظامًا، وُضِعت علامة على ${r.flagged}.`);
      load();
    } catch (e: any) {
      alert(e.message ?? 'فشل الفحص');
    } finally {
      setScanning(false);
    }
  };

  return (
    <div>
      <p className="source-note"><Icon.officialSource size={ICON_SM} aria-hidden /> {TRACKING_SOURCES_NOTE} يفحص النظام دوريًا (يوميًا) كل نظام في قاعدة المعرفة مقابل هذه المصادر لرصد التعديلات، ويضع علامة «يحتاج مراجعة».</p>
      <div className="admin-actions">
        <button className="btn-sm primary" onClick={scan} disabled={scanning}>
          {scanning ? <><span className="spinner" /> جارٍ الفحص…</> : <><Icon.refresh size={ICON_SM} aria-hidden /> تشغيل فحص التتبّع الآن</>}
        </button>
      </div>

      <div className="section-title">أنظمة تحتاج تحديثًا</div>
      {data.needs_update.length === 0 ? (
        <div className="empty-state">لا تنبيهات جديدة. كل الأنظمة محدَّثة.</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>النظام</th>
              <th>ملخّص التغيير المكتشَف</th>
              <th>آخر فحص</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.needs_update.map((t) => (
              <tr key={t.id}>
                <td style={{ fontWeight: 600 }}>{t.title}</td>
                <td>{t.change_summary}</td>
                <td>{t.last_checked ? <bdi>{formatDate(t.last_checked)}</bdi> : '—'}</td>
                <td>
                  <button className="btn-sm" onClick={() => api.resolveTracking(t.id).then(load)}>
                    اعتمدت المراجعة
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p style={{ color: 'var(--muted-foreground)', fontSize: '0.875rem', marginTop: 16 }}>
        الأنظمة واللوائح الجديدة تُرصد في تبويب «خلاصة الأخبار» من المصادر الرسمية.
      </p>
    </div>
  );
}

function UsersTab() {
  const [users, setUsers] = useState<any[]>([]);
  const load = () => api.users().then((r) => setUsers(r.users)).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  // أُسقط إنشاءُ الحساب وتصفيرُ كلمة المرور مع الدخول الموحّد: لا كلمة مرور
  // يدخل بها أحد، فحسابٌ يُنشأ هنا لا يُوصل صاحبه إلى شيء. ومساراهما في
  // `routes/admin.ts` باقيان بلا حذف، وغير مستدعَيين من الواجهة.

  const del = async (id: string) => {
    if (!confirm('حذف هذا المستخدم نهائيًا؟')) return;
    try { await api.deleteUser(id); load(); } catch (e: any) { alert(e.message); }
  };

  return (
    <div>
      {/* بعد الدخول الموحّد: هذا الجدول سجلّ الهوية المحلية وحده. الأعضاء
          يصلون من المركز، والصلاحية تُقرَّر في شاشة «الأعضاء» من `members`،
          و`users.role` أدناه لم يعد يقرّر وصولاً — فأُزيل تحريره من هنا
          لئلّا يظنّ المسؤول أنه منح صلاحية وهو لم يمنح شيئاً. */}
      <div className="section-title">سجلّات الهوية المحلية</div>
      <p style={{ color: 'var(--muted-foreground)', fontSize: '0.875rem', marginTop: 0 }}>
        الأعضاء يصلون من مركز الهوية، ولا تُنشأ الحسابات من هنا. والصلاحيات في شاشة «الأعضاء».
      </p>
      <div className="section-title">المستخدمون</div>
      <table className="data-table">
        <thead>
          <tr>
            <th>الاسم</th>
            <th>البريد</th>
            <th>تاريخ الإنشاء</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name ?? '—'}</td>
              <td dir="ltr" style={{ textAlign: 'end' }}>{u.email}</td>
              <td><bdi>{formatDate(u.created_at)}</bdi></td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="btn-sm" onClick={() => del(u.id)}>حذف</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// رفع نسخة جديدة من نظام (مع أرشفة القديمة) — §5
function VersionUpload({ docId, version, onDone }: { docId: string; version: number; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      fd.append('note', `النسخة ${version + 1}`);
      const res = await fetch(`/api/kb/documents/${docId}/versions`, { method: 'POST', body: fd, credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json()).error);
      onDone();
    } catch (e: any) {
      alert(e.message ?? 'فشل رفع النسخة');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <input ref={ref} type="file" hidden accept=".pdf,.docx,.txt,.md" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
      <button className="btn-sm" onClick={() => ref.current?.click()} disabled={busy} title="رفع نسخة أحدث وأرشفة الحالية">
        {busy ? '…' : <><Icon.upload size={ICON_SM} aria-hidden /> نسخة جديدة</>}
      </button>
    </>
  );
}

// عرض سجل إصدارات نظام — §5
function VersionsList({ docId, onView }: { docId: string; onView: (t: ViewerTarget) => void }) {
  const [versions, setVersions] = useState<any[] | null>(null);
  useEffect(() => {
    api.kbVersions(docId).then((r) => setVersions(r.versions)).catch(() => setVersions([]));
  }, [docId]);
  if (versions === null) return <span className="spinner" />;
  if (!versions.length) return <span style={{ color: 'var(--muted-foreground)', fontSize: '0.875rem' }}>لا إصدارات سابقة — هذه النسخة الأولى.</span>;
  const view = (v: any) =>
    onView({
      title: `إصدار ${v.version}`,
      kind: fileKind(v.file_r2_key),
      fileUrl: api.kbVersionFileUrl(docId, v.id),
      textUrl: api.kbVersionTextUrl(docId, v.id),
    });
  return (
    <div style={{ fontSize: '0.875rem' }}>
      <strong style={{ fontSize: '0.875rem' }}>سجل الإصدارات:</strong>
      <ul style={{ margin: '6px 0', paddingInlineStart: 16 }}>
        {versions.map((v) => (
          <li key={v.id} style={{ margin: '5px 0' }}>
            الإصدار {v.version}
            {v.effective_from ? ` · سريان من ${v.effective_from}` : ''}
            {v.effective_to ? ` · حتى ${v.effective_to}` : ' · (سارية)'}
            {v.note ? ` — ${v.note}` : ''}
            {'  '}
            <button className="btn-sm" style={{ padding: '3px 10px' }} onClick={() => view(v)}>عرض</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewsTab() {
  const [news, setNews] = useState<any[]>([]);
  const [scanning, setScanning] = useState(false);
  const load = () => api.news().then((r) => setNews(r.news)).catch(() => {});
  useEffect(() => { load(); }, []);
  const scan = async () => {
    setScanning(true);
    try { const r = await api.scanNews(); alert(`تم رصد ${r.found} عنصرًا جديدًا.`); load(); }
    catch (e: any) { alert(e.message ?? 'فشل'); } finally { setScanning(false); }
  };
  return (
    <div>
      <p className="source-note"><Icon.officialSource size={ICON_SM} aria-hidden /> يُرصد الجديد والمحدَّث من: جريدة أم القرى (خلاصة RSS رسمية) · هيئة الخبراء بمجلس الوزراء · المركز الوطني للوثائق والمحفوظات.</p>
      <div className="admin-actions">
        <button className="btn-sm primary" onClick={scan} disabled={scanning}>
          {scanning ? <><span className="spinner" /> جارٍ الرصد…</> : <><Icon.refresh size={ICON_SM} aria-hidden /> رصد الأنظمة الجديدة والمحدَّثة</>}
        </button>
      </div>
      {news.length === 0 ? (
        <div className="empty-state">لا عناصر خلاصة بعد. شغّل الرصد لجلب أحدث الأنظمة والتعديلات.</div>
      ) : (
        <table className="data-table">
          <thead><tr><th>العنوان</th><th>الملخّص</th><th>النوع</th><th></th></tr></thead>
          <tbody>
            {news.map((n) => (
              <tr key={n.id}>
                <td style={{ fontWeight: 600 }}>{n.url ? <a href={n.url} target="_blank" rel="noopener">{n.title}</a> : n.title}</td>
                <td style={{ fontSize: '0.875rem', color: 'var(--muted-foreground)' }}>{n.summary}</td>
                <td>{n.kind === 'new_regulation' ? 'نظام جديد' : n.kind === 'amendment' ? 'تعديل' : 'أخرى'}</td>
                <td><button className="btn-sm" onClick={() => api.ingestNews(n.id).then(() => alert('تمت الإضافة إلى قاعدة المعرفة كمقترَح.'))}>استيعاب</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// بنّاء نماذج الاستشارات: البرومبت + طلب الملف + الحقول
function FormsTab() {
  const [configs, setConfigs] = useState<ConsultConfig[]>([]);
  const [key, setKey] = useState<string>('');
  const [draft, setDraft] = useState<ConsultConfig | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () =>
    api.adminConsultationConfigs().then((r) => {
      setConfigs(r.configs);
      if (!key && r.configs.length) {
        setKey(r.configs[0].key);
        setDraft(structuredClone(r.configs[0]));
      }
    }).catch(() => {});
  useEffect(() => { load(); }, []);

  const select = (k: string) => {
    setKey(k);
    const c = configs.find((x) => x.key === k);
    if (c) setDraft(structuredClone(c));
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const r = await api.saveConsultationConfig(draft.key, draft);
      setConfigs((cs) => cs.map((c) => (c.key === draft.key ? r.config : c)));
      alert('تم حفظ الإعداد.');
    } catch (e: any) {
      alert(e.message ?? 'فشل الحفظ');
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!draft || !confirm('إعادة هذا النوع إلى الإعداد الافتراضي؟')) return;
    const r = await api.resetConsultationConfig(draft.key);
    setDraft(structuredClone(r.config));
    setConfigs((cs) => cs.map((c) => (c.key === draft.key ? r.config : c)));
  };

  const setField = (i: number, patch: Partial<FieldDef>) => {
    if (!draft) return;
    const fields = draft.fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f));
    setDraft({ ...draft, fields });
  };
  const addField = () => {
    if (!draft) return;
    setDraft({ ...draft, fields: [...draft.fields, { key: 'f' + Date.now(), label: 'حقل جديد', type: 'text' as FieldType }] });
  };
  const removeField = (i: number) => {
    if (!draft) return;
    setDraft({ ...draft, fields: draft.fields.filter((_, idx) => idx !== i) });
  };
  const move = (i: number, dir: -1 | 1) => {
    if (!draft) return;
    const j = i + dir;
    if (j < 0 || j >= draft.fields.length) return;
    const fields = [...draft.fields];
    [fields[i], fields[j]] = [fields[j], fields[i]];
    setDraft({ ...draft, fields });
  };

  if (!draft) return <div className="empty-state"><span className="spinner" /></div>;

  return (
    <div>
      <div className="field" style={{ maxWidth: 360 }}>
        <label>نوع الاستشارة</label>
        <select value={key} onChange={(e) => select(e.target.value)} style={{ width: '100%', padding: 8, borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--foreground)' }}>
          {configs.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
      </div>

      <div className="section-title">توجيه النظام (البرومبت المُرسَل إلى Claude)</div>
      <textarea className="cfg-prompt" value={draft.system_prompt ?? ''} onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })} />

      <div className="section-title">طلب الملف</div>
      <div className="cfg-field-row">
        <label><input type="checkbox" checked={draft.file.enabled} onChange={(e) => setDraft({ ...draft, file: { ...draft.file, enabled: e.target.checked } })} /> تفعيل طلب ملف</label>
        {draft.file.enabled && (
          <>
            <input placeholder="اسم المطالبة (مثال: صك الحكم)" value={draft.file.label} onChange={(e) => setDraft({ ...draft, file: { ...draft.file, label: e.target.value } })} style={{ minWidth: 240 }} />
            <label><input type="checkbox" checked={draft.file.required} onChange={(e) => setDraft({ ...draft, file: { ...draft.file, required: e.target.checked } })} /> إلزامي</label>
            <label><input type="checkbox" checked={draft.file.allow_text} onChange={(e) => setDraft({ ...draft, file: { ...draft.file, allow_text: e.target.checked } })} /> السماح بلصق النص بدلًا من الملف</label>
          </>
        )}
      </div>

      <div className="section-title">الحقول المطلوب تعبئتها</div>
      {draft.fields.map((f, i) => (
        <div className="cfg-field-row" key={f.key}>
          <input placeholder="اسم الحقل" value={f.label} onChange={(e) => setField(i, { label: e.target.value })} style={{ minWidth: 240 }} />
          <select value={f.type} onChange={(e) => setField(i, { type: e.target.value as FieldType })}>
            <option value="text">نص قصير</option>
            <option value="number">رقم</option>
            <option value="textarea">فقرة طويلة (تتمدّد)</option>
          </select>
          <label><input type="checkbox" checked={!!f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> إلزامي</label>
          <button className="btn-sm" onClick={() => move(i, -1)} title="أعلى"><Icon.moveUp size={ICON_SM} aria-hidden /></button>
          <button className="btn-sm" onClick={() => move(i, 1)} title="أسفل"><Icon.moveDown size={ICON_SM} aria-hidden /></button>
          <button className="btn-sm" onClick={() => removeField(i)}>حذف</button>
        </div>
      ))}
      <button className="btn-sm" onClick={addField}>＋ إضافة حقل</button>

      <div className="admin-actions" style={{ marginTop: 24 }}>
        <button className="btn-sm primary" onClick={save} disabled={saving}>{saving ? 'جارٍ الحفظ…' : 'حفظ'}</button>
        <button className="btn-sm" onClick={reset}>إعادة للافتراضي</button>
      </div>
    </div>
  );
}

function AnalyticsTab() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api.analytics().then(setData).catch(() => {}); }, []);
  if (!data) return <div className="empty-state"><span className="spinner" /></div>;
  const t = data.totals ?? {};
  const cost = (Number(t.cost) || 0).toFixed(2);
  return (
    <div>
      <p style={{ color: 'var(--muted-foreground)', fontSize: '0.875rem' }}>آخر 30 يومًا</p>
      <div className="stat-row">
        <div className="stat-card"><div className="stat-val">{t.events ?? 0}</div><div className="stat-lbl">عملية</div></div>
        <div className="stat-card"><div className="stat-val"><bdi>{((Number(t.in_tok) + Number(t.out_tok)) / 1000).toFixed(1)}k</bdi></div><div className="stat-lbl">إجمالي الرموز</div></div>
        <div className="stat-card"><div className="stat-val">${cost}</div><div className="stat-lbl">التكلفة التقديرية</div></div>
      </div>

      <div className="section-title">حسب نوع العملية</div>
      <table className="data-table">
        <thead><tr><th>العملية</th><th>العدد</th><th>التكلفة</th></tr></thead>
        <tbody>{(data.by_kind ?? []).map((k: any) => (
          <tr key={k.kind}><td>{k.kind}</td><td><bdi>{k.n}</bdi></td><td><bdi>${(Number(k.cost) || 0).toFixed(3)}</bdi></td></tr>
        ))}</tbody>
      </table>

      <div className="section-title">أكثر أنواع الاستشارات طلبًا</div>
      <table className="data-table">
        <thead><tr><th>النوع</th><th>العدد</th></tr></thead>
        <tbody>{(data.by_type ?? []).map((k: any) => (
          <tr key={k.consultation_type}><td>{k.consultation_type}</td><td><bdi>{k.n}</bdi></td></tr>
        ))}</tbody>
      </table>

      <div className="section-title">الاستهلاك حسب المستخدم</div>
      <table className="data-table">
        <thead><tr><th>المستخدم</th><th>العمليات</th><th>التكلفة</th></tr></thead>
        <tbody>{(data.by_user ?? []).map((u: any, i: number) => (
          <tr key={i}><td dir="ltr" style={{ textAlign: 'end' }}>{u.email ?? '—'}</td><td><bdi>{u.n}</bdi></td><td><bdi>${(Number(u.cost) || 0).toFixed(3)}</bdi></td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function SettingsTab() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [firmName, setFirmName] = useState('');
  const lhInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    api.settings().then((r) => { setSettings(r.settings); setFirmName(r.settings.firm_name ?? ''); }).catch(() => {});
  }, []);

  const saveFirm = async () => { await api.saveSettings({ firm_name: firmName }); alert('تم الحفظ.'); };

  const uploadLetterhead = async (f: File | undefined) => {
    if (!f) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      /* المتجهة تُرفع ومعها نقطيّتها: Word لا يعرض SVG وحده — امتداده يوجب
         بديلاً نقطياً — ولا مُحرّك رسم في Worker. والمتصفّح هنا يملكه. */
      if (f.type.includes('svg')) fd.append('raster', await rasterizeSvg(f), 'letterhead.png');
      const res = await fetch('/api/admin/letterhead', { method: 'POST', body: fd, credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json()).error);
      alert('تم رفع رأسية الشركة. ستظهر في مخرجات Word و PDF.');
      api.settings().then((r) => setSettings(r.settings));
    } catch (e: any) { alert(e.message ?? 'فشل الرفع'); } finally { setUploading(false); }
  };

  // يفتح صفحة طباعة بالقالب الحالي — تُراجَع الهوامش قبل تصدير مسودّة حقيقية
  const previewTemplate = async () => {
    let template = PRINT_TEMPLATE_FALLBACK;
    let letterheadUrl: string | undefined;
    try {
      const r = await api.docTemplate();
      template = r.template;
      if (r.letterhead) letterheadUrl = await fetchLetterhead(api.letterheadUrl());
    } catch {}
    // فقرات مكرّرة تتجاوز الصفحة الواحدة: صفحة المتابعة هي موضع الخطأ عادةً
    const sample = Array.from({ length: 14 }, () => `<p>${DISCLAIMER_TEXT}</p>`);
    sample.splice(5, 0, '<h2>قالب المستند</h2>');
    printDocument({
      title: firmName || 'معاينة',
      html: sample.join('\n'),
      template,
      letterheadUrl,
      disclaimer: DISCLAIMER_TEXT,
    });
  };

  return (
    <div style={{ maxWidth: 560 }}>
      <div className="section-title">اسم الشركة</div>
      <div className="field">
        <input value={firmName} onChange={(e) => setFirmName(e.target.value)} placeholder="شركة ناف القانونية" />
      </div>
      <button className="btn-sm primary" onClick={saveFirm}>حفظ</button>

      <div className="section-title">رأسية الشركة لقوالب Word و PDF (صورة A4)</div>
      <p style={{ color: 'var(--muted-foreground)', fontSize: '0.875rem' }}>
        ارفع صورة رأسية بمقاس A4 (SVG أو PNG أو JPEG) لتُطبع خلف النص في كل صفحة من مستندات Word و PDF.
        {settings.letterhead_mime
          ? settings.letterhead_mime.includes('svg')
            ? ' رأسية متجهة مرفوعة حاليًا.'
            : ' رأسية مرفوعة حاليًا.'
          : ' لا توجد رأسية بعد.'}
      </p>
      <input ref={lhInput} type="file" hidden accept="image/svg+xml,image/png,image/jpeg" onChange={(e) => { uploadLetterhead(e.target.files?.[0]); e.target.value = ''; }} />
      <button className="btn-sm primary" onClick={() => lhInput.current?.click()} disabled={uploading}>
        {uploading ? <><span className="spinner" /> جارٍ الرفع…</> : <><Icon.upload size={ICON_SM} aria-hidden /> رفع صورة الرأسية</>}
      </button>

      <DocTemplateFields />

      <div className="section-title">معاينة قالب المستند</div>
      <p style={{ color: 'var(--muted-foreground)', fontSize: '0.875rem' }}>
        يفتح صفحة طباعة بنصّ نموذجي بالقالب الحالي ورأسيته — تُراجَع فيها الهوامش قبل تصدير مسودّة حقيقية.
      </p>
      <button className="btn-sm" onClick={previewTemplate}>
        <Icon.download size={ICON_SM} aria-hidden /> معاينة
      </button>

      <div className="section-title">بوّابة الاعتماد قبل التصدير</div>
      <p style={{ color: 'var(--muted-foreground)', fontSize: '0.875rem' }}>
        عند التفعيل، لا يمكن تصدير أي مسودّة (Word/PDF/نص) قبل اعتمادها من محامٍ عبر «تعديل واعتماد».
      </p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.875rem', marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={settings.require_approval_before_export === 'true'}
          onChange={async (e) => {
            const val = e.target.checked ? 'true' : 'false';
            await api.saveSettings({ require_approval_before_export: val });
            setSettings((s) => ({ ...s, require_approval_before_export: val }));
          }}
        />
        إلزام اعتماد محامٍ قبل التصدير
      </label>

      <div className="section-title">فحص Workers AI (التضمين)</div>
      <p style={{ color: 'var(--muted-foreground)', fontSize: '0.875rem' }}>يشغّل استدعاء تضمين صغيرًا للتأكّد من عمل Workers AI على الخادم.</p>
      <AiCheck />

      <div className="section-title">فحص Claude (التخطيط والتوليد)</div>
      <p className="source-note">
        يشغّل استدعاءً صغيرًا لكل نموذج مضبوط. إن ظهر «غير مربوط» هنا فالخلل في الخدمة أو المفتاح أو شكل الطلب، لا في صلاحية المستخدم.
      </p>
      <ClaudeCheck />
    </div>
  );
}

/** نصّ إخلاء المسؤولية — نفسه في الشاشة وفي كل مستند مُصدَّر. */
const DISCLAIMER_TEXT = 'هذا المحتوى مسودّة مساعِدة تتطلّب مراجعة محامٍ مختصّ قبل الاعتماد.';

/** مقاس A4 عند ١٥٠ نقطة/بوصة — يكفي طباعةً ولا يُثقل المستند. */
const A4_RASTER = { width: 1240, height: 1754 };

/**
 * يرسم SVG على لوحة بمقاس A4 ويعيدها PNG.
 *
 * ولا تُمرَّر رسالةُ الخطأ إلى الشاشة: الرفع فشل، والتفصيل في السجلّ — ونصّ
 * الشاشة مسجَّل سلفاً في مسار الرفع.
 */
async function rasterizeSvg(file: File): Promise<Blob> {
  let source = await file.text();
  // ملفٌ بلا مقاس صريح يعطيه المتصفّح عرضاً صفرياً فلا يُرسم منه شيء
  if (!/<svg[^>]*\swidth=/.test(source)) {
    source = source.replace(/<svg\b/, `<svg width="${A4_RASTER.width}" height="${A4_RASTER.height}"`);
  }
  const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error());
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = A4_RASTER.width;
    canvas.height = A4_RASTER.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error();
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error();
    return blob;
  } catch (e: any) {
    console.error('svg rasterize failed:', e?.message ?? e);
    throw new Error();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * حقول قالب المستند — يقرأها تصدير Word وطباعة PDF معاً.
 *
 * والهوامش هي نطاق الكتابة: ما يُترك للرأسية أعلى الورقة وللذيل أسفلها. وهي
 * تختلف باختلاف الرأسية المرفوعة، فلا تُجمَّد في الكود.
 */
function DocTemplateFields() {
  const [t, setT] = useState<DocTemplate | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.docTemplate().then((r) => setT(r.template)).catch(() => setT(PRINT_TEMPLATE_FALLBACK));
  }, []);

  if (!t) return null;
  const set = (patch: Partial<DocTemplate>) => setT({ ...t, ...patch });
  const nnum = (v: string, fallback: number) => (v.trim() === '' ? fallback : Number(v));

  const save = async () => {
    setSaving(true);
    try {
      await api.saveSettings({
        doc_font_family: t.fontFamily,
        doc_heading_pt: String(t.headingPt),
        doc_body_pt: String(t.bodyPt),
        doc_margin_top_mm: String(t.marginTopMm),
        doc_margin_bottom_mm: String(t.marginBottomMm),
        doc_margin_side_mm: String(t.marginSideMm),
      });
      // الخادم يضبط القيم داخل حدودها، فتُقرأ ثانيةً لا يُفترض قبولها كما أُرسلت
      const r = await api.docTemplate();
      setT(r.template);
      alert('تم الحفظ.');
    } catch (e: any) {
      alert(e.message ?? 'فشل الحفظ');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="section-title">قالب المستند: الخط ونطاق الكتابة</div>
      <p style={{ color: 'var(--muted-foreground)', fontSize: '0.875rem' }}>
        تسري على مستندات Word وصفحات الطباعة معًا. ونطاق الكتابة هو ما يُترك للرأسية أعلى الورقة وللذيل أسفلها.
      </p>

      <div className="field">
        <label>نوع الخط</label>
        <input
          value={t.fontFamily}
          onChange={(e) => set({ fontFamily: e.target.value })}
          placeholder="IBM Plex Sans Arabic"
        />
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: '1 1 140px' }}>
          <label>حجم العناوين (نقطة)</label>
          <input type="number" min={8} max={48} step={1} value={t.headingPt}
            onChange={(e) => set({ headingPt: nnum(e.target.value, t.headingPt) })} />
        </div>
        <div className="field" style={{ flex: '1 1 140px' }}>
          <label>حجم المتن (نقطة)</label>
          <input type="number" min={8} max={24} step={1} value={t.bodyPt}
            onChange={(e) => set({ bodyPt: nnum(e.target.value, t.bodyPt) })} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: '1 1 120px' }}>
          <label>هامش أعلى (ملّيمتر)</label>
          <input type="number" min={0} max={120} step={1} value={t.marginTopMm}
            onChange={(e) => set({ marginTopMm: nnum(e.target.value, t.marginTopMm) })} />
        </div>
        <div className="field" style={{ flex: '1 1 120px' }}>
          <label>هامش أسفل (ملّيمتر)</label>
          <input type="number" min={0} max={120} step={1} value={t.marginBottomMm}
            onChange={(e) => set({ marginBottomMm: nnum(e.target.value, t.marginBottomMm) })} />
        </div>
        <div className="field" style={{ flex: '1 1 120px' }}>
          <label>هامش الجانبين (ملّيمتر)</label>
          <input type="number" min={0} max={80} step={1} value={t.marginSideMm}
            onChange={(e) => set({ marginSideMm: nnum(e.target.value, t.marginSideMm) })} />
        </div>
      </div>

      <button className="btn-sm primary" onClick={save} disabled={saving}>
        {saving ? <><span className="spinner" /> جارٍ الحفظ…</> : 'حفظ'}
      </button>
    </>
  );
}

function AiCheck() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.aiCheck();
      setResult(r.ok ? `مربوط — النموذج ${r.model} · أبعاد المتجه ${r.dimensions} · ${r.ms}ms` : `غير مربوط — ${r.error}`);
    } catch (e: any) {
      setResult(`غير مربوط — ${e.message ?? ''}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <button className="btn-sm primary" onClick={run} disabled={busy}>
        {busy ? <><span className="spinner" /> جارٍ الفحص…</> : 'فحص Workers AI'}
      </button>
      {result && <p style={{ marginTop: 8, fontSize: '0.875rem' }}>{result}</p>}
    </div>
  );
}

/**
 * فحص Claude — سطرٌ لكل نموذج مضبوط.
 *
 * المعرّفات والأزمنة لاتينية داخل نصٍّ عربي، فكلٌّ منها في `bdi` وإلا أعاد
 * العربي ترتيبها (§٢ من قواعد الواجهة).
 */
function ClaudeCheck() {
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<
    { model: string; ok: boolean; ms: number; served_by?: string; error?: string }[] | null
  >(null);
  const run = async () => {
    setBusy(true);
    setChecks(null);
    try {
      const r = await api.claudeCheck();
      setChecks(r.checks);
    } catch (e: any) {
      setChecks([{ model: '—', ok: false, ms: 0, error: e.message ?? '' }]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <button className="btn-sm primary" onClick={run} disabled={busy}>
        {busy ? <><span className="spinner" /> جارٍ الفحص…</> : 'فحص Claude'}
      </button>
      {checks?.map((r) => (
        <p key={r.model} className="source-note">
          {r.ok ? (
            <>
              مربوط — النموذج <bdi>{r.model}</bdi> · <bdi>{r.ms}ms</bdi>
              {/* البديل التلقائي يخدم الطلب عند رفض المصنّف، فيُذكر متى اختلف. */}
              {r.served_by && r.served_by !== r.model && <> · خدمه <bdi>{r.served_by}</bdi></>}
            </>
          ) : (
            <>غير مربوط — النموذج <bdi>{r.model}</bdi> · <bdi>{r.error}</bdi></>
          )}
        </p>
      ))}
    </div>
  );
}

function AuditTab() {
  const [entries, setEntries] = useState<any[]>([]);
  useEffect(() => {
    api.audit().then((r) => setEntries(r.entries)).catch(() => {});
  }, []);

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>الفاعل</th>
          <th>الفعل</th>
          <th>الهدف</th>
          <th>الوقت</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id}>
            <td dir="ltr" style={{ textAlign: 'end' }}>{e.actor_email ?? e.actor_id ?? '—'}</td>
            <td><code>{e.action}</code></td>
            <td style={{ fontSize: '0.875rem', color: 'var(--muted-foreground)' }}>{e.target}</td>
            <td><bdi>{formatDate(e.created_at)} {formatTime(e.created_at)}</bdi></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
