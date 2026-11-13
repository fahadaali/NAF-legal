/**
 * محادثات العضو في خادم MCP — حفظُ ما أنتجته الأداة، وإكمالُ ما بدأ في المنصة.
 *
 * قرارُ صاحب المنصة: ما ينتجه العضو في Claude أو ChatGPT يُحفظ في محادثاته في
 * مكانها المعتاد من الشاشة الرئيسية، فيصل إليها من الجهتين. وإكمالُها من المنصة
 * يستهلك نموذج المنصة كأيّ محادثة، وإكمالُها من الأداة لا يستهلكه.
 *
 * ── حدودُ ما يُكتب ──
 *
 * - **للعضو وحده.** الضيف لا حساب له تُعلَّق عليه محادثة، فلا تظهر له هذه
 *   الأدوات أصلاً (`visibleTo`).
 * - **والحفظ لمن يكتب في المنصة:** المحرّر والمسؤول. القارئ لا يُنشئ محادثةً
 *   في الواجهة (`requireWriter`)، فلا يُنشئها من الأداة — دورُه كما هو. والقراءة
 *   (`list_my_conversations` و`get_conversation`) لكل عضو.
 * - **وفي محادثات صاحبها فقط:** كلُّ استعلامٍ مقيَّدٌ بـ`user_id` كما في
 *   `routes/conversations.ts` — العزل الصارم نفسه.
 * - **ولا تُمحى رسالةٌ ولا تُعدَّل:** إضافةٌ إلى آخر المحادثة، لا غير.
 *
 * ── ما يُحفظ ──
 *
 * رسالةٌ من العضو ورسالةٌ من المساعد بصيغة المنصة نفسها: `citations` في
 * `metadata_json` كما يكتبها `routes/chat.ts`، فتظهر بطاقاتُ المصادر في المحادثة
 * كما تظهر لردٍّ ولّدته المنصة. والمصادر لا تُؤخذ من الأداة كما أرسلتها — تُرسل
 * معرّفات المواد، فتُقرأ المواد من القاعدة وتُبنى البطاقات منها. فلا تظهر في
 * المنصة بطاقةُ مادةٍ لا وجود لها.
 *
 * ومعها `origin` في الرسالة والمحادثة: من أيّ أداةٍ جاءت (§١٥ — «مصدر المحادثة»).
 */
import type { Env } from '../types';
import { uuid } from '../lib/crypto';
import { getChunkById } from '../lib/legal';
import { fromLegalHit } from '../lib/rag';
import { arabicGlobPatterns } from '../lib/arabic';
import { isGenerating } from '../lib/generating';
import { argInt, argString } from './protocol';
import type { McpPrincipal, McpTool, McpToolResult } from './protocol';

const QUESTION_MAX = 20_000;
const ANSWER_MAX = 200_000;
const CITES_MAX = 50;
/** ما يُعاد من محادثةٍ طويلة: آخرُها أولى، والسقفُ سياقُ الأداة لا حدٌّ للمنصة. */
const READ_CHARS_MAX = 120_000;

const ok = (text: string): McpToolResult => ({ text });
const refuse = (text: string): McpToolResult => ({ text, isError: true });

const isMember = (p: McpPrincipal) => p.kind === 'member';
const canWrite = (p: McpPrincipal) => p.kind === 'member' && p.role !== 'viewer';

function userIdOf(p: McpPrincipal): string {
  return p.kind === 'member' ? p.userId : '';
}

/** عنوانٌ من السؤال بلا نداء نموذج — أوّلُ سطرٍ مقصوصاً. */
function titleFrom(question: string): string {
  const first = question.split('\n').find((l) => l.trim())?.trim() ?? 'محادثة جديدة';
  return first.length > 60 ? `${first.slice(0, 60).trim()}…` : first;
}

/** بطاقاتُ المصادر من القاعدة — كما يبنيها `toCitation` في `routes/chat.ts`. */
async function citationsFor(env: Env, ids: string[]) {
  const unique = [...new Set(ids)].slice(0, CITES_MAX);
  const hits = await Promise.all(unique.map((id) => getChunkById(env, id, true).catch(() => null)));
  const found = hits.filter((h): h is NonNullable<typeof h> => !!h);
  const citations = found.map((h) => {
    const r = fromLegalHit(h);
    return {
      title: r.title,
      ref: r.articleRef,
      source: 'legal' as const,
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
  });
  const missing = unique.filter((id) => !found.some((h) => h.id === id));
  return { citations, missing };
}

function readIds(args: Record<string, unknown>): string[] {
  const v = args.cited_article_ids;
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim().slice(0, 300));
}

