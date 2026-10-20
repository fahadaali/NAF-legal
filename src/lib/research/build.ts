// بناءُ مذكرة البحث لسؤالٍ — من الخطة إلى المذكرة المحفوظة.
//
// موضعٌ واحد يمرّ به المسار المتزامن (`POST /api/research/:id`) والبحثُ في الخلفية
// (`ResearchRunner`): ما يُبنى هنا هو ما يُبنى هناك.
import { runPlanner } from '../planner';
import { gatherLegalContext } from './gather';
import { deepResearch } from './agent';
import { newTrace, saveTrace, type RetrievalTrace } from './trace';
import { memoGroups, saveMemo } from './memo';
import type { ResearchGroup } from './layered';
import type { ConsultationType, Env, PlannerOutput } from '../../types';

export interface BuildInput {
  conversationId: string;
  userId: string;
  message: string;
  consultationType?: ConsultationType;
  attachmentIds?: string[];
  deep?: boolean;
  /** يُنادى بعد كل مرحلة وكل جولة بحثٍ معمّق — لتقدّم المهمّة في الخلفية. */
  onProgress?: (stage: string, trace: RetrievalTrace) => Promise<void>;
}

export async function buildResearchMemo(env: Env, input: BuildInput): Promise<{ memoId: string; plan: PlannerOutput }> {
  const ids = (input.attachmentIds ?? []).slice(0, 10);
  const atts = ids.length
    ? await env.DB.prepare(
        `SELECT parsed_text FROM attachments WHERE conversation_id = ? AND id IN (${ids.map(() => '?').join(',')})
         AND parsed_text IS NOT NULL`
      )
        .bind(input.conversationId, ...ids)
        .all<{ parsed_text: string }>()
    : { results: [] as { parsed_text: string }[] };

  const trace = newTrace();
  const plan = await runPlanner(env, input.message, input.consultationType, ids.length > 0, false, input.userId);
  trace.add({ stage: 'planner', count: plan.issues.length, detail: plan.consultation_type });
  await input.onProgress?.('planned', trace);

  const gathered = await gatherLegalContext(env, {
    plan,
    message: input.message,
    attachmentsText: (atts.results ?? []).map((a) => a.parsed_text),
    userId: input.userId,
    trace,
  });
  await input.onProgress?.('retrieved', trace);

  let groups: ResearchGroup[] = gathered.groups.length
    ? gathered.groups
    : gathered.results.length
      ? [{ kind: 'issue', title: 'نتائج البحث', results: gathered.results }]
      : [];
  let gaps = gathered.gaps;
  if (input.deep) {
    // البحث المعمّق: Claude يُكمل المذكرة بأدوات البحث في القاعدة نفسها.
    const deep = await deepResearch(env, {
      message: input.message,
      plan,
      groups,
      userId: input.userId,
      trace,
      onRound: (round) => input.onProgress?.(`round:${round}`, trace) ?? Promise.resolve(),
    });
    groups = [...groups, ...deep.groups];
    gaps = [...gaps, ...deep.gaps];
  }

  const memoId = await saveMemo(env, {
    conversationId: input.conversationId,
    messageId: null,
    groups: memoGroups(groups),
    gaps,
    status: 'draft',
  });
  await saveTrace(env, {
    conversationId: input.conversationId,
    messageId: null,
    userId: input.userId,
    plan,
    trace,
    resultKeys: groups.flatMap((g) => g.results.map((r) => r.key ?? r.documentId)),
  });
  return { memoId, plan };
}
