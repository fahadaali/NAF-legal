// استيراد المحتوى النظامي — عقد الاستيراد في docs/legal-import.md
//
// سطر واحد = مادة واحدة، ولا تُقطَّع المواد هنا ولا في الخادم. الشاشة لا
// تتحقّق من الأسطر بنفسها: التحقّق في الخادم وحده، ونسخُه هنا يخلق مصدرين
// للحقيقة يفترقان أوّل تعديل في العقد. مهمّتها إيصال الأسطر وعرض تقريرها.
//
// ولا أيقونة في متن هذه الشاشة: أيقونة «استيراد» (`Import`) على بطاقة مصدرها
// في «الإضافة» وحدها، فهي تفرّق المسار عن أخويه عند الاختيار. وتكرارُها هنا
// يعلو نموذجاً اختير سلفاً — والمختار لا يُعرَّف بنفسه ثانيةً.
import { useEffect, useRef, useState } from 'react';
import { api, type LegalImportDiff, type LegalImportRecord, type LegalImportReport } from '../lib/api';
import { ImportCompare } from './ImportCompare';
import { formatDate } from '../lib/format';
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
  /** أُرشِفت نسخُها القديمة قبل الكتابة فوقها. */
  archived?: number;
  /** ستُحجب عن الاسترجاع حتى تُراجَع بشرياً. */
  withheld?: number;
  /** عُدِّلت ونصُّها المعروض أصليّ — تُعرض مع تنبيهها. */
  amendmentPending?: number;
  /** أوقفه المستورِد بعد المقارنة. */
  cancelled?: boolean;
  report?: LegalImportReport;
}