async function appendExchange(
  env: Env,
  p: McpPrincipal,
  conversationId: string,
  question: string,
  answer: string,
  ids: string[]
): Promise<string[]> {
  const { citations, missing } = await citationsFor(env, ids);
  const origin = { via: 'mcp', client: p.clientName };
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO messages (id, conversation_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(uuid(), conversationId, 'user', question, JSON.stringify({ origin }), now),
    // بعد رسالة العضو بجزءٍ من الثانية: الترتيب بـ`created_at` وحده.
    env.DB.prepare(
      'INSERT INTO messages (id, conversation_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(uuid(), conversationId, 'assistant', answer, JSON.stringify({ citations, origin }), now + 1),
    env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?').bind(now + 1, conversationId, userIdOf(p)),
  ]);
  return missing;
}

function missingNote(missing: string[]): string {
  return missing.length
    ? `\nلم تُعرف هذه المعرّفات فلم تُحفظ مصادرَ: ${missing.join('، ')}. المعرّف الصحيح هو id في نتائج search_regulations أو get_article.`
    : '';
}

const EXCHANGE_PROPS = {
  question: { type: 'string', description: 'سؤال المستخدم كما كتبه.' },
  answer: { type: 'string', description: 'إجابتك كاملةً كما عرضتها عليه، بتنبيهاتها.' },
  cited_article_ids: {
    type: 'array',
    items: { type: 'string' },
    maxItems: CITES_MAX,
    description: 'معرّفات الموادّ (id) التي استشهدت بها — تظهر بطاقاتِ مصادر في المنصة.',
  },
};

