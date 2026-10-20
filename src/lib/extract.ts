// استخراج النص من الملفات المرفوعة — §11
// TXT: مباشر · DOCX: فكّ ضغط ZIP أصلي · PDF/صور: عبر رؤية Claude
import { callClaude } from './claude';
import type { Env } from '../types';

export async function extractText(env: Env, buf: ArrayBuffer, mime: string, filename: string): Promise<string> {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();

  if (mime.startsWith('text/') || ext === 'txt' || ext === 'md') {
    return new TextDecoder().decode(buf).trim();
  }
  if (ext === 'docx' || mime.includes('officedocument.wordprocessingml')) {
    return await extractDocx(buf);
  }
  if (ext === 'pdf' || mime === 'application/pdf') {
    return await extractViaClaude(env, buf, 'application/pdf', 'document');
  }
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
    // و`gif` ليست في `ALLOWED_EXT` بـ`files.ts` فلا تبلغ هنا من مسار الرفع؛
    // وتبقى في الشرط لأن `kb.ts` يستدعي هذه الدالّة بملفٍّ لم يمرّ بتلك القائمة.
    const m = mime.startsWith('image/') ? mime : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
    return await extractViaClaude(env, buf, m, 'image');
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

const TRANSCRIBE = 'استخرج كامل النص المكتوب في هذا الملف حرفيًا وبالترتيب، دون تلخيص أو تعليق. أعِد النص فقط.';

async function extractViaClaude(env: Env, buf: ArrayBuffer, mediaType: string, kind: 'document' | 'image'): Promise<string> {
  const base64 = arrayBufferToBase64(buf);
  const block =
    kind === 'document'
      ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

  const { text, raw } = await callClaude(env, {
    model: env.ANALYSIS_MODEL,
    effort: 'low', // نقلٌ حرفيّ للنص، لا تحليل — فلا وجه لإنفاق تفكيرٍ عليه
    max_tokens: EXTRACT_MAX_TOKENS,
    messages: [{ role: 'user', content: [block as any, { type: 'text', text: TRANSCRIBE }] }],
  });
  return text.trim() + (raw?.stop_reason === 'max_tokens' ? TRUNCATED_NOTE : '');
}

/**
 * أقصى عدد نداءاتٍ لقراءة صفحات ملفٍّ واحد.
 *
 * كلُّ نداءٍ طلبٌ فرعيّ من العامل، وللطلبات الفرعية حدٌّ في الخطة. فالصفحات
 * تُجمع في دفعاتٍ لا تتجاوز هذا العدد: عشرُ صفحاتٍ عشرةُ نداءات بصفحةٍ لكلٍّ،
 * وستّون صفحة عشرةُ نداءات بستّ صفحاتٍ لكلٍّ.
 */
const OCR_MAX_CALLS = 10;

/** فاصلٌ يكتبه النموذج بين صفحات الدفعة، فيُعاد كلُّ نصٍّ إلى صفحته. */
const PAGE_BREAK = '<<<PAGE>>>';

/**
 * يقرأ صفحاتٍ مرسومةً صوراً، معاً لا واحدةً بعد واحدة، ويردّ نصَّ كلٍّ منها
 * بترتيبها.
 *
 * **والسرعة من التوازي، والدقّة من صِغَر الدفعة.** كان المستند الممسوح يُرسَل
 * كلُّه في نداءٍ واحد، فيطول بطول نصّه كلّه ويُقصّ عند سقفٍ واحد. والآن
 * يطول بطول أطول دفعة، ولكلّ دفعةٍ سقفُها.
 */
export async function ocrPages(env: Env, images: { bytes: ArrayBuffer; mime: string }[]): Promise<string[]> {
  if (!images.length) return [];
  const size = Math.ceil(images.length / OCR_MAX_CALLS);
  const batches: number[][] = [];
  for (let i = 0; i < images.length; i += size) {
    batches.push(Array.from({ length: Math.min(size, images.length - i) }, (_, k) => i + k));
  }

  const out: string[] = new Array(images.length).fill('');
  const settled = await Promise.allSettled(
    batches.map(async (batch) => {
      const content: any[] = batch.map((i) => ({
        type: 'image',
        source: { type: 'base64', media_type: images[i].mime, data: arrayBufferToBase64(images[i].bytes) },
      }));
      const instruction =
        batch.length === 1
          ? TRANSCRIBE
          : `هذه ${batch.length} صفحات متتالية من مستندٍ واحد، بترتيبها. استخرج النص المكتوب في كل صفحة حرفيًا وبالترتيب، دون تلخيص أو تعليق، واكتب بين نصّ كل صفحةٍ والتي تليها سطرًا وحده فيه ${PAGE_BREAK} فقط. أعِد النصوص فقط.`;
      content.push({ type: 'text', text: instruction });

      const { text, raw } = await callClaude(env, {
        model: env.ANALYSIS_MODEL,
        effort: 'low',
        max_tokens: EXTRACT_MAX_TOKENS,
        messages: [{ role: 'user', content }],
      });
      const truncated = raw?.stop_reason === 'max_tokens';
      const parts = batch.length === 1 ? [text] : text.split(PAGE_BREAK);
      if (parts.length === batch.length) {
        batch.forEach((i, k) => (out[i] = parts[k].trim()));
      } else {
        /* فواصلُ لم تأتِ كما طُلبت: النصّ كلُّه في موضع أوّل صفحةٍ من الدفعة.
           صفحاتُ الدفعة متتالية في الصور، فالترتيب بينها محفوظ — والذي قد
           يختلّ موضعُ صفحةٍ نصّيةٍ تقع بينها في المستند، وهو أهون من فقدها. */
        out[batch[0]] = text.split(PAGE_BREAK).map((t) => t.trim()).filter(Boolean).join('\n\n');
      }
      if (truncated) out[batch[batch.length - 1]] += TRUNCATED_NOTE;
    })
  );
  /* دفعةٌ تعثّرت لا تُسقط أخواتها: صفحاتُها تُقال غائبةً في النصّ نفسه، فيعرف
     المساعد أن في المستند ما لم يقرأه. وتعثُّر الدفعات كلِّها خطأٌ يُرمى. */
  const failures = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failures.length === batches.length) throw failures[0].reason;
  settled.forEach((r, b) => {
    if (r.status === 'rejected') for (const i of batches[b]) out[i] = UNREAD_PAGE_NOTE;
  });
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
