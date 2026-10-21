// استخراج النص من الملفات المرفوعة — §11
// TXT: مباشر · DOCX: فكّ ضغط ZIP أصلي · PDF/صور: عبر رؤية Claude
import { collectClaude } from './claude';
import type { Env } from '../types';

/**
 * نصُّ الملف — و`deadline` وقتٌ مطلق تقف عنده القراءة بما وصل منها موسوماً بالقصّ
 * (انظر `collectClaude`)، لمن يُقطع عمله كلُّه بعده.
 */
export async function extractText(
  env: Env,
  buf: ArrayBuffer,
  mime: string,
  filename: string,
  deadline?: number
): Promise<string> {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();

  if (mime.startsWith('text/') || ext === 'txt' || ext === 'md') {
    return new TextDecoder().decode(buf).trim();
  }
  if (ext === 'docx' || mime.includes('officedocument.wordprocessingml')) {
    return await extractDocx(buf);
  }
  if (ext === 'pdf' || mime === 'application/pdf') {
    return await extractViaClaude(env, buf, 'application/pdf', 'document', deadline);
  }
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
    // و`gif` ليست في `ALLOWED_EXT` بـ`files.ts` فلا تبلغ هنا من مسار الرفع؛
    // وتبقى في الشرط لأن `kb.ts` يستدعي هذه الدالّة بملفٍّ لم يمرّ بتلك القائمة.
    const m = mime.startsWith('image/') ? mime : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
    return await extractViaClaude(env, buf, m, 'image', deadline);
  }
  // احتياط: محاولة فكّ ترميز نصّي
  return new TextDecoder().decode(buf).replace(/[^\x09\x0A\x0D\x20-\x7E؀-ۿ]/g, '').trim();
}

// ── استخراج DOCX عبر قراءة ZIP وفكّ ضغط deflate-raw أصليًا ──
async function extractDocx(buf: ArrayBuffer): Promise<string> {
  const xml = await readZipEntry(buf, 'word/document.xml');
  if (!xml) return '';
  const text = new TextDecoder().decode(xml);
  // نحوّل نهايات الفقرات والأسطر إلى أسطر جديدة ثم نزيل الوسوم
  return text
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    /* حدُّ الخليّة جدولة، وحدُّ الصفّ سطر.
       وبلا هذا يذوب الجدول: كلُّ خليّة تصير سطراً قائماً بذاته، فيخرج صفٌّ من
       أربع خلايا أربعةَ أسطر لا يُعرف أيُّ مبلغٍ منها لأيِّ بند. وهو العطبُ
       نفسه الذي كان في الـ PDF، وقد فُصلت خلاياه بالجدولة أيضاً. */
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    /* الفقرةُ داخل الخليّة تركت سطراً قبل جدولتها، وآخرُ خليّةٍ تركت جدولةً
       قبل سطر الصفّ — فتُطوى كلٌّ منهما في حدِّها. */
    .replace(/\n+\t/g, '\t')
    .replace(/\t+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// قارئ ZIP مبسّط: يبحث في السجل المركزي عن اسم الإدخال ويفكّ ضغطه
async function readZipEntry(buf: ArrayBuffer, name: string): Promise<Uint8Array | null> {
  const data = new Uint8Array(buf);
  const view = new DataView(buf);
  // نبحث عن ترويسات الملفات المحلية (PK\x03\x04)
  const target = new TextEncoder().encode(name);
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x03 && data[i + 3] === 0x04) {
      const method = view.getUint16(i + 8, true);
      const compSize = view.getUint32(i + 18, true);
      const nameLen = view.getUint16(i + 26, true);
      const extraLen = view.getUint16(i + 28, true);
      const nameStart = i + 30;
      const entryName = data.subarray(nameStart, nameStart + nameLen);
      if (bytesEqual(entryName, target)) {
        const dataStart = nameStart + nameLen + extraLen;
        const comp = data.subarray(dataStart, dataStart + compSize);
        if (method === 0) return comp; // مخزَّن دون ضغط
        return await inflateRaw(comp);
      }
      i = nameStart + nameLen + extraLen + compSize - 1;
    }
  }
  return null;
}

