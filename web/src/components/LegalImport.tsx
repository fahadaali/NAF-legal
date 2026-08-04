// استيراد المحتوى النظامي — عقد الاستيراد في docs/legal-import.md
//
// سطر واحد = مادة واحدة، ولا تُقطَّع المواد هنا ولا في الخادم. الشاشة لا
// تتحقّق من الأسطر بنفسها: التحقّق في الخادم وحده، ونسخُه هنا يخلق مصدرين
// للحقيقة يفترقان أوّل تعديل في العقد. مهمّتها إيصال الأسطر وعرض تقريرها.
//
// ولا أيقونة في هذه الشاشة: «استيراد» ليس له مقابل مسجَّل في naf-icons.md،
// واستعارة `Upload` تصادم «رفع» المسجَّلة لمعنى آخر.
import { useEffect, useRef, useState } from 'react';
import { api, type LegalImportReport, type LegalStats } from '../lib/api';
import { formatNumber } from '../lib/format';

/**
 * أسطر الدفعة الواحدة.
 *
 * التقسيم بالأسطر لا بالحجم: سطرٌ = مادة، وقصّ الملف بالبايت يشقّ سطراً في
 * منتصفه فتضيع مادة ويُرفض ما بعدها. والدفعات متتابعة لا متوازية، ليقف
 * استيراد الملف عند أوّل دفعة تُرفَض بدل أن تمضي بقيتها على الخطأ نفسه.
 */
const BATCH_LINES = 500;

/** نتيجة ملف واحد من الاختيار. */
interface FileResult {
  name: string;
  ok: boolean;
  inserted: number;
  updated: number;
  /** مواد بُني نصُّ تضمينها لغيابه — بطلبٍ صريح. */
  built?: number;
  /** أسطر تُخطّيت في وضع «ما صحّ». */
  skipped?: number;
  report?: LegalImportReport;
}

