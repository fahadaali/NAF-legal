// جمعُ السياق النظاميّ لدورٍ واحد — من الخطة إلى المواد المسترجعة.
//
// موضعٌ واحد يمرّ به دور المحادثة ومسارُ القياس (`routes/eval.ts`) معاً: ما يُقاس
// هو ما يجري فعلاً، لا نسخةٌ منه تفترق عنه بأوّل تعديل.
import { retrieve, type RagResult } from '../rag';
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
  /** مواضع الاستدلال — تُملأ في «الاستدلال النظامي» وحده. */
  anchors: BasisAnchor[];
  queries: string[];
}

export async function gatherLegalContext(env: Env, input: GatherInput): Promise<Gathered> {
  const { plan, message, trace } = input;
  if (!plan.needs_knowledge_base) {
    trace?.add({ stage: 'skipped', detail: 'needs_knowledge_base=false' });
    return { results: [], anchors: [], queries: [] };
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
  return { results, anchors, queries };
}