export function LegalImport() {
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState<{ name: string; file: number; files: number; batch: number; batches: number } | null>(null);
  const [results, setResults] = useState<FileResult[]>([]);
  /* الخياران مفعَّلان افتراضياً في الشاشة، ويُنزَعان بنقرة.
     
     والمقصد أن يمضي إدخال الأنظمة بلا وقوفٍ عند كل خانةٍ تختلف. وما يفعله
     كلٌّ منهما يبقى **مقروءاً في التقرير**: عمود «نصّ تضمين مبنيّ» وعمود
     «أسطر متخطّاة» وحالة «استيراد جزئي» بشارة تحذير. فالافتراض تسهيلٌ لا
     إخفاء، ولا يمرّ شيء صامتاً.
     
     وهذا في الشاشة وحدها: `/api/legal/import` يبقى صارماً افتراضياً، فلا
     تتغيّر معه أتمتةٌ ولا سكربتٌ قائم بتغيير الشاشة. */
  const [buildEmbed, setBuildEmbed] = useState(true);
  const [partial, setPartial] = useState(true);
  /* «تصحيح بيانات» معطَّلٌ افتراضياً بخلاف أختيه: هذان تسهيلان في قراءة
     الملف، وهذا **إقرارٌ على ما وقع** — أن الفرق الذي سيظهر خطأُ سحبٍ سابق
     لا تعديلٌ نظاميّ. ووسمُه بلا قصدٍ يُفقد سجلَّ التحديث معناه، فلا يقع إلا
     بنقرةٍ يعرف صاحبها ما يقول. */
  const [correction, setCorrection] = useState(false);
  const [history, setHistory] = useState<LegalImportRecord[]>([]);
  /* نافذة إعادة الرفع تُوقف الحلقة حتى يقرّر المستورِد. والوعد هو ما يوقفها:
     الحلقة تنتظر جوابه، والنافذة هي التي تُحلّه. */
  const [conflict, setConflict] = useState<
    { filename: string; diff: LegalImportDiff; decide: (apply: boolean) => void } | null
  >(null);
  const input = useRef<HTMLInputElement>(null);

  /* سجلّ الاستيراد وحده يُقرأ هنا: حالُ المتن وحالُ الفهرس وزرُّ «تضمين الآن»
     انتقلت إلى شريط حال قاعدة المعرفة وقسم «المحتوى». وكانت هذه الشاشة تعرض
     أعدادَ الشريط نفسها في آخرها، فيُقرأ العدد الواحد في موضعين ويُصدَّق
     أحدثُهما — وحالُ الفهرس لا يبلغ من لا يفتح الاستيراد أصلاً. */
  const loadHistory = () => {
    api.legalImports().then((r) => setHistory(r.imports)).catch(() => {});
  };
  useEffect(loadHistory, []);

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

    /* مقارنةٌ قبل الكتابة، بالملف كاملاً لا مقطّعاً: «الغائب عن الملف»
       يُحسب على مستوى النظام، ودفعةٌ من خمسمئة سطر تجعل سائره غائباً.
       وإن رُفض الملف في المقارنة لم نسأل شيئاً: الاستيراد التالي يردّ
       التقرير نفسه، ورسالةُ الرفض تُقال مرّة لا مرّتين. */
    setNow({ name: file.name, file: index + 1, files: count, batch: 0, batches: 0 });
    const preview = await api.importLegal(lines, file.name, { buildEmbed, partial, dryRun: true });
    const diff = preview.ok ? preview.diff : undefined;
    if (diff && (diff.changed > 0 || diff.unchanged > 0)) {
      const apply = await new Promise<boolean>((decide) => setConflict({ filename: file.name, diff, decide }));
      setConflict(null);
      if (!apply) {
        return { name: file.name, ok: true, cancelled: true, inserted: 0, updated: 0 };
      }
    }

    const batches = Math.ceil(lines.length / BATCH_LINES);
    let inserted = 0;
    let updated = 0;
    let built = 0;
    let skipped = 0;
    let archived = 0;
    let withheld = 0;
    let amendmentPending = 0;
    const summary: NonNullable<LegalImportReport['error_summary']> = [];

    for (let start = 0; start < lines.length; start += BATCH_LINES) {
      setNow({ name: file.name, file: index + 1, files: count, batch: Math.floor(start / BATCH_LINES) + 1, batches });
      const batch = await api.importLegal(lines.slice(start, start + BATCH_LINES), file.name, { buildEmbed, partial, correction });
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
      archived += batch.archived ?? 0;
      withheld += batch.needs_review ?? 0;
      amendmentPending += batch.amendment_pending ?? 0;
      // في وضع «ما صحّ»: الدفعة تنجح ومعها أسطرٌ متخطّاة. تُجمع أسبابها
      // ليُقال ما فات، فتخطٍّ صامت يجعل نظاماً ناقصاً يبدو تامّاً.
      if (batch.failed) {
        skipped += batch.failed;
        summary.push(...(batch.error_summary ?? []).map((g) => ({ ...g, lines: g.lines.map((l) => start + l) })));
      }
    }
    return {
      name: file.name, ok: true, inserted, updated, built, skipped, archived, withheld, amendmentPending,
      report: skipped ? { ok: true, error_summary: summary } : undefined,
    };
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
      loadHistory();
    }
  };

  // المرفوض والمُستورَد جزئياً كلاهما يحتاج جدول أسباب.
  const withCauses = results.filter((r) => r.report?.error_summary?.length || !r.ok);

  return (
    <div>
      {conflict ? (
        <ImportCompare
          filename={conflict.filename}
          diff={conflict.diff}
          onApply={() => conflict.decide(true)}
          onCancel={() => conflict.decide(false)}
        />
      ) : null}

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
      <label className="import-option">
        <input type="checkbox" checked={correction} disabled={busy} onChange={(e) => setCorrection(e.target.checked)} />
        تصحيح بيانات — الفرق عن الاستيراد السابق خطأُ سحبٍ لا تعديلٌ نظاميّ
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
          // السطر الشارح على بطاقة المصدر فوقها، فلا يُعاد هنا: منطقة الإفلات
          // تقول ما يُختار لا ما يقع به.
          <>اختر ملفات JSONL</>
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
                  <th>نسخ مؤرشفة</th>
                  {/* ما حُجب وما سيُعرض بتنبيه: ملفٌّ نصفُ مواده محجوب يبدو
                      مستورَداً تامّاً في العمود، ثم لا يجد المحامي أثره في
                      البحث ولا يعرف لماذا. */}
                  <th>بانتظار المراجعة</th>
                  <th>تعديل غير مطبَّق</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i}>
                    <td><bdi>{r.name}</bdi></td>
                    <td>
                      <span className={`pill ${!r.ok ? 'error' : r.cancelled ? 'pending' : r.skipped ? 'warn' : 'ready'}`}>
                        {!r.ok ? 'الملف مرفوض' : r.cancelled ? 'أُلغي' : r.skipped ? 'استيراد جزئي' : 'تم الاستيراد'}
                      </span>
                    </td>
                    <td><bdi>{formatNumber(r.inserted)}</bdi></td>
                    <td><bdi>{formatNumber(r.updated)}</bdi></td>
                    <td><bdi>{formatNumber(r.built ?? 0)}</bdi></td>
                    <td><bdi>{formatNumber(r.skipped ?? 0)}</bdi></td>
                    <td><bdi>{formatNumber(r.archived ?? 0)}</bdi></td>
                    <td><bdi>{formatNumber(r.withheld ?? 0)}</bdi></td>
                    <td><bdi>{formatNumber(r.amendmentPending ?? 0)}</bdi></td>
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

      {history.length > 0 && (
        <>
          <div className="kb-section">سجل الاستيراد</div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>الملف</th>
                  <th>التاريخ</th>
                  <th>مواد جديدة</th>
                  <th>مواد مستبدَلة</th>
                  <th>أسطر متخطّاة</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>
                      <bdi>{h.filename ?? '—'}</bdi>
                      {h.kind === 'correction' ? <span className="pill pending">تصحيح بيانات</span> : null}
                    </td>
                    <td><bdi>{formatDate(h.created_at)}</bdi></td>
                    <td><bdi>{formatNumber(h.inserted)}</bdi></td>
                    <td><bdi>{formatNumber(h.updated)}</bdi></td>
                    <td><bdi>{formatNumber(h.failed)}</bdi></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

    </div>
  );
}
