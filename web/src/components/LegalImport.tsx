// استيراد المحتوى النظامي — عقد الاستيراد في docs/legal-import.md
//
// سطر واحد = مادة واحدة، ولا تُقطَّع المواد هنا ولا في الخادم. الشاشة لا
// تتحقّق من الأسطر بنفسها: التحقّق في الخادم وحده، ونسخُه هنا يخلق مصدرين
// للحقيقة يفترقان أوّل تعديل في العقد. مهمّتها إيصال الأسطر وعرض تقريرها.
//
// ولا أيقونة في متن هذه الشاشة: أيقونة «استيراد» (`Import`) على بطاقة مصدرها
// في «الإضافة» وحدها، فهي تفرّق المسار عن أخويه عند الاختيار. وتكرارُها هنا
// يعلو نموذجاً اختير سلفاً — والمختار لا يُعرَّف بنفسه ثانيةً.
// وما في المتن من أيقونات حالٍ لا فعل: شريطا الوقوف — انتهاء الجلسة و«لم يكتمل
// استيراد» — ولونُ الحال لا يُقال بلونه وحده.
import { useEffect, useRef, useState } from 'react';
import { api, SessionExpired, type LegalImportDiff, type LegalImportRecord, type LegalImportReport } from '../lib/api';
import { renewSessionInWindow } from '../lib/session';
import { ImportCompare } from './ImportCompare';
import { formatDate } from '../lib/format';
import { formatNumber } from '../lib/format';
import { Icon, ICON_SM } from '../lib/icons';
import { modalCardProps, useModalDismiss } from '../lib/modal';

/**
 * أسطر الدفعة الواحدة.
 *
 * التقسيم بالأسطر لا بالحجم: سطرٌ = مادة، وقصّ الملف بالبايت يشقّ سطراً في
 * منتصفه فتضيع مادة ويُرفض ما بعدها. والدفعات متتابعة لا متوازية، ليقف
 * استيراد الملف عند أوّل دفعة تُرفَض بدل أن تمضي بقيتها على الخطأ نفسه.
 *
 * وكانت خمسمئة، فملفٌّ بحجم ٥٥ م.ب يحتاج مئات الطلبات المتتابعة ويتجاوز عمرَ
 * رمز الدخول (ربع ساعة) حتماً. وألفان في حدود الخطة المدفوعة بسعة: الجزء يُجمع
 * بـ`stageChunks` على دفعات من ٢٥ عبارة، فهي قرابة ٨٥ استعلاماً للطلب من ألف.
 */
const BATCH_LINES = 2000;

/**
 * وسقفُ حجم الجزء — والقطع بين الأسطر لا في وسطها.
 *
 * الأسطر لا تتساوى: مادةٌ بنصّها الكامل وتضمينها قد تبلغ عشرات الكيلوبايت،
 * فألفا سطرٍ منها طلبٌ ثقيل يقترب من حدّ وقت المعالجة. فيُقفل الجزء عند أيّهما
 * أسبق: عدد الأسطر أو هذا الحجم. وسطرٌ وحده أكبر منه يُرسل جزءاً وحده.
 */
const BATCH_BYTES = 4 * 1024 * 1024;

/** حدود الأجزاء على الأسطر — ثابتة لملفٍّ بعينه، فالإكمال يجد الجزء نفسه. */
function splitParts(lines: string[]): { start: number; end: number }[] {
  const encoder = new TextEncoder();
  const parts: { start: number; end: number }[] = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < lines.length; i++) {
    const size = encoder.encode(lines[i]).length + 1;
    if (i > start && (i - start >= BATCH_LINES || bytes + size > BATCH_BYTES)) {
      parts.push({ start, end: i });
      start = i;
      bytes = 0;
    }
    bytes += size;
  }
  parts.push({ start, end: lines.length });
  return parts;
}

