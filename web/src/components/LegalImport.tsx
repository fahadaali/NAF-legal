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
 * الاستيراد عند أوّل دفعة تُرفَض بدل أن تمضي بقيتها على الخطأ نفسه.
 */
const BATCH_LINES = 500;

export function LegalImport() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<LegalImportReport | null>(null);
  const [written, setWritten] = useState<{ inserted: number; updated: number } | null>(null);
  const [stats, setStats] = useState<LegalStats | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const loadStats = () => {
    api.legalStats().then(setStats).catch(() => {});
  };
  useEffect(loadStats, []);

  const run = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setReport(null);
    setWritten(null);
    try {
      const text = await file.text();
      const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
      if (!lines.length) {
        setReport({ ok: false, error: 'لا سطور في الملف' });
        return;
      }

      const total = Math.ceil(lines.length / BATCH_LINES);
      let inserted = 0;
      let updated = 0;

      for (let start = 0; start < lines.length; start += BATCH_LINES) {
        setProgress({ done: Math.floor(start / BATCH_LINES), total });
        const batch = await api.importLegal(lines.slice(start, start + BATCH_LINES), file.name);
        if (!batch.ok) {
          // أرقام الأسطر تُردّ إلى مواضعها في الملف الأصلي: رقمٌ داخل دفعة
          // لا يدلّ صاحبَ الملف على شيء.
          setReport({
            ...batch,
            errors: (batch.errors ?? []).map((e) => ({ ...e, line: start + e.line })),
          });
          setWritten({ inserted, updated });
          return;
        }
        inserted += batch.inserted ?? 0;
        updated += batch.updated ?? 0;
        setReport(batch);
      }
      setWritten({ inserted, updated });
    } catch (e: any) {
      setReport({ ok: false, error: e?.message ?? 'تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة' });
    } finally {
      setBusy(false);
      setProgress(null);
      loadStats();
    }
  };

  const rejected = report && !report.ok;

  return (
    <div>
      <input
        ref={input}
        type="file"
        hidden
        accept=".jsonl,.ndjson"
        onChange={(e) => {
          run(e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      <div className="dropzone" onClick={() => !busy && input.current?.click()}>
        {busy ? (
          <>
            <span className="spinner" /> جارٍ الاستيراد
            {progress && progress.total > 1 ? (
              <>
                {' '}
                <bdi>{formatNumber(progress.done + 1)}</bdi> / <bdi>{formatNumber(progress.total)}</bdi>
              </>
            ) : null}
          </>
        ) : (
          <>اختر ملف JSONL — سطر مستقل لكل مادة، يُستورَد كما هو ولا يُعاد تقطيعه</>
        )}
      </div>

      {report && (
        <div className="import-report">
          <span className={`pill ${rejected ? 'error' : 'ready'}`}>{rejected ? 'الملف مرفوض' : 'تم الاستيراد'}</span>
          {report.error ? <p>{report.error}</p> : null}
          {(report.warnings ?? []).map((w, i) => (
            <p key={i}>{w}</p>
          ))}

          {written && (written.inserted > 0 || written.updated > 0) ? (
            <div className="table-scroll"><table className="data-table">
              <thead>
                <tr>
                  <th>مواد جديدة</th>
                  <th>مواد مستبدَلة</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  {/* ما فعلته هذه الدفعة وحدها. وحالُ المحتوى كلِّه — ومنه
                      ما ينتظر التضمين — في جدول الحال أدناه، فلا يُعاد رقمٌ
                      واحد في موضعين برقمين مختلفين. */}
                  <td><bdi>{formatNumber(written.inserted)}</bdi></td>
                  <td><bdi>{formatNumber(written.updated)}</bdi></td>
                </tr>
              </tbody>
            </table></div>
          ) : null}

          {/* «وما استُورد قبلها محفوظ» تُقال حين يكون قبلها شيء فعلاً. وقولها
              مع صفر يُقلق بلا سبب: يوهم أن شيئاً كُتب ثم ضاع. */}
          {rejected && written && written.inserted + written.updated > 0 ? (
            <p>
              الأسطر المرفوضة لم يُكتب منها شيء. وما استُورد قبلها محفوظ:{' '}
              <bdi>{formatNumber(written.inserted + written.updated)}</bdi> مادة.
            </p>
          ) : null}

          {report.errors?.length ? (
            <div className="table-scroll"><table className="data-table">
              <thead>
                <tr>
                  <th>السطر</th>
                  <th>السبب</th>
                </tr>
              </thead>
              <tbody>
                {report.errors.map((e, i) => (
                  <tr key={i}>
                    <td><bdi>{formatNumber(e.line)}</bdi></td>
                    <td>{e.error}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : null}

          {report.errors_truncated ? (
            <p>
              وأخطاء أخرى لم تُعرَض: <bdi>{formatNumber(report.errors_truncated)}</bdi>
            </p>
          ) : null}
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
