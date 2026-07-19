// مسار المحادثة: المُخطِّط → المُنفِّذ → التوليد المتدفّق (§5)
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { uuid } from '../lib/crypto';
import { runPlanner } from '../lib/planner';
import { retrieve, formatRagContext, indexConversationMessage } from '../lib/rag';
import { streamClaude, webSearchTool, OFFICIAL_DOMAINS } from '../lib/claude';
import { systemPromptFor, DISCLAIMER, BILINGUAL_INSTRUCTION } from '../lib/prompts';
import { verifyGrounding } from '../lib/verify';
import { logUsage } from '../lib/usage';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

// POST /api/chat/:conversationId  → SSE stream
app.post('/:conversationId', async (c) => {
  const user = c.get('user');
  const conversationId = c.req.param('conversationId');
  const { message, force_internet, bilingual } = await c.req.json().catch(() => ({}));
  if (!message?.trim()) return c.json({ error: 'الرسالة فارغة' }, 400);

  // تحقّق الملكية
  const conv = await c.env.DB.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .bind(conversationId, user.id)
    .first<{ id: string; consultation_type: string | null; title: string }>();
  if (!conv) return c.json({ error: 'المحادثة غير موجودة' }, 404);

  const now = Date.now();

  // خزّن رسالة المستخدم
  const userMsgId = uuid();
  await c.env.DB.prepare(
    'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(userMsgId, conversationId, 'user', message, now)
    .run();

  // المرفقات المرتبطة بالمحادثة (نصّها المستخرَج)
  const atts = await c.env.DB.prepare(
    'SELECT filename, parsed_text FROM attachments WHERE conversation_id = ? AND parsed_text IS NOT NULL'
  )
    .bind(conversationId)
    .all<{ filename: string; parsed_text: string }>();
  const hasAttachments = (atts.results?.length ?? 0) > 0;

  // سجل الرسائل السابق (سياق المحادثة)
  const history = await c.env.DB.prepare(
    'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 40'
  )
    .bind(conversationId)
    .all<{ role: string; content: string }>();

  // [1] المُخطِّط
  const plan = await runPlanner(c.env, message, conv.consultation_type ?? undefined, hasAttachments, !!force_internet, user.id);

  // حالة الاستيضاح: أوقف التوليد واطرح الأسئلة (§3, §5)
  if (plan.clarifying_questions.length > 0) {
    const clarifyText =
      'قبل المتابعة، أحتاج توضيح النقاط التالية لإكمال العمل بدقّة:\n\n' +
      plan.clarifying_questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
    const asstId = uuid();
    await c.env.DB.prepare(
      'INSERT INTO messages (id, conversation_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(asstId, conversationId, 'assistant', clarifyText, JSON.stringify({ plan, clarifying: true }), Date.now())
      .run();
    await touchConversation(c.env, conversationId, message, conv.title);
    return sseOnce(clarifyText, { messageId: asstId, plan });
  }

  // [2] المُنفِّذ: استرجاع RAG
  let ragContext = '';
  let citations: any[] = [];
  if (plan.needs_knowledge_base && plan.kb_queries.length) {
    try {
      const results = await retrieve(c.env, plan.kb_queries, 6);
      ragContext = formatRagContext(results);
      citations = results.map((r) => ({ title: r.title, ref: r.articleRef, score: r.score }));
    } catch {
      // قاعدة معرفة غير مهيّأة بعد — نتابع دون RAG
    }
  }

  // [3] تجميع البرومبت
  let system = systemPromptFor(plan.consultation_type);
  if (bilingual) system += BILINGUAL_INSTRUCTION;
  const attachmentsBlock = hasAttachments
    ? '\n\n<الملفات_المرفوعة>\n' +
      atts.results!.map((a) => `— ${a.filename}:\n${(a.parsed_text ?? '').slice(0, 12000)}`).join('\n\n') +
      '\n</الملفات_المرفوعة>'
    : '';

  const userContent = `${ragContext}${attachmentsBlock}\n\n${message}`.trim();

  const messages = [
    ...(history.results ?? [])
      .filter((m) => m.role !== 'system')
      .slice(0, -1) // نستثني آخر رسالة (وهي رسالة المستخدم الحالية) لنُدرجها مع السياق
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user' as const, content: userContent },
  ];

  // [4] التوليد المتدفّق
  const tools = plan.needs_internet_search
    ? [webSearchTool(force_internet ? undefined : OFFICIAL_DOMAINS)]
    : undefined;

  let claudeStream: ReadableStream<Uint8Array>;
  try {
    claudeStream = await streamClaude(c.env, {
      model: c.env.GENERATION_MODEL,
      system,
      messages,
      tools,
      max_tokens: 8192,
    });
  } catch (e: any) {
    return c.json({ error: 'تعذّر توليد الرد', detail: String(e?.message ?? e) }, 502);
  }

  // نلتقط النص كاملًا أثناء التدفّق لنخزّنه في النهاية
  const asstId = uuid();
  let fullText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  const encoder = new TextEncoder();
  const env = c.env;
  const userId = user.id;

  const outStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // أرسل بيانات وصفية أولية
      controller.enqueue(encoder.encode(`event: meta\ndata: ${JSON.stringify({ messageId: asstId, plan, citations })}\n\n`));

      const reader = claudeStream.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        controller.enqueue(value); // مرّر أحداث SSE كما هي للواجهة
        // استخرج النص لتجميعه
        buf += chunk;
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const p of parts) {
          const dataLine = p.split('\n').find((l) => l.startsWith('data: '));
          if (dataLine && p.includes('event: delta')) {
            try {
              fullText += JSON.parse(dataLine.slice(6)).text ?? '';
            } catch {}
          } else if (dataLine && p.includes('event: usage')) {
            try {
              const u = JSON.parse(dataLine.slice(6));
              if (u.input_tokens) inputTokens = u.input_tokens;
              if (u.output_tokens) outputTokens = u.output_tokens;
            } catch {}
          }
        }
      }

      // [5] طبقة التحقّق بعد التوليد (الاقتباس المُتحقَّق منه) — §2
      let verification = null;
      try {
        verification = await verifyGrounding(env, userId, fullText, ragContext, plan.consultation_type);
      } catch {}
      if (verification) {
        controller.enqueue(encoder.encode(`event: verify\ndata: ${JSON.stringify(verification)}\n\n`));
      }

      // خزّن رد المساعد
      if (fullText.trim()) {
        await env.DB.prepare(
          'INSERT INTO messages (id, conversation_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(
            asstId,
            conversationId,
            'assistant',
            fullText,
            JSON.stringify({ plan, citations, output_format: plan.output_format, verification }),
            Date.now()
          )
          .run();
        await touchConversation(env, conversationId, message, conv.title);
        // لقطة أولى في سجل النُسخ
        await env.DB.prepare(
          'INSERT INTO draft_versions (id, message_id, version, content, note, created_at) VALUES (?, ?, 1, ?, ?, ?)'
        )
          .bind(uuid(), asstId, fullText, 'النسخة الأولى المولَّدة', Date.now())
          .run()
          .catch(() => {});
        // فهرسة دلالية للرسالتين (§3) — best-effort
        await indexConversationMessage(env, { messageId: userMsgId, conversationId, userId, role: 'user', content: message, title: conv.title });
        await indexConversationMessage(env, { messageId: asstId, conversationId, userId, role: 'assistant', content: fullText, title: conv.title });
      }
      await logUsage(env, {
        userId,
        kind: 'generation',
        model: env.GENERATION_MODEL,
        inputTokens,
        outputTokens,
        consultationType: plan.consultation_type,
      });
      controller.close();
    },
  });

  return new Response(outStream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
});

// يحدّث وقت المحادثة، ويولّد عنوانًا من أول رسالة إن كان افتراضيًا
async function touchConversation(env: Env, id: string, firstMessage: string, currentTitle: string) {
  const now = Date.now();
  if (!currentTitle || currentTitle === 'محادثة جديدة') {
    const title = firstMessage.slice(0, 60).replace(/\n/g, ' ');
    await env.DB.prepare('UPDATE conversations SET updated_at = ?, title = ? WHERE id = ?')
      .bind(now, title, id)
      .run();
  } else {
    await env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, id).run();
  }
}

// رد SSE من نص واحد (لحالة الاستيضاح)
function sseOnce(text: string, meta: Record<string, unknown>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`event: meta\ndata: ${JSON.stringify(meta)}\n\n`));
      controller.enqueue(encoder.encode(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`));
      controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  });
}

export { DISCLAIMER };
export default app;
