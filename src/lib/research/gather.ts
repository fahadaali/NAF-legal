// جمعُ السياق النظاميّ لدورٍ واحد — من الخطة إلى المواد المسترجعة.
//
// موضعٌ واحد يمرّ به دور المحادثة ومسارُ القياس (`routes/eval.ts`) معاً: ما يُقاس
// هو ما يجري فعلاً، لا نسخةٌ منه تفترق عنه بأوّل تعديل.
import { retrieve, formatRagContext, type RagResult } from '../rag';
import { layeredRetrieve, formatLayeredContext, type ResearchGroup, type ResearchGap } from './layered';
import { extractAnchors, BASIS_PER_ANCHOR, type BasisAnchor } from '../basis';
import type { RetrievalTrace } from './trace';
import type { Env, PlannerOutput } from '../../types';

/** طولُ ما يُؤخذ من سؤال المحامي استعلاماً حين لا يكتب المُخطِّط استعلاماً. */
export const FALLBACK_QUERY_CHARS = 400;

/** سقفُ المقاطع في غير «الاستدلال النظامي». */
export const DEFAULT_TOP_K = 6;

export interface GatherInput {
  plan: PlannerOutput;
  message: string;
  /** نصوصُ مرفقات هذا الدور — مدخلُ «الاستدلال النظامي». */
  attachmentsText?: string[];
  userId?: string;
  trace?: RetrievalTrace;
}

export interface Gathered {
  results: RagResult[];
  /** السياق جاهزاً للبرومبت — مجمّعاً تحت المسائل حين يجري المحرّك الطبقي. */
  context: string;
  /** المجموعات كما رتّبها المحرّك الطبقي — فارغةٌ في المسار القديم. */
  groups: ResearchGroup[];
  /** مسائل وطبقاتٌ لم يُوجد لها سند — في المحرّك الطبقي وحده. */
  gaps: ResearchGap[];
  /** مواضع الاستدلال — تُملأ في «الاستدلال النظامي» وحده. */
  anchors: BasisAnchor[];
  queries: string[];
}

export async function gatherLegalContext(env: Env, input: GatherInput): Promise<Gathered> {
  const { plan, message, trace } = input;
  if (!plan.needs_knowledge_base) {
    trace?.add({ stage: 'skipped', detail: 'needs_knowledge_base=false' });
    return { results: [], context: '', groups: [], gaps: [], anchors: [], queries: [] };
  }

  /* «استدلال نظامي» يمرّ بتمريرتين، وغيرُه بواحدة.
     المستندُ كلُّه مسألتُه — عشرةُ دفوعٍ أو عشرون بنداً — وخمسةُ استعلاماتٍ
     يكتبها المُخطِّط عن الطلب تُغطّي أبرزها وتترك الباقي بلا سند. فتُستخرج
     مواضعُه أولاً ويُبحث لكلٍّ منها. والتفصيل في `lib/basis.ts`. */
  let anchors: BasisAnchor[] = [];
  if (plan.consultation_type === 'legal_basis') {
    const source = [message, ...(input.attachmentsText ?? [])].join('\n\n');
    anchors = await extractAnchors(env, source, input.userId);
    trace?.add({ stage: 'anchors', count: anchors.length });
  }

  /* ══ المحرّك الطبقي ══
     حين يفكّك المُخطِّط الطلب إلى مسائل — أو تُستخرج مواضعُ «الاستدلال النظامي» —
     يُبحث لكل مسألةٍ في طبقتها وأنظمتها، وتُتبع الإحالات، وتُستكمل الطبقات المطلوبة.
     ومواضع الاستدلال مسائلُ موضوعية، لكلٍّ منها أربعُ موادّ. */
  const issues = anchors.length
    ? anchors.map((a) => ({ title: a.claim || a.quote, layer: 'substantive' as const, queries: [a.query], laws: [] }))
    : plan.issues ?? [];
  if (issues.length) {
    const layered = await layeredRetrieve(env, {
      plan,
      message,
      issues,
      perIssue: anchors.length ? BASIS_PER_ANCHOR : undefined,
      trace,
    });
    return {
      results: layered.results,
      context: formatLayeredContext(layered.groups),
      groups: layered.groups,
      gaps: layered.gaps,
      anchors,
      queries: issues.flatMap((i) => i.queries),
    };
  }

  /* وإن لم يكتب المُخطِّط استعلاماً — تعذّر فعاد بخطّته الاحتياطية، أو أغفلها —
     فسؤالُ المحامي نفسه هو الاستعلام. وكان الشرطُ يسقط فيمضي التوليد بلا
     سياقٍ نظاميّ أصلاً، فيكتب النموذج من ذاكرته ولا أثر. */
  const queries = anchors.length
    ? anchors.map((a) => a.query)
    : plan.kb_queries.length
      ? plan.kb_queries
      : [message.slice(0, FALLBACK_QUERY_CHARS)];
  if (!anchors.length && !plan.kb_queries.length) trace?.add({ stage: 'fallback-query' });

  /* «استدلال نظامي»: أربعُ مقاطع **لكلّ موضع** لا أربعٌ في المجموع. كان السقف
     الواحد يقصّ ما دُمج من المواضع كلّها إلى أربع، فتأتي أكثرُ صفوف الجدول بلا
     نصٍّ تستند إليه. */
  const results = anchors.length
    ? await retrieve(env, queries, BASIS_PER_ANCHOR, anchors.length * BASIS_PER_ANCHOR, trace)
    : await retrieve(env, queries, DEFAULT_TOP_K, DEFAULT_TOP_K, trace);
  trace?.add({ stage: 'result', count: results.length });
  return { results, context: formatRagContext(results), groups: [], gaps: [], anchors, queries };
}
