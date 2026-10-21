// استخراجُ نصّ المرفق بعد رفعه — في منفّذٍ بالخلفية، أو في الطلب نفسه حين لا منفّذ.
//
// كان الاستخراج يجري في `ctx.waitUntil` بعد ردّ الرفع، وذاك لا يمهل العمل بعد الردّ إلا
// ثلاثين ثانية. وقراءةُ مستندٍ ممسوح دقائق: يُقطع العمل قبل أن يكتب شيئاً، فيبقى الصفُّ
// `pending` أبداً والشارة تدور، ولا يبلغ نصُّه المساعد في أيّ دور. ذلك ما وقع لكلّ ملفٍّ
// كبيرٍ رُفع — ثلاثةٌ من ثلاثة، متوسّطُ حجمها قرابة سبعة ميغابايتات.
//
// فصار الاستخراج في `ExtractRunner` (`src/extract-runner.ts`): منبّهُه يعمل مستقلاً عن طلب
// الرفع وله خمس عشرة دقيقة. وصورُ الصفحات التي رسمها المتصفّح تُحفظ في R2 ليقرأها، ثم
// تُحذف حين تُقرأ — لا تبقى نسخةٌ من مستند عميلٍ لا يدلّ عليها صفّ.
import { extractText, ocrPages, UNREAD_PAGE_NOTE, type PageImage } from './extract';
import type { Env } from '../types';

/** سقفُ نصّ المرفق — يوافق `ATTACH_PER_FILE_MAX` في `chat.ts`.
    وتجاوزُه تخزينٌ لما لن يُقرأ، ونقصانُه قصٌّ قبل أن يصل السقف الحقيقي. */
export const MAX_TEXT = 200_000;

export interface PageLayout {
  /** نصُّ كل صفحة، و`null` لصفحةٍ جاءت صورةً. */
  pages: (string | null)[];
  /** صورُ الصفحات بترتيب الـ`null` في `pages`. */
  images: PageImage[];
}

/** ما يلزم لاستخراج مرفقٍ رُفع للتوّ. */
export interface ExtractionJob {
  id: string;
  buf: ArrayBuffer;
  mime: string;
  filename: string;
  layout: PageLayout | null;
}

/** حفظُ الصور في R2 بضعٌ معاً لا كلُّها: كلُّ صورةٍ تُقرأ إلى الذاكرة قبل حفظها. */
const SAVE_CONCURRENCY = 6;

/**
 * وقتُ المنفّذ للمرفق الواحد.
 *
 * للمنبّه خمس عشرة دقيقة، ومنبّهٌ يُقطع عندها يضيع ما قرأه كلُّه ويُعاد من أوّله على
 * حساب نداءاتٍ تُدفع مرّتين. فتقف القراءة قبلها بهامش: ما قُرئ يُحفظ، وما لم يُقرأ
 * يُقال في موضعه غائباً أو مقتطعاً — والمساعد يعرف أن في المستند ما لم يبلغه.
 */
const EXTRACT_BUDGET_MS = 12 * 60_000;

const prefixOf = (id: string) => `ocr/${id}/`;
const layoutKey = (id: string) => `${prefixOf(id)}layout.json`;
const pageKey = (id: string, k: number) => `${prefixOf(id)}page-${k}`;

/**
 * يُطلق استخراج المرفق: في `ExtractRunner` إن كان ربطُه، وإلا في الطلب نفسه كما كان.
 *
 * وتعذُّرُ بدء المنفّذ لا يترك الصفّ بلا عمل: يعود إلى الطلب، فما يُقرأ في ثوانٍ —
 * وهو أغلب الملفات — يُقرأ، وما يطول يردّه المؤقّت متعثّراً (`runAttachmentRecovery`).
 */
