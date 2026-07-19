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
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
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
async function extractViaClaude(env: Env, buf: ArrayBuffer, mediaType: string, kind: 'document' | 'image'): Promise<string> {
  const base64 = arrayBufferToBase64(buf);
  const block =
    kind === 'document'
      ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

  const { text } = await callClaude(env, {
    model: env.PLANNER_MODEL,
    max_tokens: 8192,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          block as any,
          { type: 'text', text: 'استخرج كامل النص المكتوب في هذا الملف حرفيًا وبالترتيب، دون تلخيص أو تعليق. أعِد النص فقط.' },
        ],
      },
    ],
  });
  return text.trim();
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
