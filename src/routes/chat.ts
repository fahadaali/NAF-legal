// مسار المحادثة: المُخطِّط → المُنفِّذ → التوليد المتدفّق (§5)
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { uuid } from '../lib/crypto';
import { runPlanner } from '../lib/planner';
import { retrieve, formatRagContext, type RagResult } from '../lib/rag';
import {
  streamClaude,
  webSearchTool,
  OFFICIAL_DOMAINS,
  emptyTurnReason,
  isRetryableEmptyTurn,
  type ClaudeEffort,
  type ClaudeStream,
  type StreamOutcome,
} from '../lib/claude';
import { needsGeneratedTitle, generateTitle } from '../lib/title';
import { BILINGUAL_INSTRUCTION } from '../lib/prompts';
import { getEffectiveConfig } from '../lib/consultationConfig';
import { verifyGrounding } from '../lib/verify';
import { logUsage } from '../lib/usage';
import { findMissingRegulations, mentionedInAnswer } from '../lib/regulations';
import { markGenerating, clearGenerating } from '../lib/generating';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

/**
 * محاولتان لا واحدة.
 *
 * دورٌ ينتهي بلا نصّ ليس حالةً نادرة على نموذجٍ تفكيرُه مُفعَّل: الحدّ سقفٌ
 * للتفكير والنص معاً فقد يستنفده التفكير قبل أن تبدأ الكلمة الأولى، وأداةُ
 * البحث تُوقف الدور (`pause_turn`) قبل أن يُكتب شيء، والخدمة تنقطع داخل البثّ.
 * وكان المستخدم يرى في هذه الحالات كلّها فقاعةً بمصادرَ بلا استشارة — يطلب
 * رأياً قانونياً فيأخذ أرقام موادّ وحدها.
 *
 * فالمحاولة الثانية تُخفض الجهد — فيقصر التفكير ويتّسع المتاح للنص — وتُسقط
 * الأدوات فلا وقفةَ أداةٍ أصلاً. وهي لا تقع إلا حين لا يأتي نصّ، فلا تُضاعف
 * كلفة الدور الناجح.
 */
const ATTEMPTS: { effort: ClaudeEffort; max_tokens: number; withTools: boolean }[] = [
  // الحدُّ سقفٌ للتفكير والنص معاً، والمخرَج صحيفةُ دعوى أو مذكرة قد تطول.
  // والبثّ مُفعَّل فلا يُخشى عليه من مهلة الاتصال.
  { effort: 'high', max_tokens: 64000, withTools: true },
  { effort: 'medium', max_tokens: 32000, withTools: false },
];