export async function startExtraction(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  job: ExtractionJob
): Promise<void> {
  if (env.EXTRACT) {
    try {
      if (job.layout) await saveLayout(env, job.id, job.layout);
      const stub = env.EXTRACT.get(env.EXTRACT.idFromName(job.id));
      const res = await stub.fetch('https://extract/start', { method: 'POST', body: job.id });
      if (!res.ok) throw new Error(`runner ${res.status}`);
      return;
    } catch (e) {
      console.error('extraction runner start failed:', job.id, e);
      await dropLayout(env, job.id);
    }
  }
  ctx.waitUntil(
    job.layout ? readPageImages(env, job.id, job.layout) : readWholeFile(env, job.id, job.buf, job.mime, job.filename)
  );
}

/**
 * يستخرج نصَّ مرفقٍ في المنفّذ — من صور صفحاته إن حُفظت، وإلا من الملف نفسه في R2.
 *
 * ومرفقٌ ليس `pending` لا يُقرأ: حُذف مع محادثته، أو استقرّ في محاولةٍ سابقة — والمنبّه
 * يُعاد بعد انقطاعه فيصل هنا ثانيةً.
 *
 * وصورُ الصفحات تُحذف حين يستقرّ الصفّ أو يغيب، لا عند كل خروج: تعثُّرٌ قبل القراءة —
 * قاعدةٌ لم تُجب — يرمي فيُعاد المنبّه، والإعادةُ تحتاج الصور كما كانت.
 */
export async function extractAttachment(env: Env, id: string): Promise<void> {
  const row = await env.DB.prepare('SELECT r2_key, filename, mime, parse_status FROM attachments WHERE id = ?')
    .bind(id)
    .first<{ r2_key: string; filename: string; mime: string | null; parse_status: string }>();
  if (row?.parse_status === 'pending') {
    const deadline = Date.now() + EXTRACT_BUDGET_MS;
    const layout = await loadLayout(env, id);
    const obj = layout ? null : await env.R2.get(row.r2_key);
    if (layout) await readPageImages(env, id, layout, deadline);
    else if (obj) await readWholeFile(env, id, await obj.arrayBuffer(), row.mime ?? '', row.filename, deadline);
    else await settle(env, id, '', 'original file missing from storage');
  }
  await dropLayout(env, id);
}

/** يَسِم مرفقاً لم يستقرّ متعثّراً — لمنفّذٍ استنفد محاولاته، ولصفٍّ تجاوز أيَّ استخراجٍ ممكن. */
export async function markStalled(env: Env, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await env.DB.prepare(
    `UPDATE attachments SET parse_status = 'error', parse_error = 'extraction_stalled'
     WHERE parse_status = 'pending' AND id IN (${ids.map(() => '?').join(',')})`
  )
    .bind(...ids)
    .run();
  for (const id of ids) await dropLayout(env, id);
}

/**
 * يستخرج نصّ الملف كلِّه ويَسِم حالَه، ولا يترك صفّاً معلَّقاً مهما وقع.
 *
 * رميةٌ من تحت `ctx.waitUntil` أو المنبّه تُبتلع بلا أثر، فيبقى الصفُّ `pending` أبداً
 * وتبقى الشارة تدور. فما يخرج من هنا حالٌ مستقرّة دائماً: `ready` أو `error`.
 *
 * ونصٌّ فارغ حالُه `error` كتعثّر النداء سواء: نتيجتُهما على القارئ واحدة — ملفٌّ
 * قائمٌ يُنزَّل ولا يبلغ نصُّه المساعد — وحالان لنتيجةٍ واحدة تفترقان أوّل شاشة.
 */
export async function readWholeFile(
  env: Env,
  id: string,
  buf: ArrayBuffer,
  mime: string,
  filename: string,
  deadline?: number
): Promise<void> {
  let text = '';
  let error: string | null = null;
  try {
    text = await extractText(env, buf, mime, filename, deadline);
  } catch (e: any) {
    error = String(e?.message ?? e);
  }
  await settle(env, id, text, error);
}