export function conversationTools(env: Env): McpTool[] {
  return [
    {
      name: 'save_conversation',
      title: 'حفظ المحادثة في المنصة',
      description:
        'ينشئ محادثةً في حساب المستخدم على منصة مستشار ناف بأوّل سؤالٍ وإجابة، ويُرجع conversation_id. ' +
        'استدعِه بعد أوّل إجابةٍ في هذه المحادثة، ثم استعمل append_to_conversation بالمعرّف نفسه لكل إجابةٍ بعدها.',
      readOnly: false,
      visibleTo: canWrite,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'عنوانٌ قصير للمحادثة. اختياري — يُؤخذ من السؤال إن غاب.' },
          ...EXCHANGE_PROPS,
        },
        required: ['question', 'answer'],
      },
      async run(args, p) {
        const question = argString(args, 'question', QUESTION_MAX);
        const answer = argString(args, 'answer', ANSWER_MAX);
        if (!question || !answer) return refuse('question و answer مطلوبان.');
        const title = argString(args, 'title', 120) ?? titleFrom(question);
        const id = uuid();
        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO conversations (id, user_id, title, consultation_type, created_at, updated_at, origin, origin_client)
           VALUES (?, ?, ?, NULL, ?, ?, 'mcp', ?)`
        )
          .bind(id, userIdOf(p), title, now, now, p.clientName)
          .run();
        const missing = await appendExchange(env, p, id, question, answer, readIds(args));
        return ok(
          `حُفظت المحادثة في المنصة.\nconversation_id: ${id}\nاستعمل append_to_conversation بهذا المعرّف لكل إجابةٍ تالية في هذه المحادثة.${missingNote(missing)}`
        );
      },
    },

    {
      name: 'append_to_conversation',
      title: 'إضافة إلى محادثة في المنصة',
      description:
        'يضيف سؤالاً وإجابته إلى محادثةٍ للمستخدم على المنصة — محادثةٍ حفظتها أنت، أو بدأها في المنصة وفتحتها بـ get_conversation.',
      readOnly: false,
      visibleTo: canWrite,
      inputSchema: {
        type: 'object',
        properties: { conversation_id: { type: 'string' }, ...EXCHANGE_PROPS },
        required: ['conversation_id', 'question', 'answer'],
      },
      async run(args, p) {
        const id = argString(args, 'conversation_id', 100);
        const question = argString(args, 'question', QUESTION_MAX);
        const answer = argString(args, 'answer', ANSWER_MAX);
        if (!id || !question || !answer) return refuse('conversation_id و question و answer مطلوبة.');
        const own = await env.DB.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').bind(id, userIdOf(p)).first();
        if (!own) return refuse('لا محادثة بهذا المعرّف في حساب المستخدم. احفظها محادثةً جديدة بـ save_conversation.');
        // المنصة تكتب في المحادثة الآن: إضافةٌ في وسط ردٍّ يُولَّد تقطعه نصفين.
        if (await isGenerating(env, id)) {
          return refuse('المنصة تولّد ردّاً في هذه المحادثة الآن. أعد الإضافة بعد دقيقة.');
        }
        const missing = await appendExchange(env, p, id, question, answer, readIds(args));
        return ok(`أُضيفت إلى المحادثة.\nconversation_id: ${id}${missingNote(missing)}`);
      },
    },

    {
      name: 'list_my_conversations',
      title: 'محادثاتي في المنصة',
      description:
        'محادثات المستخدم على المنصة، أحدثها أولاً — ما بدأه في المنصة وما حُفظ من أدواته. ' +
        'لإكمال محادثةٍ: get_conversation ثم append_to_conversation.',
      readOnly: true,
      visibleTo: isMember,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'كلماتٌ في العنوان.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'الافتراضي 20.' },
        },
      },
      async run(args, p) {
        const q = argString(args, 'query', 200);
        const patterns = q ? arabicGlobPatterns(q) : [];
        const where = patterns.map(() => 'title GLOB ?').join(' AND ');
        const rows = await env.DB.prepare(
          `SELECT id, title, origin, origin_client, updated_at FROM conversations
           WHERE user_id = ?${where ? ` AND ${where}` : ''} ORDER BY updated_at DESC LIMIT ?`
        )
          .bind(userIdOf(p), ...patterns, argInt(args, 'limit', 20, 1, 100))
          .all<{ id: string; title: string | null; origin: string | null; origin_client: string | null; updated_at: number }>();
        const list = rows.results ?? [];
        if (!list.length) return ok(q ? 'لا محادثات بهذا العنوان.' : 'لا محادثات بعد.');
        return ok(
          list
            .map(
              (r) =>
                `- ${r.title ?? 'محادثة'} — conversation_id: ${r.id} · آخر تحديث: ${new Date(r.updated_at).toISOString().slice(0, 16).replace('T', ' ')} UTC` +
                (r.origin === 'mcp' ? ` · من ${r.origin_client ?? 'أداة مربوطة'}` : '')
            )
            .join('\n')
        );
      },
    },

    {
      name: 'get_conversation',
      title: 'فتح محادثة من المنصة',
      description: 'رسائل محادثةٍ للمستخدم على المنصة بترتيبها، لتكملها. المحادثة الطويلة تُعاد من آخرها.',
      readOnly: true,
      visibleTo: isMember,
      inputSchema: {
        type: 'object',
        properties: { conversation_id: { type: 'string' } },
        required: ['conversation_id'],
      },
      async run(args, p) {
        const id = argString(args, 'conversation_id', 100);
        if (!id) return refuse('conversation_id مطلوب.');
        const conv = await env.DB.prepare('SELECT title FROM conversations WHERE id = ? AND user_id = ?')
          .bind(id, userIdOf(p))
          .first<{ title: string | null }>();
        if (!conv) return refuse('لا محادثة بهذا المعرّف في حساب المستخدم.');
        const rows = await env.DB.prepare(
          "SELECT role, content FROM messages WHERE conversation_id = ? AND role IN ('user','assistant') ORDER BY created_at ASC"
        )
          .bind(id)
          .all<{ role: string; content: string }>();
        const msgs = rows.results ?? [];
        // من الآخر إلى الأوّل حتى السقف: آخرُ المحادثة هو ما يُكمَل.
        const kept: string[] = [];
        let used = 0;
        for (let i = msgs.length - 1; i >= 0; i--) {
          const block = `### ${msgs[i].role === 'user' ? 'المستخدم' : 'المساعد'}\n${msgs[i].content}`;
          if (used + block.length > READ_CHARS_MAX && kept.length) break;
          kept.unshift(block);
          used += block.length;
        }
        const cut = kept.length < msgs.length ? `(أُعيدت آخر ${kept.length} رسالة من ${msgs.length})\n\n` : '';
        return ok(`# ${conv.title ?? 'محادثة'}\nconversation_id: ${id}\n${cut}\n${kept.join('\n\n')}`);
      },
    },
  ];
}
