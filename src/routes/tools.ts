// أدوات قانونية مستقلّة: مقارنة نسختين، حاسبة المواعيد، التفريغ الصوتي
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { callClaude } from '../lib/claude';
import { COMPARE_SYSTEM, DEADLINE_SYSTEM } from '../lib/prompts';
import { logUsage, usageFromRaw } from '../lib/usage';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

/**
 * مقارنة نسختين من مستند — §1.
 *
 * نصّان في الجسم لا ملفّان. وكان هنا فرعُ `multipart/form-data` يستخرج نصّ
 * ملفّين مرفوعين — **ولم يناديه أحد قطّ**: `api.compare` ترسل JSON دائماً.
 * وبقاؤه أوهم الواجهةَ أن ثمّة استخراجاً خادمياً تعتمد عليه، فكانت تضع في
 * الصندوق نصّاً نائباً وتنتظره. فأُسقط، وصارت القراءة حيث تقع فعلاً: في
 * المتصفّح (`web/src/components/Tools.tsx`) بـMuPDF بلا كلفة نموذج.
 */
app.post('/compare', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const textA: string = body.text_a ?? '';
  const textB: string = body.text_b ?? '';

  if (!textA.trim() || !textB.trim()) return c.json({ error: 'يلزم توفير نسختين للمقارنة' }, 400);

  const { text, raw } = await callClaude(c.env, {
    model: c.env.GENERATION_MODEL,
    system: COMPARE_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `النسخة (أ):\n${textA.slice(0, 20000)}\n\n=====\n\nالنسخة (ب):\n${textB.slice(0, 20000)}`,
      },
    ],
    // بلا بثّ، فالحدّ دون سقف المهلة — والتفكير يقتسمه مع النص.
    max_tokens: 16000,
  });
  await logUsage(c.env, { userId: user.id, kind: 'generation', model: c.env.GENERATION_MODEL, ...usageFromRaw(raw), consultationType: 'compare' });
  return c.json({ result: text });
});

// حاسبة المواعيد النظامية — §1
app.post('/deadlines', async (c) => {
  const user = c.get('user');
  const { judgment_type, notification_date, court, notes } = await c.req.json().catch(() => ({}));
  if (!notification_date) return c.json({ error: 'تاريخ التبليغ مطلوب' }, 400);

  const prompt = `نوع الحكم/القرار: ${judgment_type ?? 'غير محدّد'}
الجهة/المحكمة: ${court ?? 'غير محدّدة'}
تاريخ التبليغ: ${notification_date}
ملاحظات: ${notes ?? 'لا يوجد'}

احسب مواعيد الاعتراض/الاستئناف النظامية.`;

  const { text, raw } = await callClaude(c.env, {
    model: c.env.GENERATION_MODEL,
    system: DEADLINE_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 8000,
  });
  await logUsage(c.env, { userId: user.id, kind: 'generation', model: c.env.GENERATION_MODEL, ...usageFromRaw(raw), consultationType: 'deadlines' });
  return c.json({ result: text });
});

// تدقيق لغوي عربي للمخرَج مع الحفاظ على المعنى القانوني
app.post('/proofread', async (c) => {
  const user = c.get('user');
  const { text } = await c.req.json().catch(() => ({}));
  if (!text?.trim()) return c.json({ error: 'النص فارغ' }, 400);

  const system = `أنت مدقّق لغوي عربي متخصّص في النصوص القانونية السعودية.
دقّق النص المُرسَل: الإملاء · النحو · علامات الترقيم · اتساق المصطلح القانوني · سلامة الصياغة.
قيود صارمة:
- لا تُغيّر المعنى القانوني ولا أرقام المواد أو التواريخ أو أسماء الأطراف.
- حافظ على بنية العناوين والترقيم كما هي.
أعِد النص المُصحَّح كاملًا فقط، دون تعليق أو شرح.`;

  const { text: out, raw } = await callClaude(c.env, {
    model: c.env.GENERATION_MODEL,
    system,
    messages: [{ role: 'user', content: text.slice(0, 40000) }],
    max_tokens: 16000,
  });
  await logUsage(c.env, { userId: user.id, kind: 'generation', model: c.env.GENERATION_MODEL, ...usageFromRaw(raw), consultationType: 'proofread' });
  return c.json({ result: out });
});

/**
 * التفريغ الصوتي العربي (إدخال الوقائع صوتيًا) — §3.
 *
 * **والصوت سلسلةُ base64 لا مصفوفةَ بايتات.** كان يُرسَل
 * `audio: [...new Uint8Array(buf)]` — وذلك عقدُ `@cf/openai/whisper` القديم،
 * لا عقدُ `-turbo`. والفرق في أنواع الحزمة نفسها:
 *
 *   Ai_Cf_Openai_Whisper_Input              { audio: number[] }
 *   Ai_Cf_Openai_Whisper_Large_V3_Turbo_Input { audio: string | {…} }
 *
 * وما ستره أن اسم النموذج كان مكتوباً `as any`، فلم يقابله المدقّق بعقده.
 * وأُسقط الوسم، فصار العقدُ مفروضاً عند البناء لا مُكتشَفاً عند الاستعمال.
 *
 * و`language` معه: النموذج يكشف اللغة وحدَه، وكشفُه يخطئ على مقطعٍ عربيٍّ
 * قصير فيفرّغه بحروفٍ لاتينية. والمنصة عربية، فتُقال اللغة ولا تُخمَّن.
 */
app.post('/transcribe', async (c) => {
  const user = c.get('user');
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) return c.json({ error: 'لا يوجد صوت' }, 400);
  try {
    const res = await c.env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio: base64(buf),
      task: 'transcribe',
      language: 'ar',
    });
    await logUsage(c.env, { userId: user.id, kind: 'transcribe', model: 'whisper-large-v3-turbo' });
    return c.json({ text: res?.text ?? '' });
  } catch (e: any) {
    console.error('transcribe failed:', e?.message ?? e);
    return c.json({ error: 'تعذّر التفريغ الصوتي', detail: String(e?.message ?? e) }, 502);
  }
});

/** بايتات إلى base64 — على دفعات، فـ`String.fromCharCode` تنفد بسجلّها. */
function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export default app;
