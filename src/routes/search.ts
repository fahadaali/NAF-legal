// البحث في المنصة — بلا ذكاء اصطناعي.
//
// ثلاثة مواضع يبحث فيها من دخل: محادثاته، ومخرجاته المحفوظة، وقاعدة
// المعرفة. وكلُّها لفظيّ: لا تضمين ولا نداء نموذج ولا كلفةَ نداءٍ ولا
// تأخيرَه — يبحث المستخدم بكلماته فتُطابَق كلماتُه.
//
// والاسترجاع للمحادثة يبقى هجيناً كما هو: تلك خدمةٌ أخرى، والبحث المباشر
// شيء والاستشهاد في إجابةٍ مولَّدة شيء آخر.
//
// والملكية شرطٌ في كل استعلام: المحادثات والمخرجات تخصّ صاحبها وحده،
// وقاعدة المعرفة مشتركة. ولو غاب الشرط لقرأ كلُّ مستخدمٍ محادثات غيره.
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { arabicGlobPatterns } from '../lib/arabic';
import { searchLegal } from '../lib/legal';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

/** سقف نتائج كل موضع — الشاشة تعرض ما يُقرأ لا كل ما طابق. */
const LIMIT = 15;

/** طول المقتطف حول موضع المطابقة. */
const SNIPPET = 300;
const SNIPPET_LEAD = 60;

/**
 * يبني شرط المطابقة: كل كلمةٍ من الاستعلام يجب أن ترد في النصّ.
 *
 * `AND` لا `OR`: البحث المباشر تضييقٌ للنتائج، ومن كتب كلمتين يريد ما
 * جمعهما لا ما ذكر إحداهما.
 */
function globCondition(column: string, patterns: string[]): string {
  return patterns.map(() => `${column} GLOB ?`).join(' AND ');
}

/**
 * مقتطفٌ حول موضع المطابقة لا من رأس النصّ.
 *
 * `instr` بالاستعلام كما كُتب: إن ورد حرفياً بدأ المقتطف قبله بقليل، وإن
 * لم يرد (لاختلاف همزة) عاد إلى رأس النصّ — وهو أفضل من مقتطفٍ لا يظهر فيه
 * ما بُحث عنه.
 */
function snippetExpr(column: string): string {
  return `substr(${column}, MAX(1, instr(${column}, ?) - ${SNIPPET_LEAD}), ${SNIPPET})`;
}

app.get('/', async (c) => {
  const user = c.get('user');
  const q = c.req.query('q')?.trim() ?? '';
  const scope = c.req.query('scope') ?? 'all';
  /* قضيةٌ يُحصر فيها البحث — للشريط الجانبي.
     ترشيحُ القضية والبحثُ كانا مسارين لا يلتقيان: القائمة تمرّر المجلّد
     و`/search` لا يعرفه، فمن رشّح قضيةً ثم كتب كلمةً رأى محادثاتٍ من قضايا
     أخرى وشارةُ القضية مضاءة. والحصر هنا لا بعد القصّ: ترشيحُ خمس عشرة
     نتيجةً بعد اختيارها يعطي صفحةً ناقصة أو فارغة. */
  const folder = c.req.query('folder')?.trim() || null;
  if (!q) return c.json({ chats: [], outputs: [], kb: { articles: [], documents: [] }, mode: 'empty' });

  const patterns = arabicGlobPatterns(q);
  if (!patterns.length) return c.json({ chats: [], outputs: [], kb: { articles: [], documents: [] }, mode: 'empty' });

  const wants = (s: string) => scope === 'all' || scope === s;
  /* شرطُ القضية ومعامِله معاً — فلا يفترقان عند البناء.
     والشرط على `conversations` وهي مضمومةٌ في الاستعلامين، والمخرجاتُ تتبع
     محادثتها فتُحصر بحصرها. */
  const folderCond = folder ? ' AND c.folder_id = ?' : '';
  const folderArg = folder ? [folder] : [];

  // ── المحادثات ──
  let chats: unknown[] = [];
  if (wants('chats')) {
    const rows = await c.env.DB.prepare(
      `SELECT c.id AS conversation_id, c.title, m.id AS message_id, m.role, m.created_at,
              ${snippetExpr('m.content')} AS snippet
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.user_id = ? AND ${globCondition('m.content', patterns)}${folderCond}
       ORDER BY m.created_at DESC LIMIT ?`
    )
      .bind(user.id, q, ...patterns, ...folderArg, LIMIT)
      .all();
    chats = rows.results ?? [];
  }

  // ── المخرجات: نُسخ المسودّات المحفوظة ──
  let outputs: unknown[] = [];
  if (wants('outputs')) {
    const rows = await c.env.DB.prepare(
      `SELECT d.id, d.message_id, d.version, d.note, d.created_at,
              c.id AS conversation_id, c.title,
              ${snippetExpr('d.content')} AS snippet
       FROM draft_versions d
       JOIN messages m ON m.id = d.message_id
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.user_id = ? AND ${globCondition('d.content', patterns)}${folderCond}
       ORDER BY d.created_at DESC LIMIT ?`
    )
      .bind(user.id, q, ...patterns, ...folderArg, LIMIT)
      .all();
    outputs = rows.results ?? [];
  }

  // ── قاعدة المعرفة ──
  let articles: unknown[] = [];
  let documents: unknown[] = [];
  if (wants('kb')) {
    // المقاطع المستوردة: فهرسٌ لفظيّ مطبَّع عربياً — والتصفية على السريان
    // فيه كما في كل مسار، فلا يُعرض للمستخدم نصٌّ منسوخ.
    try {
      articles = await searchLegal(c.env, q, { limit: LIMIT, lexicalOnly: true });
    } catch {
      articles = [];
    }
    // الوثائق المرفوعة: بالعنوان — نصُّها في R2 لا في القاعدة فلا يُبحث فيه.
    const rows = await c.env.DB.prepare(
      `SELECT id, title, category, source_authority, status
       FROM kb_documents
       WHERE ${globCondition('title', patterns)} AND (status IS NULL OR status != 'repealed')
       ORDER BY created_at DESC LIMIT ?`
    )
      .bind(...patterns, LIMIT)
      .all();
    documents = rows.results ?? [];
  }

  return c.json({ chats, outputs, kb: { articles, documents }, mode: 'lexical' });
});

export default app;
