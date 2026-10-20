// البحث المعمّق — Claude باحثاً بأدوات، لا قارئاً لما اختير له.
//
// المحرّك الطبقي يبني مذكرةً أولى بقواعد ثابتة. ثم يُعطى Claude المذكرة وأدواتٍ
// يبحث بها في قاعدة الأنظمة نفسها: يبحث بعبارة (محصورةً في نظامٍ أو لا)، ويجلب مادةً
// بعينها، ويتتبّع إحالات مادة — ثم يقول ما يُضاف إلى المذكرة وما بقي بلا سند.
//
// **ولا يضيف إلا ما رجع إليه من الأدوات.** المفاتيح التي يعيدها في `finish_research`
// تُقابَل بما رأى فعلاً، فمفتاحٌ يخترعه لا يدخل. والأدوات تمرّ بـ`searchLegal`
// و`getArticle` وتصفيتهما على السريان — لا يرى ملغى ولا محجوباً.
//
// وحلقةٌ غير متدفّقة: كل جولةٍ ردٌّ كامل يُعاد بكتله كما هي (ومنها كتل التفكير التي
// يشترط النموذج إعادتها بلا تعديل)، ثم نتائجُ الأدوات في رسالةٍ واحدة.
import { callClaude } from '../claude';
import { logUsage, usageFromRaw } from '../usage';
import { searchLegal, getArticle, getHitsBySeqs, type LegalHit } from '../legal';
import { fromLegalHit, joinArticleParts, citationLine, noticeLines, type RagResult } from '../rag';
import { knownLaws, resolveNamed } from './links';
import type { ResearchGap, ResearchGroup } from './layered';
import type { RetrievalTrace } from './trace';
import type { Env, PlannerOutput } from '../../types';

/** جولاتٌ سقفاً — كل جولةٍ نداءُ نموذج. */
const MAX_ROUNDS = 6;
/** نتائجُ الأداة الواحدة. */
const TOOL_RESULTS = 6;
/** ما يضيفه البحث المعمّق إلى المذكرة سقفاً. */
const ADD_MAX = 15;

const str = { type: 'string' };

const TOOLS = [
  {
    name: 'search_laws',
    description:
      'يبحث في قاعدة الأنظمة واللوائح السعودية النافذة بعبارةٍ بألفاظ النصوص النظامية. ' +
      'law اختياري: الاسم الرسمي الكامل لنظامٍ يُحصر فيه البحث (ويشمل لائحته). ' +
      'يعيد الموادّ بنصوصها، ولكل مادةٍ مفتاحٌ في source يُستعمل في get_related وfinish_research.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['query', 'law'],
      properties: { query: str, law: { type: ['string', 'null'] } },
    },
  },
  {
    name: 'get_article',
    description: 'يجلب مادةً بعينها: الاسم الرسمي الكامل للنظام ورقم المادة.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['law', 'article'],
      properties: { law: str, article: str },
    },
  },
  {
    name: 'get_related',
    description: 'يجلب الموادّ التي تحيل إليها مادةٌ (بمفتاحها من source) — في نظامها أو في غيره أو في لائحتها.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['key'],
      properties: { key: str },
    },
  },
  {
    name: 'finish_research',
    description:
      'يُنهي البحث. add: مفاتيح الموادّ (من source في نتائج الأدوات) التي تُضاف إلى المذكرة لأن المسألة تقوم عليها. ' +
      'gaps: مسائل بحثتَ عنها ولم تجد لها سنداً في القاعدة، بعنوانٍ موجز وسببٍ موجز.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['add', 'gaps'],
      properties: {
        add: { type: 'array', items: str },
        gaps: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'reason'],
            properties: { title: str, reason: str },
          },
        },
      },
    },
  },
];