/* ============================================================
   استيرادٌ لم يكتمل — يُحفظ موضعه ليكمل من حيث وقف.

   الأجزاء المرفوعة محفوظةٌ في الخادم يوماً كاملاً (`STAGING_TTL_MS`)، والذي
   كان يضيع هو علمُ الشاشة بها: معرّفُ الدفعة وآخرُ جزءٍ وصل. فانتهاءُ الجلسة
   أو إغلاقُ التبويب أو انقطاعُ الشبكة كان يعيد الملف إلى أوّله — وملفٌّ يتجاوز
   عمرَ الرمز يتجاوزه ثانيةً، فيدور صاحبه في حلقة.

   فيُحفظ الموضع في تخزين المتصفّح بعد كلّ جزء، ويُعرض بعد العودة. والملف لا
   يُحفظ — يختاره صاحبه ثانيةً، وتُطابَق بصمتُه قبل أن يُكمَل عليه: جزءٌ من
   ملفٍّ آخر يُلحق بدفعةٍ ليست له فيُكتب نظامٌ من ملفّين.
   ============================================================ */

const PENDING_KEY = 'naf-legal:import-pending';

interface PendingImport {
  batchId: string;
  name: string;
  size: number;
  lastModified: number;
  sha256?: string;
  options: { buildEmbed: boolean; partial: boolean; correction: boolean };
  /** الأجزاء التي جُمعت في الخادم، من أصل `parts`. */
  partsDone: number;
  parts: number;
  /** `commit` — جُمع كلُّه وبدأت كتابتُه، وقرارُ الحذف فيه مأخوذ. */
  phase: 'staging' | 'commit';
  prune?: boolean;
  staged?: number;
  orphansKept?: number;
  totals: { built: number; skipped: number; withheld: number; amendmentPending: number; unstamped: number };
  summary: NonNullable<LegalImportReport['error_summary']>;
}

/* التخزين قد يُمنع — نافذةٌ خاصة أو بياناتٌ ممسوحة. وغيابه لا يوقف الاستيراد:
   يُفقد الإكمالُ وحده، كما كان قبله. */
function readPending(): PendingImport | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingImport) : null;
  } catch {
    return null;
  }
}

function savePending(record: PendingImport): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(record));
  } catch {
    // لا تخزين — لا إكمال، والاستيراد ماضٍ.
  }
}

function clearPending(): void {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // لا تخزين — لا شيء يُمسح.
  }
}

/**
 * هل هو الملف نفسه؟ بالبصمة إن حُسبت، وإلا بالاسم والحجم وتاريخ التعديل.
 * والبصمة على البايتات كما هي، فتغيّرُ حرفٍ واحد يجعله ملفاً آخر.
 */
async function sameFile(file: File, record: PendingImport): Promise<boolean> {
  if (record.sha256) return (await fileSha256(file)) === record.sha256;
  return file.name === record.name && file.size === record.size && file.lastModified === record.lastModified;
}

/** انقطاع الشبكة: `fetch` يرمي `TypeError` ولا يردّ شيئاً. */
function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError;
}

/** جملة انقطاع الاتصال — المسجَّلة، وهي في هذه الشاشة منذ قبل. */
const NETWORK_ERROR = 'تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة';

/** الجملة حين يُختار للإكمال ملفٌّ غير ملفّه — مسجَّلة تحت «ختامُ دفعة المواد». */
const RESUME_MISMATCH = 'الملف المختار غير الملف الذي انقطع استيراده';

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
  /** سجلاتٌ لم تمرّ بختم الحالة — تُعدّ ولا تُرفض. */
  unstamped?: number;
  /** حُذفت في ختام الدفعة لغيابها عن الملف. */
  deleted?: number;
  /** غابت عن الملف ولم يُعرض حذفها: تُخطّيت منه أسطر. */
  orphansKept?: number;
  report?: LegalImportReport;
}

/**
 * انقطع الرفع قبل اكتمال الملف — الجملة مسجَّلة في `naf-terms.md` تحت «ختامُ دفعة
 * المواد». والملف يُجمع جانباً حتى يكتمل، فانقطاعُه لا يترك في القاعدة أثراً.
 */
const STAGE_INTERRUPTED = 'انقطع رفع الملف قبل اكتماله، ولم يُكتب منه شيء — أعد رفعه';

