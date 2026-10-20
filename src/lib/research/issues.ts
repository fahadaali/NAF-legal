// قائمة المسائل القانونية ووسمُ الموادّ بها (هجرة 0041).
//
// المسألة — «فسخ العقد للإخلال»، «مواعيد الاعتراض» — تقع في موادّ لا يشترك نصُّها مع
// سؤال المحامي في لفظ. فتُوسم الموادّ مرّةً بمسائلها، ويحدّد المُخطِّط مسألة السؤال من
// القائمة نفسها، فيبحث المحرّك في الموادّ الموسومة بها بعينها.
//
// **ولا يقع شيءٌ من ذلك قبل الاعتماد.** القائمة مسودّةٌ يراجعها المحامون: التوسيم لا
// يجري إلا بالمعتمد، والمُخطِّط لا يُعرض عليه إلا المعتمد، والبحث يشترط الاعتماد.
import { callClaude } from '../claude';
import { logUsage, usageFromRaw } from '../usage';
import type { Env, GroundingLayer } from '../../types';

export interface LegalIssue {
  key: string;
  label: string;
  layer: GroundingLayer;
  domains: string;
  description: string;
}

/** المسائل المعتمدة. جدولٌ لم يُهيّأ = لا مسائل. */
export async function approvedIssues(env: Env): Promise<LegalIssue[]> {
  try {
    const rows = await env.DB.prepare(
      "SELECT key, label, layer, domains, description FROM legal_issue_vocab WHERE status = 'approved' ORDER BY layer, key"
    ).all<LegalIssue>();
    return rows.results ?? [];
  } catch {
    return [];
  }
}

/** موادُّ الطلب الواحد إلى نموذج التوسيم. */
const TAG_BATCH = 20;
/** ما يُقرأ من نصّ المادة — يكفي لمسألتها. */
const TAG_TEXT_CHARS = 1500;
/** مسائلُ المادة الواحدة سقفاً. */
const MAX_ISSUES_PER_ARTICLE = 3;

const PENDING_SQL = `issues_at IS NULL AND retrieval_status <> 'repealed' AND is_repealed = 0`;

export interface TagRunResult {
  tagged: number;
  remaining: number;
  skipped?: string;
}

/**
 * يَسِم ما لم يُوسم من الموادّ بالمسائل المعتمدة — دفعاتٍ يتولّاها `TAGGING_MODEL`
 * بمخرجٍ منظَّم مفاتيحُه من القائمة وحدها، فلا يخترع مسألة.
 */
export async function tagPendingArticles(env: Env, limit = 40): Promise<TagRunResult> {
  const issues = await approvedIssues(env);
  const pendingCount = async () =>
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM legal_chunks WHERE ${PENDING_SQL}`).first<{ n: number }>())?.n ?? 0;
  if (!issues.length) return { tagged: 0, remaining: await pendingCount(), skipped: 'لا مسائل معتمدة بعد' };

  const rows = await env.DB.prepare(
    `SELECT seq, law_title, article_no, article_label, text FROM legal_chunks WHERE ${PENDING_SQL} ORDER BY seq LIMIT ?`
  )
    .bind(limit)
    .all<{ seq: number; law_title: string | null; article_no: string | null; article_label: string | null; text: string }>();
  const pending = rows.results ?? [];
  const keys = issues.map((i) => i.key);
  const vocab = issues.map((i) => `- ${i.key}: ${i.label} — ${i.description}`).join('\n');
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['seq', 'issues'],
          properties: {
            seq: { type: 'integer' },
            issues: { type: 'array', items: { type: 'string', enum: keys } },
          },
        },
      },
    },
  };

  let tagged = 0;
  for (let i = 0; i < pending.length; i += TAG_BATCH) {
    const slice = pending.slice(i, i + TAG_BATCH);
    const articles = slice
      .map(
        (a) =>
          `[${a.seq}] ${a.law_title ?? ''} — ${a.article_no ? `المادة ${a.article_no}` : (a.article_label ?? '')}\n${a.text.slice(0, TAG_TEXT_CHARS)}`
      )
      .join('\n\n');
    const { text, raw } = await callClaude(env, {
      model: env.TAGGING_MODEL,
      system:
        `تَسِم موادَّ الأنظمة السعودية بالمسائل القانونية التي تحكمها، من هذه القائمة وحدها:\n${vocab}\n\n` +
        `لكل مادةٍ (برقمها بين معقوفين) من صفرٍ إلى ${MAX_ISSUES_PER_ARTICLE} مسائل: ما تحكمه المادةُ حكماً لا ما تذكره عرضاً. ` +
        'مادةُ التعريفات والديباجة والمادة الإجرائية الشكلية بلا مسألةٍ من القائمة: مصفوفة فارغة.',
      messages: [{ role: 'user', content: articles }],
      effort: 'low',
      max_tokens: 8192,
      format: schema,
    });
    await logUsage(env, { kind: 'tagging', model: env.TAGGING_MODEL, ...usageFromRaw(raw) });
    const out = JSON.parse(text) as { items: { seq: number; issues: string[] }[] };
    const valid = new Set(slice.map((a) => a.seq));
    const now = Date.now();
    const stmts: D1PreparedStatement[] = [];
    for (const it of out.items ?? []) {
      if (!valid.has(it.seq)) continue;
      for (const k of [...new Set(it.issues)].filter((k) => keys.includes(k)).slice(0, MAX_ISSUES_PER_ARTICLE)) {
        stmts.push(env.DB.prepare('INSERT OR IGNORE INTO legal_article_issues (seq, issue_key) VALUES (?, ?)').bind(it.seq, k));
      }
    }
    // المادة تُعدّ موسومةً وإن لم تُصب مسألة — وإلا عادت إلى الطابور في كل نبضة.
    for (const a of slice) stmts.push(env.DB.prepare('UPDATE legal_chunks SET issues_at = ? WHERE seq = ?').bind(now, a.seq));
    await env.DB.batch(stmts);
    tagged += slice.length;
  }
  return { tagged, remaining: await pendingCount() };
}

/** يعيد الموادّ كلَّها إلى الطابور — متى تغيّرت القائمة المعتمدة. */
export async function retagAll(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM legal_article_issues'),
    env.DB.prepare('UPDATE legal_chunks SET issues_at = NULL WHERE issues_at IS NOT NULL'),
  ]);
}