const SYSTEM = `أنت باحثٌ قانونيّ في منصةٍ سعودية. أمامك سؤال المحامي ومذكرةُ بحثٍ أولى بمسائلها وعناوين موادّها.
مهمّتك أن تُكمل المذكرة لا أن تصوغ: ابحث عمّا ينقصها من موادّ تقوم عليها المسألة، ثم أنهِ بـfinish_research.

ابحث قبل أن تحكم بالنقص، وفي كل طبقةٍ تحتاجها القضية:
- الحكم الموضوعي في النظام الخاص بالنزاع.
- الإجرائي: الاختصاص، وشكل الدعوى، والمواعيد، وطرق الاعتراض.
- الإثبات: عبؤه ووسائله.
- الأحكام العامة التي يقوم عليها النظام الخاص.
- اللائحة التنفيذية حيث تفصّل.
وتتبّع إحالات الموادّ المهمّة بـget_related. ولا تُطل: ستُّ جولاتٍ على الأكثر، واستدعِ الأدوات المستقلّة معاً في الجولة الواحدة.

لا تضف في finish_research إلا مفاتيح رأيتها في نتائج الأدوات، ولا مادةً في المذكرة أصلاً. وما بحثتَ عنه فلم تجده فهو فجوة تُذكر، لا مادةٌ تُخمَّن.`;

interface Seen {
  result: RagResult;
}

function asSearchResults(hits: LegalHit[], seen: Map<string, Seen>): any[] {
  return joinArticleParts(hits)
    .slice(0, TOOL_RESULTS)
    .map((h) => {
      const r = fromLegalHit(h);
      seen.set(r.key!, { result: r });
      return {
        type: 'search_result',
        source: r.key,
        title: citationLine(r),
        content: [{ type: 'text', text: `${noticeLines(r)}${r.text}` }],
        // لا صياغة في هذه الحلقة فلا إسناد — والإسناد في الكتل كلِّها أو لا شيء منها.
        citations: { enabled: false },
      };
    });
}

export interface DeepResearchResult {
  groups: ResearchGroup[];
  gaps: ResearchGap[];
  rounds: number;
}