// POST /api/chat/:conversationId  → SSE stream
app.post('/:conversationId', async (c) => {
  const user = c.get('user');
  const conversationId = c.req.param('conversationId');
  const { message, force_internet, bilingual, attachment_ids } = await c.req.json().catch(() => ({}));
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

  /* العلامة تُرفع مع حفظ رسالة المستخدم لا مع بدء البثّ.
     بينهما المُخطِّط والاسترجاع والتضمين — ثوانٍ. ومن أعاد تحميل الصفحة
     فيها يجد سؤاله محفوظاً بلا جواب ولا أثرِ عمل، فيعيده. وتُنزل عند كل
     مخرجٍ من هذا المسار: الاستيضاح، وفشل فتح البثّ، وختام الدور. */
  await markGenerating(c.env, conversationId);

  /* المرفقات المرسَلة مع هذا الدور تُختم برسالته.
     والختم مقيَّدٌ بثلاثة: أن يكون المرفق في هذه المحادثة، وأن يكون لم
     يُرسَل بعد (`message_id IS NULL`) — فمرفقُ دورٍ سابق لا يُنتزَع من
     فقاعته ليُعاد هنا، ولو أرسلت الشاشة معرِّفه. */
  const sentIds: string[] = Array.isArray(attachment_ids)
    ? attachment_ids.filter((x: unknown) => typeof x === 'string').slice(0, 10)
    : [];
  if (sentIds.length) {
    await c.env.DB.batch(
      sentIds.map((attId) =>
        c.env.DB.prepare(
          'UPDATE attachments SET message_id = ? WHERE id = ? AND conversation_id = ? AND message_id IS NULL'
        ).bind(userMsgId, attId, conversationId)
      )
    );
  }

  // سجل الرسائل السابق (سياق المحادثة) — نأخذ أحدث 40 رسالة ثم نعيد ترتيبها زمنيًا
  const historyDesc = await c.env.DB.prepare(
    'SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 40'
  )
    .bind(conversationId)
    .all<{ id: string; role: string; content: string }>();
  const history = { results: (historyDesc.results ?? []).slice().reverse() };

  /* نصوص المرفقات — لرسائل هذه النافذة وحدها، لا للمحادثة كلِّها.
     الرسالة تخرج من النافذة فيخرج مرفقُها معها، وإدراجُ نصِّ ملفٍّ سقط
     سياقُه يُبقي الجواب مبنيّاً على ما لم يعد أحد يراه. */
  const msgIds = (history.results ?? []).map((m) => m.id);
  const attRows = msgIds.length
    ? await c.env.DB.prepare(
        `SELECT message_id, filename, parsed_text FROM attachments
         WHERE message_id IN (${msgIds.map(() => '?').join(',')})
           AND parsed_text IS NOT NULL AND parsed_text != ''`
      )
        .bind(...msgIds)
        .all<{ message_id: string; filename: string; parsed_text: string }>()
    : { results: [] as { message_id: string; filename: string; parsed_text: string }[] };

  const attByMessage = new Map<string, { filename: string; parsed_text: string }[]>();
  for (const row of attRows.results ?? []) {
    const list = attByMessage.get(row.message_id) ?? [];
    list.push({ filename: row.filename, parsed_text: row.parsed_text });
    attByMessage.set(row.message_id, list);
  }
  const hasAttachments = attByMessage.size > 0;

  // [1] المُخطِّط
  const plan = await runPlanner(c.env, message, conv.consultation_type ?? undefined, hasAttachments, !!force_internet, user.id, history.results);

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
    await touchConversation(c.env, conversationId);
    // الاستيضاح محادثةٌ بدأت فعلاً: عنوانها يُصاغ من سؤالها ولا يُؤجَّل إلى
    // أول ردٍّ مكتمل — وإلا بقيت «محادثة جديدة» في القائمة إلى أن يُجاب.
    const title = await retitle(c.env, {
      conversationId,
      current: conv.title,
      question: message,
      userId: user.id,
      consultationType: conv.consultation_type,
    });
    await clearGenerating(c.env, conversationId);
    return sseOnce(clarifyText, { messageId: asstId, plan }, title);
  }

  // [2] المُنفِّذ: استرجاع RAG
  let ragContext = '';
  let citations: any[] = [];
  if (plan.needs_knowledge_base && plan.kb_queries.length) {
    try {
      const results = await retrieve(c.env, plan.kb_queries, 6);
      ragContext = formatRagContext(results);
      citations = results.map(toCitation);
    } catch (e: any) {
      // قاعدة معرفة غير مهيّأة بعد — نتابع دون RAG، ونقول ذلك في السجلّ:
      // ردٌّ بلا إسناد يبدو في الشاشة ردّاً عادياً، والفرق يظهر هنا وحده.
      console.error('retrieval failed:', e?.message ?? e);
    }
  }

  // الأنظمة التي رشّحها المُخطِّط ولا وجود لها في قاعدة المعرفة: تُبلَّغ للواجهة
  // ليعرضها على المستخدم ويعرض عليه طلب إضافتها (§6 — لا إسناد بلا مصدر).
  const missingRegulations = plan.needs_knowledge_base
    ? await findMissingRegulations(c.env, plan.target_regulations, user.id)
    : [];

  // [3] تجميع البرومبت (يُستخدم البرومبت القابل للتحكّم من الإدارة إن وُجد)
  const effectiveConfig = await getEffectiveConfig(c.env, plan.consultation_type);
  let system = effectiveConfig.system_prompt;
  if (bilingual) system += BILINGUAL_INSTRUCTION;
  /* نصُّ المرفق يُدرَج **عند دوره** لا في كل دور.

     وكان يُدرَج في كل دورٍ لأن المرفق كان مربوطاً بالمحادثة ولا يعرف أيُّ
     سؤالٍ حمله. فمحادثةٌ بخمسة ملفات تعيد نصوصها الخمسة كاملةً في كل سؤال
     — كلفةً تتضاعف بطول المحادثة، وسياقاً يقرأ فيه المساعد عقداً أُرسل قبل
     عشرة أدوار كأنه أُرسل الآن. والآن لكلِّ رسالةٍ مرفقاتُها، فتُدرَج معها
     حيث وقعت.

     والسقف يبقى: يُحسب لكل دورٍ على حدة لأنه سقفُ رسالةٍ واحدة. */
  const attachmentsBlock = attByMessage.has(userMsgId)
    ? buildAttachmentsBlock(attByMessage.get(userMsgId)!)
    : '';

  const userContent = `${ragContext}${attachmentsBlock}\n\n${message}`.trim();

  const messages = [
    ...(history.results ?? [])
      .filter((m) => m.role !== 'system')
      .slice(0, -1) // نستثني آخر رسالة (وهي رسالة المستخدم الحالية) لنُدرجها مع السياق
      .map((m) => {
        const own = attByMessage.get(m.id);
        return {
          role: m.role as 'user' | 'assistant',
          content: own ? `${buildAttachmentsBlock(own)}\n\n${m.content}`.trim() : m.content,
        };
      }),
    { role: 'user' as const, content: userContent },
  ];

  // [4] التوليد المتدفّق
  const tools = plan.needs_internet_search
    ? [webSearchTool(force_internet ? undefined : OFFICIAL_DOMAINS)]
    : undefined;

  const env = c.env;
  const openAttempt = (i: number): Promise<ClaudeStream> =>
    streamClaude(env, {
      model: env.GENERATION_MODEL,
      system,
      messages,
      tools: ATTEMPTS[i].withTools ? tools : undefined,
      effort: ATTEMPTS[i].effort,
      max_tokens: ATTEMPTS[i].max_tokens,
    });

  let firstAttempt: ClaudeStream;
  try {
    firstAttempt = await openAttempt(0);
  } catch (e: any) {
    // السبب يُسجَّل ولا يُعرض. هذه الجملة هي كل ما يراه المستخدم حين تنقطع
    // خدمة Claude، فتُقرأ خطأَ صلاحيات أو خللاً في حسابه — وما يفرّق بين
    // مفتاح ناقص وشكل طلبٍ مرفوض إنما هو ردّ الـAPI، ومكانه السجلّ لا الشاشة.
    console.error('generation failed:', e?.message ?? e);
    await clearGenerating(env, conversationId);
    return c.json({ error: 'تعذّر توليد الرد', detail: String(e?.message ?? e) }, 502);
  }

  // نلتقط النص كاملًا أثناء التدفّق لنخزّنه في النهاية
  const asstId = uuid();
  let fullText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  const encoder = new TextEncoder();
  const userId = user.id;

  /* ══ الدور يجري في الخلفية، والاتصال يشاهده إن بقي ══
   *
   * كان جسمُ التوليد كلُّه داخل `start` مجرى الاستجابة، فعمرُه عمرُ الاتصال:
   * يُغلق القارئ التبويب أو يُعيد تحميل الصفحة فيُلغى المجرى، ويقطع وقتُ
   * التشغيل ما بقي من الطلب — ومعه الحفظُ في القاعدة والعنوانُ وتحقُّقُ
   * الإسناد. فيخسر المحامي مذكرةً وصلت إلى نصفها لأنه ضغط زرّ الرجوع.
   *
   * وقد صار الجسم مهمّةً في `waitUntil`: وقتُ التشغيل يُبقيها حيّة إلى أن
   * تنتهي بغضّ النظر عن الاتصال، وهي تكتب في `writable` ما دام أحدٌ يقرأ
   * فإن انصرف مضت صامتةً إلى آخرها. والردّ يُحفظ في الحالين، فيجده صاحبه
   * كاملاً حين يعود.
   *
   * والعلامة في KV هي ما يقوله للعائد بعد إعادة التحميل: ثمّة دورٌ يجري،
   * فانتظره ولا تُعِد السؤال. */
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const run = async () => {
    try {
      /* القارئ قد ينصرف قبل أن يكتمل الدور — يغلق التبويب أو تنقطع شبكته —
         فترمي الكتابةُ في مجرًى أُلغي. وما يُحفَظ يُكمَل على أي حال: الرد
         والعنوان وشارة التحقّق تُخزَّن، فيعود المستخدم فيجد محادثته تامّة. */
      let readerGone = false;
      const push = async (chunk: Uint8Array) => {
        if (readerGone) return;
        try {
          await writer.write(chunk);
        } catch {
          readerGone = true;
        }
      };
      const send = (event: string, data: unknown) =>
        push(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      // أرسل بيانات وصفية أولية
      await send('meta', { messageId: asstId, plan, citations });

      /** يمرّر أحداث محاولةٍ كما هي إلى الواجهة، ويجمع نصّها وعدّاداتها. */
      const pump = async (attempt: ClaudeStream): Promise<StreamOutcome> => {
        const reader = attempt.stream.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await push(value); // مرّر أحداث SSE كما هي للواجهة
          // استخرج النص لتجميعه
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop() ?? '';
          for (const p of parts) {
            const dataLine = p.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            try {
              const payload = JSON.parse(dataLine.slice(6));
              if (p.includes('event: delta')) {
                fullText += payload.text ?? '';
              } else if (p.includes('event: usage')) {
                // العدّادات تُجمع لا تُستبدل: محاولتان تُدفَعان كلتاهما.
                if (payload.input_tokens) inputTokens += payload.input_tokens;
                if (payload.output_tokens) outputTokens += payload.output_tokens;
              }
            } catch {}
          }
        }
        return attempt.outcome;
      };

      let outcome = await pump(firstAttempt);
      for (let i = 1; i < ATTEMPTS.length && !fullText.trim() && isRetryableEmptyTurn(outcome); i++) {
        console.error(
          `empty turn (stop_reason=${outcome.stopReason ?? 'none'}) — retrying at effort=${ATTEMPTS[i].effort} without tools`
        );
        try {
          outcome = await pump(await openAttempt(i));
        } catch (e: any) {
          console.error('retry failed:', e?.message ?? e);
          break;
        }
      }

      // خزّن رد المساعد
      if (fullText.trim()) {
        /* [5أ] الأنظمة الغائبة تُصفَّى بالردّ نفسه قبل أن تُعرض.

           `target_regulations` نصٌّ يكتبه المُخطِّط ولا شيء يتحقّق منه، فاسمٌ
           يخترعه — «نظام المحاكم العمالية» ولا نظام بهذا الاسم — كان يصير
           تنبيهاً وزرَّ طلبٍ يبعث المحامي يبحث عمّا لا وجود له. وما لم يذكره
           الردّ لم يتوقّف عليه الإسناد، فلا وجه لمطالبة أحدٍ به. */
        const relevantMissing = mentionedInAnswer(missingRegulations, fullText);
        if (missingRegulations.length !== relevantMissing.length) {
          console.error(
            `dropped unmentioned target regulations: ${missingRegulations.filter((n) => !relevantMissing.includes(n)).join(' · ')}`
          );
        }

        const metadata: Record<string, unknown> = {
          plan,
          citations,
          output_format: plan.output_format,
          missing_regulations: relevantMissing,
        };
        await env.DB.prepare(
          'INSERT INTO messages (id, conversation_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(asstId, conversationId, 'assistant', fullText, JSON.stringify(metadata), Date.now())
          .run();
        await touchConversation(env, conversationId);
        // لقطة أولى في سجل النُسخ
        await env.DB.prepare(
          'INSERT INTO draft_versions (id, message_id, version, content, note, created_at) VALUES (?, ?, 1, ?, ?, ?)'
        )
          .bind(uuid(), asstId, fullText, 'النسخة الأولى المولَّدة', Date.now())
          .run()
          .catch(() => {});

        /* الدور يُختم هنا لا قبل ذلك.
           كان حدث `done` يخرج مع نهاية بثّ النموذج — أي قبل أن يُخزَّن الرد
           وقبل حدثَي «الأنظمة الغائبة» و«تحقّق الإسناد» — فتُنهي الواجهة
           الفقاعة ثم تصل الحدثان إلى مستمعٍ انصرف: شارة التحقّق لا تظهر
           أبداً، وطلبُ إضافة نظامٍ ناقص لا يُعرض. وزرُّ التصدير كان يظهر
           للحظةٍ قبل أن يوجد الصفّ الذي يصدّره. */
        await send('done', {});
        await send('regulations', { missing: relevantMissing });

        // [5] طبقة التحقّق بعد التوليد (الاقتباس المُتحقَّق منه) — §2
        let verification = null;
        try {
          verification = await verifyGrounding(env, userId, fullText, ragContext, plan.consultation_type);
        } catch {}
        if (verification) {
          // التحقّق يجري بعد الحفظ الآن، فيُكتب في بياناته الوصفية لتبقى
          // الشارة ظاهرة حين تُفتح المحادثة من جديد.
          metadata.verification = verification;
          await env.DB.prepare('UPDATE messages SET metadata_json = ? WHERE id = ?')
            .bind(JSON.stringify(metadata), asstId)
            .run()
            .catch((e: any) => console.error('store verification failed:', e?.message ?? e));
          await send('verify', verification);
        }

        // [6] عنوان المحادثة من موضوعها — يُصاغ مرّة واحدة عند أول ردّ
        const title = await retitle(env, {
          conversationId,
          current: conv.title,
          question: message,
          answer: fullText,
          userId,
          consultationType: plan.consultation_type,
        });
        if (title) await send('title', { title });

        /* وأُسقطت هنا فهرسةٌ دلالية للرسالتين كانت تقع في كل دور.
           كانت تستدعي نموذج التضمين مرّتين وتدفع متجهين إلى `CONV_VECTORIZE`
           — لفهرسٍ لا يستعلمه أحد: قارئُه الوحيد `searchConversations` ولم
           يُنادَ قطّ، والبحث في المنصة لفظيٌّ بقرارٍ مكتوب. التفصيل في
           `lib/rag.ts`. */
      } else {
        // لم يأتِ نصّ ولا أفادت المحاولة الثانية: قُل السبب بعينه ولا تخزّن
        // ردّاً فارغاً. والفقاعة تُختم بعده حتى لا تنبض بلا نهاية.
        await touchConversation(env, conversationId);
        await send('error', { error: emptyTurnReason(outcome) });
        await send('done', {});
      }
      await logUsage(env, {
        userId,
        kind: 'generation',
        model: env.GENERATION_MODEL,
        inputTokens,
        outputTokens,
        consultationType: plan.consultation_type,
      });
    } catch (e: any) {
      /* خطأٌ خرج من الجسم كلِّه. وهو الآن في `waitUntil` لا في مجرى استجابة،
         فلا أحد يلتقطه ولا يظهر في شبكة المتصفّح — والسجلّ هو موضعه. */
      console.error('background generation failed:', e?.message ?? e);
    } finally {
      // العلامة تُنزل مهما كان المآل، وإلا بقيت المحادثة «قيد التوليد» إلى
      // أن تنتهي مهلتها — دوّارةُ انتظارٍ على دورٍ انتهى.
      await clearGenerating(env, conversationId);
      try {
        await writer.close();
      } catch {
        // القارئ انصرف فأُلغي المجرى — لا شيء يُغلَق.
      }
    }
  };

  c.executionCtx.waitUntil(run());

  return new Response(readable, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
});

/**
 * الاستشهاد كما يصل الواجهة.
 *
 * كان ثلاثة حقول — العنوان والمادة والدرجة — فكانت المصادر تُذكر أسفل كل
 * إجابة ولا تُفتح: اسمُ نظامٍ ورقمُ مادةٍ في شارةٍ صمّاء، ومن أراد أن يقرأ
 * المادة التي بُني عليها الرأي بحث عنها في شاشة الأنظمة بنفسه. والمعرّف هو
 * ما يفتحها، وما بعده — الأداة والجهة والتاريخ والرابط — هو ما يُعرَف به
 * النصُّ قبل أن يُستشهد به.
 *
 * والدرجة تبقى: هي رتبة المقطع في الاسترجاع، ولا تُعرض للقارئ.
 */
function toCitation(r: RagResult) {
  return {
    title: r.title,
    ref: r.articleRef,
    score: r.score,
    // `document` للوثائق المرفوعة، و`legal` للمقاطع المستوردة — والثانية
    // وحدها لها مادةٌ تُفتح ببوابتها.
    source: r.source ?? 'document',
    id: r.documentId,
    lawId: r.lawId,
    articleNo: r.articleNo,
    docType: r.docType,
    instrument: r.instrument,
    instrumentNo: r.instrumentNo,
    authority: r.authority,
    issueDate: r.issueDate,
    issueDateHijri: r.issueDateHijri,
    sourceUrl: r.sourceUrl,
  };
}

// يبني كتلة الملفات المرفوعة بسقف كلّي للحجم (يوزَّع على الملفات)
/* سقوفُ نصّ المرفقات — وقد رُفعت لأنها كانت تقصّ المستند إلى صفحاتٍ قليلة.
   عشرون ألف حرفٍ للملف الواحد ≈ ثماني صفحاتٍ عربية، وستّون ألفاً موزَّعةً على
   عشرة ملفّات تعطي ستّة آلافٍ لكلٍّ ≈ صفحتين. فيُرفع عقدٌ من ثلاثين صفحة
   ويُجاب عن أوّله وحده — بلا سطرٍ يقول إن الباقي لم يُقرأ.

   وكانت مضبوطةً حين كان الملفُّ كلُّه يُرسَل بايتاتِه إلى النموذج ليقرأه.
   والقراءة الآن تقع في المتصفّح مجّاناً، فالكلفة كلفةُ سياقٍ لا كلفةُ قراءة:
   مئتا ألف حرفٍ عربيّ ≈ سبعون ألف رمز، في نافذةٍ سعتُها مليون. */
const ATTACH_TOTAL_BUDGET = 400_000; // حروف
const ATTACH_PER_FILE_MAX = 200_000;

function buildAttachmentsBlock(atts: { filename: string; parsed_text: string }[]): string {
  const perFile = Math.max(2_000, Math.min(ATTACH_PER_FILE_MAX, Math.floor(ATTACH_TOTAL_BUDGET / atts.length)));
  let used = 0;
  const parts: string[] = [];
  for (const a of atts) {
    if (used >= ATTACH_TOTAL_BUDGET) {
      parts.push(`— ${a.filename}: (لم يُدرَج لتجاوز حد الحجم؛ اطلب من المستخدم تحديد المقطع المطلوب)`);
      continue;
    }
    const text = (a.parsed_text ?? '').slice(0, perFile);
    used += text.length;
    const truncated = (a.parsed_text ?? '').length > text.length ? '\n…(مقتطع)' : '';
    parts.push(`— ${a.filename}:\n${text}${truncated}`);
  }
  return `\n\n<الملفات_المرفوعة>\n${parts.join('\n\n')}\n</الملفات_المرفوعة>`;
}

// يحدّث وقت المحادثة (ترتيبُ القائمة يقوم عليه)
async function touchConversation(env: Env, id: string) {
  await env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(Date.now(), id).run();
}

/**
 * يصوغ عنوان المحادثة من موضوعها ويكتبه. يعيد العنوان الجديد، أو `null` إن
 * لم يكن ثمّة ما يُبدَّل.
 *
 * كان العنوان أوّلَ ستّين حرفاً من رسالة البدء — ورسالة البدء تُبنى في نموذج
 * الإدخال بترويسةٍ ثابتة تسبق كل شيء، فحملت كل استشارةٍ قانونية العنوان نفسه،
 * وكل صحيفة دعوى عنوانها، ولا يُفرَّق بينها في القائمة إلا بالوقت.
 */
async function retitle(
  env: Env,
  opts: {
    conversationId: string;
    current: string;
    question: string;
    answer?: string;
    userId: string;
    consultationType?: string | null;
  }
): Promise<string | null> {
  if (!needsGeneratedTitle(opts.current)) return null;
  const title = await generateTitle(env, {
    question: opts.question,
    answer: opts.answer,
    userId: opts.userId,
    consultationType: opts.consultationType,
  });
  if (!title || title === opts.current) return null;
  try {
    await env.DB.prepare('UPDATE conversations SET title = ? WHERE id = ?').bind(title, opts.conversationId).run();
  } catch (e: any) {
    // عنوانٌ لم يُكتب لا يُسقط ردّاً اكتمل — لكن لا يُبلَّغ به أيضاً.
    console.error('title update failed:', e?.message ?? e);
    return null;
  }
  return title;
}

// رد SSE من نص واحد (لحالة الاستيضاح)
function sseOnce(text: string, meta: Record<string, unknown>, title?: string | null): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`event: meta\ndata: ${JSON.stringify(meta)}\n\n`));
      controller.enqueue(encoder.encode(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`));
      if (title) controller.enqueue(encoder.encode(`event: title\ndata: ${JSON.stringify({ title })}\n\n`));
      controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  });
}

export default app;
