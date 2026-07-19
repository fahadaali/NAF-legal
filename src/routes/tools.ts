// أدوات قانونية مستقلّة: مقارنة نسختين، حاسبة المواعيد، التفريغ الصوتي
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { callClaude } from '../lib/claude';
import { COMPARE_SYSTEM, DEADLINE_SYSTEM } from '../lib/prompts';
import { extractText } from '../lib/extract';
import { logUsage, usageFromRaw } from '../lib/usage';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

// مقارنة نسختين من مستند (رفع ملفين أو نصّين) — §1
app.post('/compare', async (c) => {
  const user = c.get('user');
  const ct = c.req.header('content-type') ?? '';
  let textA = '';
  let textB = '';

  if (ct.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const fa = form.get('file_a');
    const fb = form.get('file_b');
    if (fa instanceof File) textA = await extractText(c.env, await fa.arrayBuffer(), fa.type, fa.name);
    if (fb instanceof File) textB = await extractText(c.env, await fb.arrayBuffer(), fb.type, fb.name);
  } else {
    const body = await c.req.json().catch(() => ({}));
    textA = body.text_a ?? '';
    textB = body.text_b ?? '';
  }

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
    max_tokens: 8192,
    temperature: 0.2,
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
    max_tokens: 3000,
    temperature: 0.1,
  });
  await logUsage(c.env, { userId: user.id, kind: 'generation', model: c.env.GENERATION_MODEL, ...usageFromRaw(raw), consultationType: 'deadlines' });
  return c.json({ result: text });
});

// التفريغ الصوتي العربي (إدخال الوقائع صوتيًا) — §3
app.post('/transcribe', async (c) => {
  const user = c.get('user');
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) return c.json({ error: 'لا يوجد صوت' }, 400);
  try {
    const res: any = await c.env.AI.run('@cf/openai/whisper-large-v3-turbo' as any, {
      audio: [...new Uint8Array(buf)],
    });
    await logUsage(c.env, { userId: user.id, kind: 'transcribe', model: 'whisper-large-v3-turbo' });
    return c.json({ text: res?.text ?? '' });
  } catch (e: any) {
    return c.json({ error: 'تعذّر التفريغ الصوتي', detail: String(e?.message ?? e) }, 502);
  }
});

export default app;