/**
 * بصمة الملف كما يحسبها مُرسِله — على بايتاته كما هي، لا على أسطره بعد
 * التشذيب: بصمةٌ على نصٍّ غير نصّه لا تطابق بصمةَ المُرسِل أبداً.
 *
 * و`crypto.subtle` لا يوجد إلا في سياقٍ آمن. وغيابُه لا يوقف الاستيراد: البصمة
 * قيدٌ في السجلّ لا شرطٌ للكتابة.
 */
async function fileSha256(file: File): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined;
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** معرّف الدفعة: يجمع أجزاء الملف الواحد، وعليه تُؤخذ الصور ويُقاس الغائب. */
function newBatchId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * سؤال ختام الدفعة — الحذف سؤالٌ لا أثرٌ جانبيّ.
 *
 * الغائبُ عن الملف يُعرض بعدده ويُحذف بزرٍّ يحمل اسمَ الفعل. واسمُ الملف في
 * العنوان: الاختيار قد يحمل ملفات عدّة، والسؤال عن أحدها بعينه.
 */
function FinalizeConfirm({
  filename,
  count,
  onApply,
  onCancel,
}: {
  filename: string;
  count: number;
  onApply: () => void;
  onCancel: () => void;
}) {
  useModalDismiss(onCancel);
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card confirm-card" {...modalCardProps}>
        <div className="modal-head">
          <span className="modal-title">
            حذف ما غاب عن الملف — <bdi>{filename}</bdi>
          </span>
          <button className="modal-close" onClick={onCancel} title="إغلاق" aria-label="إغلاق">
            <Icon.close size={ICON_SM} aria-hidden />
          </button>
        </div>
        <div className="modal-body confirm-body">
          <p>
            <bdi>{formatNumber(count)}</bdi> مادةً في القاعدة من أنظمة هذا الملف لم ترد فيه. تُحذف مع متجهاتها،
            ويبقى نصُّها في سجل التحديث.
          </p>
        </div>
        <div className="modal-foot">
          <button className="btn-sm" onClick={onCancel}>إلغاء</button>
          <button className="btn-sm" onClick={onApply}>حذف</button>
        </div>
      </div>
    </div>
  );
}