/**
 * يقرأ صور الصفحات ويضع نصَّ كلٍّ منها في موضعها، ثم يَسِم الحال.
 * لا يترك صفّاً معلَّقاً — كـ`readWholeFile` سواء.
 */
export async function readPageImages(env: Env, id: string, layout: PageLayout, deadline?: number): Promise<void> {
  let text = '';
  let error: string | null = null;
  try {
    const read = await ocrPages(env, layout.images, deadline);
    let k = 0;
    text = layout.pages
      .map((p) => (p === null ? read[k++] : p))
      .filter((p) => p.trim())
      .join('\n\n')
      .slice(0, MAX_TEXT);
  } catch (e: any) {
    /* تعذّرت قراءة الصور كلِّها: صفحاتُ النصّ مقروءةٌ سلفاً فلا تُرمى معها.
       يُخزَّن ما قُرئ والغائبُ يُقال في موضعه، ولا خطأَ إلا إن لم يبقَ نصّ. */
    const known = layout.pages.filter((p): p is string => !!p?.trim());
    if (known.length) {
      text = layout.pages
        .map((p) => (p === null ? UNREAD_PAGE_NOTE : p))
        .filter((p) => p.trim())
        .join('\n\n')
        .slice(0, MAX_TEXT);
    } else {
      error = String(e?.message ?? e);
    }
  }
  await settle(env, id, text, error);
}

async function settle(env: Env, id: string, text: string, error: string | null): Promise<void> {
  if (!text.trim() && !error) error = 'لم يُستخرَج نصّ من الملف';
  await env.DB.prepare('UPDATE attachments SET parsed_text = ?, parse_status = ?, parse_error = ? WHERE id = ?')
    .bind(error ? null : text, error ? 'error' : 'ready', error, id)
    .run()
    .catch(() => {});
}

/**
 * يحفظ صور الصفحات ونصوصها في R2 ليقرأها المنفّذ — الصورُ أوّلاً ثم التخطيط، فلا يجد
 * المنفّذ تخطيطاً يشير إلى صورةٍ لم تُحفظ.
 */
async function saveLayout(env: Env, id: string, layout: PageLayout): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < layout.images.length) {
      const k = next++;
      const img = layout.images[k];
      await env.R2.put(pageKey(id, k), await img.load(), { httpMetadata: { contentType: img.mime } });
    }
  };
  await Promise.all(Array.from({ length: Math.min(SAVE_CONCURRENCY, layout.images.length) }, worker));
  await env.R2.put(layoutKey(id), JSON.stringify({ pages: layout.pages, mimes: layout.images.map((i) => i.mime) }), {
    httpMetadata: { contentType: 'application/json' },
  });
}

/** تخطيطُ صفحاتٍ حُفظ عند الرفع، أو `null` إن جاء الملف بلا صور صفحات. */
async function loadLayout(env: Env, id: string): Promise<PageLayout | null> {
  const obj = await env.R2.get(layoutKey(id));
  if (!obj) return null;
  const stored = JSON.parse(await obj.text()) as { pages: (string | null)[]; mimes: string[] };
  return {
    pages: stored.pages,
    images: stored.mimes.map((mime, k) => ({
      mime,
      load: async () => {
        const page = await env.R2.get(pageKey(id, k));
        if (!page) throw new Error(`page image ${k} missing from storage`);
        return page.arrayBuffer();
      },
    })),
  };
}

/** يحذف صور الصفحات وتخطيطها — بالبادئة لا بالعدد، فيُحذف ما حُفظ ولو انقطع الحفظ في منتصفه. */
async function dropLayout(env: Env, id: string): Promise<void> {
  try {
    const listed = await env.R2.list({ prefix: prefixOf(id) });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length) await env.R2.delete(keys);
  } catch (e: any) {
    console.error('page images cleanup failed:', id, e?.message ?? e);
  }
}