export async function deepResearch(
  env: Env,
  input: { message: string; plan: PlannerOutput; groups: ResearchGroup[]; userId?: string; trace?: RetrievalTrace }
): Promise<DeepResearchResult> {
  const { trace } = input;
  const laws = await knownLaws(env).catch(() => []);
  const seen = new Map<string, Seen>();
  const already = new Set(input.groups.flatMap((g) => g.results.map((r) => r.key ?? r.documentId)));

  const memoSummary = input.groups
    .filter((g) => g.results.length)
    .map((g) => `- ${g.title}: ${g.results.map((r) => `${r.title}${r.articleRef ? ` — ${r.articleRef}` : ''} [${r.key}]`).join('؛ ')}`)
    .join('\n');
  const messages: { role: 'user' | 'assistant'; content: any }[] = [
    {
      role: 'user',
      content: `سؤال المحامي:\n${input.message}\n\nنوع العمل: ${input.plan.consultation_type} · المجال: ${input.plan.domain}\n\nالمذكرة الأولى:\n${memoSummary || '(فارغة — لم يُسترجع شيء)'}`,
    },
  ];

  const run = async (name: string, args: any): Promise<any[] | string> => {
    switch (name) {
      case 'search_laws': {
        const lawId = args.law ? resolveNamed(args.law, laws) : null;
        if (args.law && !lawId) return `لا نظام بهذا الاسم في القاعدة: ${args.law}`;
        const hits = await searchLegal(env, String(args.query ?? ''), {
          limit: TOOL_RESULTS,
          ...(lawId ? { lawId, lexicalOnly: true } : {}),
        });
        trace?.add({ stage: 'agent-search', query: String(args.query ?? ''), detail: args.law ?? undefined, count: hits.length });
        return hits.length ? asSearchResults(hits, seen) : 'لا نتائج لهذه العبارة.';
      }
      case 'get_article': {
        const lawId = resolveNamed(String(args.law ?? ''), laws);
        if (!lawId) return `لا نظام بهذا الاسم في القاعدة: ${args.law}`;
        const hits = await getArticle(env, { lawId, articleNo: String(args.article ?? '') });
        trace?.add({ stage: 'agent-article', detail: `${args.law} ${args.article}`, count: hits.length });
        return hits.length ? asSearchResults(hits, seen) : 'المادة غير موجودة في هذا النظام أو ليست نافذة.';
      }
      case 'get_related': {
        const key = String(args.key ?? '');
        const seq = seen.get(key)?.result.seq ?? input.groups.flatMap((g) => g.results).find((r) => r.key === key)?.seq;
        if (seq == null) return 'مفتاحٌ غير معروف — استعمل مفتاحاً من source في نتيجةٍ سابقة.';
        const rows = await env.DB.prepare(
          'SELECT DISTINCT to_seq FROM legal_article_links WHERE from_seq = ? AND to_seq IS NOT NULL'
        )
          .bind(seq)
          .all<{ to_seq: number }>();
        const hits = await getHitsBySeqs(env, (rows.results ?? []).map((r) => r.to_seq));
        trace?.add({ stage: 'agent-related', detail: key, count: hits.length });
        return hits.length ? asSearchResults(hits, seen) : 'لا إحالات من هذه المادة.';
      }
      default:
        return 'أداةٌ غير معروفة.';
    }
  };

  let finish: { add: string[]; gaps: { title: string; reason: string }[] } | null = null;
  let rounds = 0;
  while (rounds < MAX_ROUNDS && !finish) {
    rounds++;
    const { raw } = await callClaude(env, {
      model: env.ANALYSIS_MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      effort: 'medium',
      max_tokens: 16000,
    });
    await logUsage(env, { userId: input.userId, kind: 'research', model: env.ANALYSIS_MODEL, ...usageFromRaw(raw) });
    const content: any[] = raw?.content ?? [];
    const calls = content.filter((b) => b.type === 'tool_use');
    if (!calls.length) break; // أنهى بلا finish_research — يُعتدّ بما رأى ولا يُضاف شيء.

    messages.push({ role: 'assistant', content });
    const results = await Promise.all(
      calls.map(async (call) => {
        if (call.name === 'finish_research') {
          finish = {
            add: Array.isArray(call.input?.add) ? call.input.add.map(String) : [],
            gaps: Array.isArray(call.input?.gaps) ? call.input.gaps : [],
          };
          return { type: 'tool_result', tool_use_id: call.id, content: 'تم.' };
        }
        try {
          const out = await run(call.name, call.input ?? {});
          return { type: 'tool_result', tool_use_id: call.id, content: typeof out === 'string' ? out : out };
        } catch (e: any) {
          trace?.fail(`agent-${call.name}`, e);
          return { type: 'tool_result', tool_use_id: call.id, content: 'تعذّر تنفيذ الأداة.', is_error: true };
        }
      })
    );
    // النتائج كلُّها في رسالةٍ واحدة — تفريقها يعلّم النموذج ترك الاستدعاء المتوازي.
    messages.push({ role: 'user', content: results });
  }
  trace?.add({ stage: 'agent-rounds', count: rounds });

  const done = finish as { add: string[]; gaps: { title: string; reason: string }[] } | null;
  const added: RagResult[] = [];
  for (const key of done?.add ?? []) {
    const s = seen.get(key);
    // ما لم تُرجعه الأدوات لا يدخل، وما في المذكرة أصلاً لا يتكرّر.
    if (!s || already.has(key) || added.some((r) => r.key === key)) continue;
    added.push(s.result);
    if (added.length >= ADD_MAX) break;
  }
  trace?.add({ stage: 'agent-added', count: added.length });
  return {
    groups: added.length ? [{ kind: 'linked', title: 'موادّ أضافها البحث المعمّق', results: added }] : [],
    gaps: (done?.gaps ?? []).slice(0, 10).map((g) => ({ kind: 'issue' as const, title: `${g.title}: ${g.reason}` })),
    rounds,
  };
}