export function LegalImport() {
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState<{ name: string; file: number; files: number; batch: number; batches: number } | null>(null);
  const [results, setResults] = useState<FileResult[]>([]);
  /* «بناء نصّ التضمين» مفعَّلٌ افتراضياً، و«استيراد ما صحّ» معطَّل.

     الأوّل تسهيلٌ في قراءة الملف، وأثرُه مقروءٌ في عمود «نصّ تضمين مبنيّ».
     والثاني يخالف الوثيقة إن كان افتراضاً: «الدفعة تنجح كاملة أو تُلغى كاملة»
     (§4-٦، §8 الخطوة ٩) — فالشاشة صارمةٌ كالمسار والسكربت، والجزئيّ يُطلب
     بنقرة يعرف صاحبها أن ما رُفض لن يُكتب، ويُقال بسببه وسطره. */
  const [buildEmbed, setBuildEmbed] = useState(true);
  const [partial, setPartial] = useState(false);
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
  // وسؤالُ الختام يوقفها بالطريقة نفسها: الملف التالي لا يبدأ قبل الجواب.
  const [orphans, setOrphans] = useState<
    { filename: string; count: number; decide: (apply: boolean) => void } | null
  >(null);
  const input = useRef<HTMLInputElement>(null);
  /* انتهت الجلسة في منتصف الاستيراد: الحلقة واقفةٌ على وعدٍ يُحلّه تجديدُها.
     و`part` من `parts` موضعُ الوقوف في جمع الأجزاء — صفرٌ خارجه. */
  const [held, setHeld] = useState<{ login: string; part: number; parts: number; resume: () => void } | null>(null);
  // استيرادٌ لم يكتمل من قبل — يُعرض ليُختار ملفُّه ثانيةً.
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(readPending);
  const [resumeError, setResumeError] = useState(false);
  const resumeInput = useRef<HTMLInputElement>(null);

  /**
   * يُنفّذ النداء، فإن انتهت الجلسة وقف حتى تتجدّد ثم أعاده كما هو.
   *
   * الجزء الذي ردّه ٤٠١ لم يبلغ الخادمَ أصلاً — الوسيط ردّه قبله — فإعادتُه
   * إرسالُه أوّلَ مرّة لا ثانيتَها.
   */
  const withSession = async <T,>(call: () => Promise<T>, where = { part: 0, parts: 0 }): Promise<T> => {
    for (;;) {
      try {
        return await call();
      } catch (e) {
        if (!(e instanceof SessionExpired)) throw e;
        await new Promise<void>((resume) => setHeld({ login: e.login, ...where, resume }));
        setHeld(null);
      }
    }
  };

  /* سجلّ الاستيراد وحده يُقرأ هنا: حالُ المتن وحالُ الفهرس وزرُّ «تضمين الآن»
     انتقلت إلى شريط حال قاعدة المعرفة وقسم «المحتوى». وكانت هذه الشاشة تعرض
     أعدادَ الشريط نفسها في آخرها، فيُقرأ العدد الواحد في موضعين ويُصدَّق
     أحدثُهما — وحالُ الفهرس لا يبلغ من لا يفتح الاستيراد أصلاً. */
  const loadHistory = () => {
    api.legalImports().then((r) => setHistory(r.imports)).catch(() => {});
  };
  useEffect(loadHistory, []);

  /**
   * يستورد ملفاً واحداً — من أوّله، أو من موضعٍ محفوظ إن جاء `resume`.
   *
   * وحدة «الكل أو لا شيء» هي الملف لا الاختيار كلّه: نظامٌ نصفه مستورد أسوأ
   * من نظام لم يُستورَد، أما نظامٌ سليم بجانب نظامٍ مرفوض فلا ضرر فيه. فيمضي
   * الاستيراد إلى الملف التالي ويُذكر لكلٍّ حالُه.
   */
  const importFile = async (file: File, index: number, count: number, resume?: PendingImport): Promise<FileResult> => {
    const text = await file.text();
    const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
    if (!lines.length) {
      return { name: file.name, ok: false, inserted: 0, updated: 0, report: { ok: false, error: 'لا سطور في الملف' } };
    }
    const parts = splitParts(lines);
    const options = resume?.options ?? { buildEmbed, partial, correction };

    let record: PendingImport;
    if (resume) {
      // المقارنة وقرارها وقعا قبل الانقطاع، فلا يُسأل عنهما ثانيةً.
      record = resume;
    } else {
      /* مقارنةٌ قبل الكتابة، بالملف كاملاً لا مقطّعاً: «الغائب عن الملف»
         يُحسب على مستوى النظام، ودفعةٌ من ألفي سطر تجعل سائره غائباً.
         وإن رُفض الملف في المقارنة لم نسأل شيئاً: الاستيراد التالي يردّ
         التقرير نفسه، ورسالةُ الرفض تُقال مرّة لا مرّتين. */
      setNow({ name: file.name, file: index + 1, files: count, batch: 0, batches: 0 });
      const preview = await withSession(() =>
        api.importLegal(lines, file.name, { buildEmbed: options.buildEmbed, partial: options.partial, dryRun: true })
      );
      /* والوضعُ الصارم صارمٌ على الملف كلِّه لا على جزئه (§4-٦): المقارنة قرأت
         الأسطر كلَّها، فإن رُفض منها سطرٌ لم يُكتب شيء. وكان الجزءُ الذي يحمله
         يُرفض وما قبله مكتوب — نظامٌ نصفُه مستورد، وهو ما وُضع الصارم لمنعه.
         وأرقامُ الأسطر هنا من الملف كاملاً، فلا تُزاح. */
      if (!options.partial && preview.ok && (preview.failed ?? 0) > 0) {
        return {
          name: file.name, ok: false, inserted: 0, updated: 0,
          report: { ...preview, ok: false, error: 'أسطر غير صالحة — لم يُكتب شيء' },
        };
      }
      const diff = preview.ok ? preview.diff : undefined;
      if (diff && (diff.changed > 0 || diff.unchanged > 0)) {
        const apply = await new Promise<boolean>((decide) => setConflict({ filename: file.name, diff, decide }));
        setConflict(null);
        if (!apply) {
          return { name: file.name, ok: true, cancelled: true, inserted: 0, updated: 0 };
        }
      }

      /* معرّفٌ واحد لأجزاء الملف كلّها، وبصمتُه معها. بهما يُجمع الملف جانباً، ويُقرأ
         في السجلّ سطراً واحداً، وتُؤخذ صورُ ما يُكتب فوقه. ويُحفظ الموضع قبل أوّل
         جزء: انقطاعٌ فيه يُكمَل من الجزء الأوّل بلا مقارنةٍ ثانية. */
      record = {
        batchId: newBatchId(),
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        sha256: await fileSha256(file),
        options,
        partsDone: 0,
        parts: parts.length,
        phase: 'staging',
        totals: { built: 0, skipped: 0, withheld: 0, amendmentPending: 0, unstamped: 0 },
        summary: [],
      };
      savePending(record);
    }
    const { batchId, sha256, totals, summary } = record;

    /* ١) الأجزاء تُجمع جانباً ولا يمسّ القاعدةَ منها شيء حتى يكتمل الملف (§4-٦).
       فرفضٌ هنا لا يترك أثراً: يُلغى ما جُمع، ويُقال إن شيئاً لم يُكتب. وانقطاعُ
       الشبكة لا يُلغي: ما جُمع يبقى في الخادم، والموضع محفوظ ليكمل منه. */
    if (record.phase === 'staging') {
      try {
        for (let p = record.partsDone; p < parts.length; p++) {
          const { start, end } = parts[p];
          setNow({ name: file.name, file: index + 1, files: count, batch: p + 1, batches: parts.length });
          const part = await withSession(
            () =>
              api.importLegal(lines.slice(start, end), file.name, {
                ...options, batch: batchId, sha256, stage: true,
              }),
            { part: p + 1, parts: parts.length }
          );
          if (!part.ok) {
            await api.legalAbort(batchId).catch(() => {});
            clearPending();
            // أرقام الأسطر تُردّ إلى مواضعها في الملف الأصلي: رقمٌ داخل جزءٍ لا
            // يدلّ صاحبَ الملف على شيء.
            return {
              name: file.name,
              ok: false,
              inserted: 0,
              updated: 0,
              report: {
                ...part,
                errors: (part.errors ?? []).map((e) => ({ ...e, line: start + e.line })),
                error_summary: (part.error_summary ?? []).map((g) => ({ ...g, lines: g.lines.map((l) => start + l) })),
              },
            };
          }
          totals.built += part.embed_text_built ?? 0;
          totals.withheld += part.needs_review ?? 0;
          totals.amendmentPending += part.amendment_pending ?? 0;
          totals.unstamped += part.unstamped ?? 0;
          // في وضع «ما صحّ»: الجزء يُقبل ومعه أسطرٌ متخطّاة. تُجمع أسبابها ليُقال ما
          // فات، فتخطٍّ صامت يجعل نظاماً ناقصاً يبدو تامّاً.
          if (part.failed) {
            totals.skipped += part.failed;
            summary.push(...(part.error_summary ?? []).map((g) => ({ ...g, lines: g.lines.map((l) => start + l) })));
          }
          record.partsDone = p + 1;
          savePending(record);
        }
      } catch (e) {
        if (isNetworkError(e)) {
          return { name: file.name, ok: false, inserted: 0, updated: 0, report: { ok: false, error: NETWORK_ERROR } };
        }
        await api.legalAbort(batchId).catch(() => {});
        clearPending();
        return { name: file.name, ok: false, inserted: 0, updated: 0, report: { ok: false, error: STAGE_INTERRUPTED } };
      }
    }

    try {
      /* ٢) ما سيقع، ومنه سؤالُ الحذف قبل الكتابة (§8) — والحذفُ يقع مع كل نظامٍ وهو
         مجمَّد، فلا يُقرأ نظامٌ حُذف بعضُه. ولا يُعرض على ملفٍّ تُخطّيت منه أسطر:
         السطر المتخطّى غائبٌ عن الملف وحاضرٌ في القاعدة، وتُقال الجملة التي تقول لماذا.
         ويُسأل مرّةً: الإكمالُ بعد بدء الكتابة يحمل الجواب في الموضع المحفوظ. */
      if (record.phase === 'staging') {
        const plan = await withSession(() => api.legalCommit(batchId));
        let prune = false;
        let orphansKept = 0;
        if (plan.orphans > 0 && plan.failed > 0) {
          orphansKept = plan.orphans;
        } else if (plan.orphans > 0) {
          prune = await new Promise<boolean>((decide) => setOrphans({ filename: file.name, count: plan.orphans, decide }));
          setOrphans(null);
        }
        record.phase = 'commit';
        record.prune = prune;
        record.staged = plan.staged;
        record.orphansKept = orphansKept;
        savePending(record);
      }
      const prune = record.prune ?? false;
      const staged = record.staged ?? 0;

      /* ٣) الكتابةُ خطوةً خطوة حتى تتمّ: نظاماً نظاماً، وكلُّ نظامٍ يغيب عن البحث وهو
         يُكتب ويعود كاملاً. وما تعذّر يُردّ في الخادم كلُّه ويرمي بجملته. */
      let progress = await withSession(() => api.legalCommit(batchId, { apply: true, prune }));
      while (!progress.done) {
        setNow({ name: file.name, file: index + 1, files: count, batch: staged - progress.remaining, batches: staged });
        progress = await withSession(() => api.legalCommit(batchId, { apply: true, prune }));
      }
      clearPending();
      return {
        name: file.name, ok: true,
        inserted: progress.inserted, updated: progress.updated, archived: progress.archived, deleted: progress.deleted,
        ...totals, orphansKept: record.orphansKept ?? 0,
        report: totals.skipped ? { ok: true, error_summary: summary } : undefined,
      };
    } catch (e: any) {
      /* انقطعت الشبكة: الموضع محفوظ، والإكمالُ يعيد الخطوة نفسها. وإن طال الانقطاع
         على دفعةٍ بدأت كتابتُها ردّها المؤقّت، والإكمالُ يقول ذلك بجملة الخادم. */
      if (isNetworkError(e)) {
        return { name: file.name, ok: false, inserted: 0, updated: 0, report: { ok: false, error: NETWORK_ERROR } };
      }
      /* الخادم ردّ ما كتب وقال جملته. وإن تعذّر الإلغاء فالمؤقّت يردّه بعد دقائق —
         ولا يُقال «أُعيدت» عن ردٍّ لم يتحقّق. */
      const aborted = await api.legalAbort(batchId).then(() => true).catch(() => false);
      clearPending();
      const error = e instanceof Error && e.message ? e.message : aborted ? STAGE_INTERRUPTED : NETWORK_ERROR;
      return { name: file.name, ok: false, inserted: 0, updated: 0, report: { ok: false, error } };
    }
  };

  /**
   * إكمالُ استيرادٍ لم يكتمل، على ملفٍّ اختاره صاحبه ثانيةً.
   *
   * يُطابَق قبل أن يُمسّ شيء: جزءٌ من ملفٍّ آخر يُلحق بدفعةٍ ليست له.
   */
  const resumeWith = async (file: File) => {
    const record = readPending();
    if (!record) return;
    setBusy(true);
    setResults([]);
    try {
      if (!(await sameFile(file, record))) {
        setResumeError(true);
        return;
      }
      setResumeError(false);
      try {
        setResults([await importFile(file, 0, 1, record)]);
      } catch (e: any) {
        setResults([{ name: file.name, ok: false, inserted: 0, updated: 0, report: { ok: false, error: e?.message ?? NETWORK_ERROR } }]);
      }
    } finally {
      setBusy(false);
      setNow(null);
      setPendingImport(readPending());
      loadHistory();
    }
  };

  /** تركُ الاستيراد الذي لم يكتمل: ما جُمع منه في الخادم يُسقط، والموضع يُمسح. */
  const discardPending = async () => {
    const record = readPending();
    if (record) await api.legalAbort(record.batchId).catch(() => {});
    clearPending();
    setPendingImport(null);
    setResumeError(false);
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
          /* ملفٌّ له استيرادٌ لم يكتمل يُكمَل ولا يُعاد من أوّله — ولو اختير من
             منطقة الإفلات لا من زرّ الإكمال. وغيرُه يبدأ دفعةً جديدة، فما جُمع
             للقديم يُسقط: موضعٌ واحد يُحفظ، والدفعة التي لا موضع لها لا تُكمَل. */
          const record = readPending();
          const resume = record && (await sameFile(chosen[i], record)) ? record : undefined;
          if (record && !resume) {
            await api.legalAbort(record.batchId).catch(() => {});
            clearPending();
          }
          done.push(await importFile(chosen[i], i, chosen.length, resume));
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
        // انقطعت الشبكة وبقي موضعُ هذا الملف محفوظاً: الملف التالي يمحوه، فيُوقف هنا.
        if (readPending()) break;
      }
    } finally {
      setBusy(false);
      setNow(null);
      setPendingImport(readPending());
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

      {orphans ? (
        <FinalizeConfirm
          filename={orphans.filename}
          count={orphans.count}
          onApply={() => orphans.decide(true)}
          onCancel={() => orphans.decide(false)}
        />
      ) : null}

      {/* الجلسة انتهت والاستيراد واقف: الضغطة تفتح الباب في نافذةٍ جانبية — والضغطةُ
          شرطُها، فالمتصفّح يحجب نافذةً لم تسبقها — وعودتُها تُكمل الحلقة. وخارج جمع
          الأجزاء لا موضعَ يُسمّى، فتُقال جملةُ انتهاء الجلسة المسجّلة وحدها. */}
      {held ? (
        <div className="import-held" role="alert">
          <Icon.failed size={ICON_SM} aria-hidden />
          <span>
            {held.parts ? (
              <>
                انتهت جلسة دخولك، والاستيراد متوقف عند الجزء <bdi>{formatNumber(held.part)}</bdi> من{' '}
                <bdi>{formatNumber(held.parts)}</bdi>. سجّل الدخول ويكمل من حيث توقف.
              </>
            ) : (
              'انتهت جلسة دخولك. سجّل الدخول من جديد'
            )}
          </span>
          <button className="btn-sm" onClick={() => renewSessionInWindow(held.login).then(held.resume)}>
            تسجيل الدخول
          </button>
        </div>
      ) : null}

      {/* استيرادٌ سابق لم يكتمل — والملف يُختار ثانيةً، فالمتصفّح لا يحفظ ملفاً. */}
      {!busy && pendingImport ? (
        <div className="import-held" role="status">
          <Icon.importPaused size={ICON_SM} aria-hidden />
          <span>
            لم يكتمل استيراد <bdi>{pendingImport.name}</bdi>: رُفع <bdi>{formatNumber(pendingImport.partsDone)}</bdi> من{' '}
            <bdi>{formatNumber(pendingImport.parts)}</bdi> جزءاً. اختر الملف نفسه ليكمل من حيث توقف.
          </span>
          <button className="btn-sm" onClick={() => resumeInput.current?.click()}>إكمال الاستيراد</button>
          <button className="btn-sm" onClick={discardPending}>إلغاء</button>
          {resumeError ? <span className="import-held-error">{RESUME_MISMATCH}</span> : null}
        </div>
      ) : null}

      <input
        ref={resumeInput}
        type="file"
        hidden
        accept=".jsonl,.ndjson"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) resumeWith(file);
          e.target.value = '';
        }}
      />

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
                  <th>مواد محذوفة</th>
                  <th>نصّ تضمين مبنيّ</th>
                  <th>أسطر متخطّاة</th>
                  <th>نسخ مؤرشفة</th>
                  {/* ما حُجب وما سيُعرض بتنبيه: ملفٌّ نصفُ مواده محجوب يبدو
                      مستورَداً تامّاً في العمود، ثم لا يجد المحامي أثره في
                      البحث ولا يعرف لماذا. */}
                  <th>بانتظار المراجعة</th>
                  <th>تعديل غير مطبَّق</th>
                  <th>بلا ختم الحالة</th>
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
                    <td><bdi>{formatNumber(r.deleted ?? 0)}</bdi></td>
                    <td><bdi>{formatNumber(r.built ?? 0)}</bdi></td>
                    <td><bdi>{formatNumber(r.skipped ?? 0)}</bdi></td>
                    <td><bdi>{formatNumber(r.archived ?? 0)}</bdi></td>
                    <td><bdi>{formatNumber(r.withheld ?? 0)}</bdi></td>
                    <td><bdi>{formatNumber(r.amendmentPending ?? 0)}</bdi></td>
                    <td><bdi>{formatNumber(r.unstamped ?? 0)}</bdi></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ما يُقال عن الملف بعد الأعداد: الختمُ الفائت يُعدّ ولا يُرفض، والجملة
              تقول ما يعنيه العدد. والحذفُ الذي لم يُعرض يقول لماذا لم يُعرض —
              ويُقال حين يوجد غائبٌ فعلاً، فتنبيهٌ عن خطرٍ غير قائم يُعلّم
              القارئ تجاهل التنبيهات. */}
          {results.map((r, i) =>
            r.unstamped || r.orphansKept ? (
              <div key={i} className="import-report">
                {r.unstamped ? (
                  <p>
                    <bdi>{r.name}</bdi>: سجلاتٌ لم تمرّ بختم الحالة — مادةٌ من نظامٍ لاغٍ قد تصل منها نافذة
                  </p>
                ) : null}
                {r.orphansKept ? (
                  <p>
                    <bdi>{r.name}</bdi>: لم يُعرض حذف ما غاب عن الملف: تُخطّيت منه أسطر، والغائب قد يكون ما تُخطّي
                  </p>
                ) : null}
              </div>
            ) : null
          )}

          {withCauses.map((r, i) => (
            <div key={i} className="import-report">
              <p>
                <bdi>{r.name}</bdi>:{' '}
                {r.ok ? 'أسطر تُخطّيت' : (r.report?.error ?? 'أسطر غير صالحة — لم يُكتب شيء')}
              </p>
              {/* «وما استُورد قبلها محفوظ» تُقال حين يكون قبلها شيء فعلاً. وقولها
                  مع صفر يُقلق بلا سبب: يوهم أن شيئاً كُتب ثم ضاع. ولا تُقال
                  لاستيرادٍ جزئيّ لم يُرفض: «قبل الرفض» عن ملفٍّ لم يُرفض خبرٌ كاذب. */}
              {!r.ok && r.inserted + r.updated > 0 ? (
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
                  <th>مواد محذوفة</th>
                  <th>أسطر متخطّاة</th>
                  {/* بها يُعرف أيُّ ملفٍ أنتج ما في القاعدة، وتُطابَق ببصمة المُرسِل. */}
                  <th>بصمة الملف</th>
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
                    <td><bdi>{formatNumber(h.deleted ?? 0)}</bdi></td>
                    <td><bdi>{formatNumber(h.failed)}</bdi></td>
                    {/* البصمة تُقصّ في الجدول ولا تمدّه، وكاملُها في النصّ نفسه
                        يُنسخ ويُقرأ عند المرور. والخانة يسارية الاتجاه: القصّ
                        يقع في آخر ما يُقرأ، فيبقى أوّلُ البصمة ظاهراً — وبه
                        تُقابَل. */}
                    <td className="audit-value" dir="ltr" title={h.file_sha256 ?? undefined}>
                      {h.file_sha256 ?? '—'}
                    </td>
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