async function inflateRaw(comp: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Response(comp).body!.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── استخراج عبر رؤية Claude (PDF/صور) ──

/**
 * سقفُ مخرَج نداء الاستخراج — والتفكير يقتسمه مع النصّ.
 *
 * كان ٨١٩٢، فمستندٌ ممسوح من عشر صفحات أو أكثر يُقصّ نصُّه عند السقف بصمت:
 * لا يُقرأ `stop_reason`، فيُخزَّن نصفُ المستند ويجيب المساعد عنه كأنه كلّه.
 * والسقفُ لا يُدفع إلا عمّا وُلّد فعلاً، فرفعُه مجّانيّ.
 */
const EXTRACT_MAX_TOKENS = 32000;

/** ذيلٌ يقوله النصُّ عن نفسه حين بلغ النداءُ سقفه — بصيغة ذيل القصّ في `chat.ts`. */
export const TRUNCATED_NOTE = '\n…(مقتطع)';

/** وقف النداءُ قبل تمام النصّ: بلغ سقفه، أو انقضى وقت المنفّذ. */
const cut = (stopReason: string) => stopReason === 'max_tokens' || stopReason === 'deadline';

const TRANSCRIBE = 'استخرج كامل النص المكتوب في هذا الملف حرفيًا وبالترتيب، دون تلخيص أو تعليق. أعِد النص فقط.';

/** مهلةٌ قبل إعادة نداءٍ تعثّر — عارضُ الازدحام يمضي في ثوانٍ لا في لحظة. */
const RETRY_DELAY_MS = 5_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** يُعيد النداء مرّةً بعد مهلة إن تعثّر — إلا ألّا يبقى من الوقت ما يسع الإعادة. */
async function onceMore<T>(fn: () => Promise<T>, deadline?: number): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (deadline && Date.now() + RETRY_DELAY_MS >= deadline) throw e;
    await sleep(RETRY_DELAY_MS);
    return await fn();
  }
}

async function extractViaClaude(
  env: Env,
  buf: ArrayBuffer,
  mediaType: string,
  kind: 'document' | 'image',
  deadline?: number
): Promise<string> {
  const base64 = arrayBufferToBase64(buf);
  const block =
    kind === 'document'
      ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

  // متدفّقٌ لا `callClaude`: نسخُ مستندٍ طويل يجاوز مهلة النداء غير المتدفّق — انظر `collectClaude`.
  const { text, stopReason } = await onceMore(
    () =>
      collectClaude(
        env,
        {
          model: env.ANALYSIS_MODEL,
          effort: 'low', // نقلٌ حرفيّ للنص، لا تحليل — فلا وجه لإنفاق تفكيرٍ عليه
          max_tokens: EXTRACT_MAX_TOKENS,
          messages: [{ role: 'user', content: [block as any, { type: 'text', text: TRANSCRIBE }] }],
        },
        deadline
      ),
    deadline
  );
  // ذيلُ القصّ على نصٍّ وصل لا على فراغ: ذيلٌ وحده يُخزَّن «جاهزاً» وليس فيه من الملف حرف.
  const t = text.trim();
  return t && cut(stopReason) ? t + TRUNCATED_NOTE : t;
}

/**
 * صفحاتُ النداء الواحد في قراءة الممسوح.
 *
 * كانت الصفحات تُقسَم على عشرة نداءاتٍ أيّاً كان عددها — حذراً من حدّ الطلبات الفرعية —
 * فستّون صفحةً ستُّ صفحاتٍ في النداء: نسخُها دقائق، والنداء غير المتدفّق كان يُقطع عند
 * مهلته فتغيب الصفحات الستّ معاً. والدفعة الصغيرة أقصر وأدقّ، وما يتعثّر منها يُغيّب
 * صفحاتٍ أقلّ.
 *
 * وعشرون نداءً لستّين صفحة، مع قراءة صورها من R2، في حدود الطلبات الفرعية للخطة
 * المدفوعة لا المجانية.
 */
const OCR_PAGES_PER_CALL = 3;

/**
 * نداءاتُ القراءة الجارية معاً — ومنها السرعة: زمنُ المستند كلِّه عددُ صفحاته على
 * هذا الرقم، وللمنفّذ وقتٌ محدود (`EXTRACT_BUDGET_MS`).
 *
 * وحدُّ المخرَج في الحساب يحتمل أكثر منها بكثير — يُحسب بما وُلّد فعلاً، وأدناه
 * لـOpus 5.5 أربعمئة ألف رمزٍ في الدقيقة. والتقييد للدفعة المفاجئة: الحساب يُحدّ
 * عند القفزة الحادّة في الاستعمال، ونداءاتُ القراءة تقتسمه مع توليد الردود.
 */
const OCR_CONCURRENCY = 6;