export function LegalImport() {
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState<{ name: string; file: number; files: number; batch: number; batches: number } | null>(null);
  const [results, setResults] = useState<FileResult[]>([]);
  const [stats, setStats] = useState<LegalStats | null>(null);
  // معطَّل افتراضياً: العقد يشترط `embed_text` في الملف، وهذا استثناءٌ يُطلَب
  // ولا يقع من نفسه — ويُقال في التقرير كم مادة بُني نصُّ تضمينها.
  const [buildEmbed, setBuildEmbed] = useState(false);
  // الصرامة هي الافتراض: نظامٌ نصفه مستورد أسوأ من نظام لم يُستورَد. وهذا
  // الخيار لمن يعرف ما يتخطّاه — والمتخطَّى معدودٌ ومذكورٌ بأسبابه.
  const [partial, setPartial] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const loadStats = () => {
    api.legalStats().then(setStats).catch(() => {});
  };
  useEffect(loadStats, []);

  /**
   * يستورد ملفاً واحداً.
   *
   * وحدة «الكل أو لا شيء» هي الملف لا الاختيار كلّه: نظامٌ نصفه مستورد أسوأ
   * من نظام لم يُستورَد، أما نظامٌ سليم بجانب نظامٍ مرفوض فلا ضرر فيه. فيمضي
   * الاستيراد إلى الملف التالي ويُذكر لكلٍّ حالُه.
   */
  const importFile = async (file: File, index: number, count: number): Promise<FileResult> => {
    const text = await file.text();
    const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
    if (!lines.length) {
      return { name: file.name, ok: false, inserted: 0, updated: 0, report: { ok: false, error: 'لا سطور في الملف' } };
    }

    const batches = Math.ceil(lines.length / BATCH_LINES);
    let inserted = 0;
    let updated = 0;
    let built = 0;
    let skipped = 0;
    const summary: NonNullable<LegalImportReport['error_summary']> = [];

    for (let start = 0; start < lines.length; start += BATCH_LINES) {
      setNow({ name: file.name, file: index + 1, files: count, batch: Math.floor(start / BATCH_LINES) + 1, batches });
      const batch = await api.importLegal(lines.slice(start, start + BATCH_LINES), file.name, { buildEmbed, partial });
      if (!batch.ok) {
        // أرقام الأسطر تُردّ إلى مواضعها في الملف الأصلي: رقمٌ داخل دفعة
        // لا يدلّ صاحبَ الملف على شيء.
        return {
          name: file.name,
          ok: false,
          inserted,
          updated,
          report: {
            ...batch,
            errors: (batch.errors ?? []).map((e) => ({ ...e, line: start + e.line })),
            error_summary: (batch.error_summary ?? []).map((g) => ({ ...g, lines: g.lines.map((l) => start + l) })),
          },
        };
      }
      inserted += batch.inserted ?? 0;
      updated += batch.updated ?? 0;
      built += batch.embed_text_built ?? 0;
      // في وضع «ما صحّ»: الدفعة تنجح ومعها أسطرٌ متخطّاة. تُجمع أسبابها
      // ليُقال ما فات، فتخطٍّ صامت يجعل نظاماً ناقصاً يبدو تامّاً.
      if (batch.failed) {
        skipped += batch.failed;
        summary.push(...(batch.error_summary ?? []).map((g) => ({ ...g, lines: g.lines.map((l) => start + l) })));
      }
    }
    return { name: file.name, ok: true, inserted, updated, built, skipped, report: skipped ? { ok: true, error_summary: summary } : undefined };
  };

  const run = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setResults([]);
    const chosen = Array.from(files);
    const done: FileResult[] = [];
    try {
      for (let i = 0; i < chosen.length; i++) {
        try {
          done.push(await importFile(chosen[i], i, chosen.length));
        } catch (e: any) {
          done.push({
            name: chosen[i].name,
            ok: false,
            inserted: 0,
            updated: 0,
            report: { ok: false, error: e?.message ?? 'تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة' },
          });
        }
        setResults([...done]);
      }
    } finally {
      setBusy(false);
      setNow(null);
      loadStats();
    }
  };

  // المرفوض والمُستورَد جزئياً كلاهما يحتاج جدول أسباب.
  const withCauses = results.filter((r) => r.report?.error_summary?.length || !r.ok);

  return (
    <div>
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept=".jsonl,.ndjson"
        onChange={(e) => {
          run(e.target.files);
          e.target.value = '';
        }}
      />

      <label className="import-option">
        <input type="checkbox" checked={buildEmbed} disabled={busy} onChange={(e) => setBuildEmbed(e.target.checked)} />
        بناء نصّ التضمين عند غيابه — من اسم النظام ورقم المادة ونصّها
      </label>
      <label className="import-option">
        <input type="checkbox" checked={partial} disabled={busy} onChange={(e) => setPartial(e.target.checked)} />
        استيراد ما صحّ وتخطّي ما رُفض — ويُذكر المتخطّى بأسبابه
      </label>

      <div className="dropzone" onClick={() => !busy && input.current?.click()}>
        {busy && now ? (
          <>
            <span className="spinner" /> جارٍ الاستيراد <bdi>{now.name}</bdi>{' '}
            {now.files > 1 ? (
              <>
                (<bdi>{formatNumber(now.file)}</bdi> / <bdi>{formatNumber(now.files)}</bdi>)
              </>
            ) : null}
            {now.batches > 1 ? (
              <>
                {' '}
                <bdi>{formatNumber(now.batch)}</bdi> / <bdi>{formatNumber(now.batches)}</bdi>
              </>
            ) : null}
          </>
        ) : (
          <>اختر ملفات JSONL — سطر مستقل لكل مادة، تُستورَد كما هي ولا يُعاد تقطيعها</>
        )}
      </div>

      {results.length > 0 && (
        <div className="import-report">
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>الملف</th>
                  <th>الحالة</th>
                  <th>مواد جديدة</th>
                  <th>مواد مستبدَلة</th>
                  <th>نصّ تضمين مبنيّ</th>
                  <th>أسطر متخطّاة</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i}>
                    <td><bdi>{r.name}</bdi></td>
                    <td>
                      <span className={`pill ${!r.ok ? 'error' : r.skipped ? 'warn' : 'ready'}`}>
                        {!r.ok ? 'الملف مرفوض' : r.skipped ? 'استيراد جزئي' : 'تم الاستيراد'}
                      </span>
                    </td>
                    <td><bdi>{formatNumber(r.inserted)}</bdi></td>
                    <td><bdi>{formatNumber(r.updated)}</bdi></td>
                    <td><bdi>{formatNumber(r.built ?? 0)}</bdi></td>
                    <td><bdi>{formatNumber(r.skipped ?? 0)}</bdi></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {withCauses.map((r, i) => (
            <div key={i} className="import-report">
              <p>
                <bdi>{r.name}</bdi>:{' '}
                {r.ok ? 'أسطر تُخطّيت' : (r.report?.error ?? 'أسطر غير صالحة — لم يُكتب شيء')}
              </p>
              {/* «وما استُورد قبلها محفوظ» تُقال حين يكون قبلها شيء فعلاً. وقولها
                  مع صفر يُقلق بلا سبب: يوهم أن شيئاً كُتب ثم ضاع. */}
              {r.inserted + r.updated > 0 ? (
                <p>
                  وما استُورد من هذا الملف قبل الرفض محفوظ: <bdi>{formatNumber(r.inserted + r.updated)}</bdi> مادة.
                </p>
              ) : null}

              {r.report?.error_summary?.length ? (
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>السبب</th>
                        <th>الأسطر</th>
                        <th>الحقول الموجودة</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.report.error_summary.map((g, j) => (
                        <tr key={j}>
                          <td>{g.error}</td>
                          <td>
                            <bdi>{formatNumber(g.count)}</bdi>
                            {/* أمثلةٌ من أرقام الأسطر: تكفي لفتح الملف على
                                موضع العطب، ولا تُغرق الجدول بمئة رقم. */}
                            {g.lines.length ? (
                              <>
                                {' '}
                                (<bdi>{g.lines.map((l) => formatNumber(l)).join(' · ')}</bdi>)
                              </>
                            ) : null}
                          </td>
                          <td>{g.keys?.length ? <bdi>{g.keys.join(' · ')}</bdi> : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {stats && stats.chunks === 0 && !busy ? (
        <div className="empty-state">لا محتوى نظامي بعد. استورد أول ملف.</div>
      ) : null}

      {stats && stats.chunks > 0 ? (
        <div className="table-scroll"><table className="data-table">
          <thead>
            <tr>
              <th>الأنظمة</th>
              <th>المقاطع</th>
              <th>السارية</th>
              <th>المنسوخة</th>
              <th>ينتظر التضمين</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><bdi>{formatNumber(stats.laws)}</bdi></td>
              <td><bdi>{formatNumber(stats.chunks)}</bdi></td>
              <td><bdi>{formatNumber(stats.effective)}</bdi></td>
              <td><bdi>{formatNumber(stats.repealed)}</bdi></td>
              <td>
                <bdi>{formatNumber(stats.pending_embeddings)}</bdi>
                {/* الفهرس المتجهي غير مهيّأ: البحث اللفظي يعمل والدلاليّ لا.
                    تُقال هنا لأن رقماً معلَّقاً لا ينقص بلا سبب ظاهر يُقلق. */}
                {!stats.vectorize ? <span className="pill pending">الفهرس المتجهي غير مهيّأ</span> : null}
              </td>
            </tr>
          </tbody>
        </table></div>
      ) : null}
    </div>
  );
}