/** فاصلٌ يكتبه النموذج بين صفحات الدفعة، فيُعاد كلُّ نصٍّ إلى صفحته. */
const PAGE_BREAK = '<<<PAGE>>>';

/** صورةُ صفحةٍ تُقرأ بايتاتها حين يحين نداؤها: ستّون صورةً في الذاكرة معاً ما لا يلزم. */
export interface PageImage {
  load: () => Promise<ArrayBuffer>;
  mime: string;
}

/**
 * يقرأ صفحاتٍ مرسومةً صوراً ويردّ نصَّ كلٍّ منها بترتيبها.
 *
 * دفعاتٌ صغيرة تجري بضعٌ منها معاً، وكلُّ دفعةٍ تعثّرت تُعاد مرّةً بعد مهلة. ودفعةٌ
 * تعثّرت مرّتين لا تُسقط أخواتها: صفحاتُها تُقال غائبةً في النصّ نفسه، فيعرف المساعد
 * أن في المستند ما لم يقرأه. وتعثُّر الدفعات كلِّها خطأٌ يُرمى.
 *
 * و`deadline` يقف عنده كلُّ شيء: الجاري يُحفظ ما وصل منه مقتطعاً، وما لم يبدأ تُقال
 * صفحاته غائبة — فيُحفظ ما قُرئ بدل أن يضيع كلُّه بانقطاع المنبّه.
 */
export async function ocrPages(env: Env, images: PageImage[], deadline?: number): Promise<string[]> {
  if (!images.length) return [];
  const batches: number[][] = [];
  for (let i = 0; i < images.length; i += OCR_PAGES_PER_CALL) {
    batches.push(Array.from({ length: Math.min(OCR_PAGES_PER_CALL, images.length - i) }, (_, k) => i + k));
  }

  const out: string[] = new Array(images.length).fill('');
  const read = async (batch: number[]) => {
    const content: any[] = [];
    for (const i of batch) {
      const data = arrayBufferToBase64(await images[i].load());
      content.push({ type: 'image', source: { type: 'base64', media_type: images[i].mime, data } });
    }
    const instruction =
      batch.length === 1
        ? TRANSCRIBE
        : `هذه ${batch.length} صفحات متتالية من مستندٍ واحد، بترتيبها. استخرج النص المكتوب في كل صفحة حرفيًا وبالترتيب، دون تلخيص أو تعليق، واكتب بين نصّ كل صفحةٍ والتي تليها سطرًا وحده فيه ${PAGE_BREAK} فقط. أعِد النصوص فقط.`;
    content.push({ type: 'text', text: instruction });

    const { text, stopReason } = await collectClaude(
      env,
      { model: env.ANALYSIS_MODEL, effort: 'low', max_tokens: EXTRACT_MAX_TOKENS, messages: [{ role: 'user', content }] },
      deadline
    );
    const parts = batch.length === 1 ? [text] : text.split(PAGE_BREAK);
    if (parts.length === batch.length) {
      batch.forEach((i, k) => (out[i] = parts[k].trim()));
    } else {
      /* فواصلُ لم تأتِ كما طُلبت: النصّ كلُّه في موضع أوّل صفحةٍ من الدفعة.
         صفحاتُ الدفعة متتالية في الصور، فالترتيب بينها محفوظ — والذي قد
         يختلّ موضعُ صفحةٍ نصّيةٍ تقع بينها في المستند، وهو أهون من فقدها. */
      out[batch[0]] = text.split(PAGE_BREAK).map((t) => t.trim()).filter(Boolean).join('\n\n');
    }
    if (cut(stopReason) && text.trim()) out[batch[batch.length - 1]] += TRUNCATED_NOTE;
  };

  const failures: unknown[] = [];
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      if (deadline && Date.now() >= deadline) {
        for (const i of batch) out[i] = UNREAD_PAGE_NOTE;
        continue;
      }
      try {
        await onceMore(() => read(batch), deadline);
      } catch (e: any) {
        console.error(`ocr batch failed (pages ${batch[0] + 1}–${batch[batch.length - 1] + 1}):`, e?.message ?? e);
        failures.push(e);
        for (const i of batch) out[i] = UNREAD_PAGE_NOTE;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(OCR_CONCURRENCY, batches.length) }, worker));
  if (failures.length === batches.length) throw failures[0];
  return out;
}

export const UNREAD_PAGE_NOTE = '…(تعذّرت قراءة هذه الصفحة)';

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
