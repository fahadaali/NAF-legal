// المحرّك الطبقي — استرجاعٌ بالمسائل والطبقات بدل قائمةٍ واحدة من أشبه المقاطع.
//
// القضية الموضوعية تستند إلى الموضوعيّ الخاص، والإجرائيّ، والإثبات، والأحكام العامة،
// واللائحة. والبحث بالتشابه وحده يجد الأول ويفوته الباقي، لأن نصوصها لا تشبه
// السؤال. فيبحث هذا المحرّك:
//
//   ١) لكل مسألةٍ من شجرة المُخطِّط، باستعلاماتها، بحثاً عامّاً وبحثاً محصوراً في كل
//      نظامٍ سُمّي لها أو سمّته خريطةُ الإسناد لطبقتها — فلا تزاحم موادَّ نظامٍ موادُّ
//      غيره.
//   ٢) للموادّ التي ذكرها المحامي بأرقامها: تُجلب بعينها.
//   ٣) لكل نظامٍ «مطلوبٍ» في الخريطة المعتمدة لم يرجع منه شيء: يُبحث فيه بسؤال
//      المحامي نفسه، فلا تخلو طبقةٌ مطلوبة.
//   ٤) قفزةً واحدة في الإحالات (`legal_article_links`) من الموادّ المختارة، ومادةَ
//      التعريفات في النظام الأول.
//
// والسياق يُرتَّب تحت المسائل لا قائمةً مسطّحة، والتصفيةُ على السريان في `searchLegal`
// كما هي — لا يدخل من هنا ما لا يدخل من غيره.
import {
  searchLegal,
  getArticle,
  getHitsBySeqs,
  getDefinitionsArticle,
  articleBaseId,
  type LegalHit,
} from '../legal';
import { embedBatch } from '../embed';
import { fromLegalHit, joinArticleParts, formatRagBlock, wrapRagContext, type RagResult } from '../rag';
import { knownLaws, resolveNamed, type KnownLaw } from './links';
import type { RetrievalTrace } from './trace';
import type { Env, GroundingLayer, PlannerIssue, PlannerOutput } from '../../types';

export const LAYER_LABELS: Record<GroundingLayer, string> = {
  substantive: 'موضوعي',
  procedural: 'إجرائي',
  evidence: 'إثبات',
  general: 'أحكام عامة',
  regulation: 'لائحة تنفيذية',
};

/** موادُّ المسألة الواحدة في السياق. */
export const PER_ISSUE = 5;
/** سقف السياق كلِّه. */
export const TOTAL_MAX = 40;
const UNSCOPED_LIMIT = 8;
const SCOPED_LIMIT = 4;
/** أنظمةٌ يُحصر فيها بحث المسألة الواحدة. */
const SCOPED_LAWS_MAX = 3;
const COVERAGE_PER_LAW = 2;
const LINKS_MAX = 8;
const RRF_K = 60;

/**
 * ألفاظُ الطبقة العامة — تُضمّ إلى سؤال المحامي حين يُستكمل نظامٌ مطلوب.
 *
 * سؤالٌ عن فصلٍ تعسّفي لا يشترك في لفظٍ واحد مع مادةٍ في نظام الإثبات، فبحثٌ في
 * النظام بالسؤال وحده يرجع فارغاً. وهذه ألفاظُ موضوع الطبقة لا ألفاظُ نظامٍ بعينه.
 */
const LAYER_TERMS: Record<GroundingLayer, string> = {
  substantive: '',
  procedural: 'الاختصاص رفع الدعوى المواعيد الاعتراض صحيفة الدعوى',
  evidence: 'الإثبات عبء الإثبات البينة المدعي المدعى عليه الشهادة الكتابة',
  general: 'الالتزام العقد التعويض الضرر الخطأ',
  regulation: '',
};

/** `memo`: موادُّ مذكرة البحث في دورٍ سابق، تُعاد في سؤال المتابعة. */
export type GroupKind = 'issue' | 'explicit' | 'coverage' | 'linked' | 'definitions' | 'memo';

export interface ResearchGroup {
  kind: GroupKind;
  title: string;
  layer?: GroundingLayer;
  results: RagResult[];
}

/** ما لم يُوجد له سند — يُقال للمحامي ولا يُملأ. */
export interface ResearchGap {
  kind: 'issue' | 'layer' | 'explicit';
  title: string;
  layer?: GroundingLayer;
}

export interface LayeredResult {
  groups: ResearchGroup[];
  gaps: ResearchGap[];
  /** الموادّ كلُّها بترتيبها في السياق، بلا تكرار. */
  results: RagResult[];
}

interface Item {
  hit: LegalHit;
  result: RagResult;
}

const keyOf = (h: LegalHit) => `legal:${articleBaseId(h.id)}`;

/** دمجُ قوائم بالرتب على مفتاح المادة — كدمج `retrieve` و`fuse`. */
function fuseLists(lists: LegalHit[][], limit: number): Item[] {
  const merged = new Map<string, { hit: LegalHit; score: number }>();
  for (const list of lists) {
    joinArticleParts(list).forEach((hit, rank) => {
      const k = keyOf(hit);
      const cur = merged.get(k);
      if (cur) cur.score += 1 / (RRF_K + rank);
      else merged.set(k, { hit, score: 1 / (RRF_K + rank) });
    });
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ hit, score }) => ({ hit, result: { ...fromLegalHit(hit), score } }));
}

/** مداخلُ الخريطة المعتمدة للمجال. جدولٌ لم يُهيّأ = لا مداخل. */
async function approvedMap(
  env: Env,
  domain: string
): Promise<{ layer: GroundingLayer; law_title: string; required: number }[]> {
  try {
    const rows = await env.DB.prepare(
      "SELECT layer, law_title, required FROM grounding_map WHERE domain = ? AND status = 'approved'"
    )
      .bind(domain)
      .all<{ layer: GroundingLayer; law_title: string; required: number }>();
    return rows.results ?? [];
  } catch {
    return [];
  }
}

export interface LayeredInput {
  plan: PlannerOutput;
  message: string;
  issues: PlannerIssue[];
  perIssue?: number;
  trace?: RetrievalTrace;
}

export async function layeredRetrieve(env: Env, input: LayeredInput): Promise<LayeredResult> {
  const { plan, message, issues, trace } = input;
  const perIssue = input.perIssue ?? PER_ISSUE;
  const signal = (q: string) => (trace ? (s: { stage: string; count?: number; error?: string }) => trace.add({ ...s, query: q }) : undefined);

  // ── الأنظمة: المسمّاة في الخطة، والمعتمدة في الخريطة ──
  const laws: KnownLaw[] = await knownLaws(env).catch(() => []);
  const resolve = (title: string) => resolveNamed(title, laws);
  const lawTitle = new Map(laws.map((l) => [l.lawId, l.titleNorm]));
  const map = await approvedMap(env, plan.domain);
  const layerLaws = new Map<GroundingLayer, string[]>();
  for (const e of map) {
    const id = resolve(e.law_title);
    if (!id) {
      trace?.add({ stage: 'map-unresolved', detail: e.law_title });
      continue;
    }
    layerLaws.set(e.layer, [...(layerLaws.get(e.layer) ?? []), id]);
  }

  // ── متجهات الاستعلامات دفعةً واحدة ──
  const allQueries = [...new Set(issues.flatMap((i) => i.queries))];
  const vectors = new Map<string, number[]>();
  if (env.VECTORIZE && allQueries.length) {
    try {
      const vs = await embedBatch(env, allQueries);
      allQueries.forEach((q, i) => vectors.set(q, vs[i]));
    } catch (e) {
      trace?.fail('embed', e);
    }
  }

  // ── ١) المسائل ──
  const issueGroups = await Promise.all(
    issues.map(async (issue): Promise<{ issue: PlannerIssue; items: Item[] }> => {
      const scoped = [
        ...new Set([
          ...issue.laws.map(resolve).filter((x): x is string => !!x),
          ...(layerLaws.get(issue.layer) ?? []),
        ]),
      ].slice(0, SCOPED_LAWS_MAX);
      const lists = await Promise.all(
        issue.queries.flatMap((q) => [
          searchLegal(env, q, { limit: UNSCOPED_LIMIT, queryVector: vectors.get(q), onSignal: signal(q) }).catch((e) => {
            trace?.fail('legal', e, q);
            return [] as LegalHit[];
          }),
          // المحصورُ لفظيٌّ وحده: الفهرس المتجهي يُرجع أقرب الموادّ في القاعدة كلِّها،
          // والحصرُ بعده في SQL يُسقط أكثرها — نداءٌ بلا حصيلة.
          ...scoped.map((lawId) =>
            searchLegal(env, q, { lawId, limit: SCOPED_LIMIT, lexicalOnly: true }).catch(() => [] as LegalHit[])
          ),
        ])
      );
      const items = fuseLists(lists, perIssue);
      trace?.add({ stage: 'issue', detail: `${issue.layer}: ${issue.title}`, count: items.length });
      return { issue, items };
    })
  );

  // ── ٢) الموادّ المذكورة بأرقامها ──
  const explicit: Item[] = [];
  const unresolvedExplicit: string[] = [];
  for (const a of plan.explicit_articles ?? []) {
    const lawId = resolve(a.law);
    const hits = lawId ? joinArticleParts(await getArticle(env, { lawId, articleNo: a.article }).catch(() => [])) : [];
    if (!hits.length) {
      // نظامٌ لا يُعرف، أو مادةٌ لا توجد فيه أو ليست نافذة — تُقال ولا تُخمَّن.
      unresolvedExplicit.push(`${a.law} — المادة ${a.article}`);
      trace?.add({ stage: 'explicit-unresolved', detail: `${a.law} ${a.article}` });
      continue;
    }
    explicit.push(...hits.slice(0, 2).map((hit) => ({ hit, result: fromLegalHit(hit) })));
  }
  trace?.add({ stage: 'explicit', count: explicit.length });

  // ── ٣) استكمال الطبقات المطلوبة ──
  const present = new Set([...explicit, ...issueGroups.flatMap((g) => g.items)].map((i) => i.hit.lawId));
  const mustCover: { lawId: string; layer: GroundingLayer }[] = [];
  for (const e of map.filter((m) => m.required)) {
    const id = resolve(e.law_title);
    if (id && !present.has(id) && !mustCover.some((m) => m.lawId === id)) mustCover.push({ lawId: id, layer: e.layer });
  }
  // وما سمّاه المُخطِّط في `target_regulations` ولم يرجع منه شيء — بلا خريطةٍ معتمدة
  // هو ما يقول إن القضية تقوم على نظامٍ لم يظهر.
  for (const t of plan.target_regulations ?? []) {
    const id = resolve(t);
    if (id && !present.has(id) && !mustCover.some((m) => m.lawId === id)) mustCover.push({ lawId: id, layer: 'substantive' });
  }
  const coverageQuery = [message.slice(0, 400), ...issues.map((i) => i.title)].join(' ').slice(0, 600);
  const coverage = await Promise.all(
    mustCover.slice(0, 4).map(async (m) => {
      // هجينٌ لا لفظيٌّ وحده: نداءاتُه أربعةٌ سقفاً، والدلاليّ يجد ما لا يشترك في لفظ.
      const q = `${LAYER_TERMS[m.layer]} ${coverageQuery}`.trim();
      const hits = await searchLegal(env, q, { lawId: m.lawId, limit: COVERAGE_PER_LAW }).catch(() => [] as LegalHit[]);
      trace?.add({ stage: 'coverage', detail: `${m.layer}: ${m.lawId}`, count: hits.length });
      return { ...m, items: joinArticleParts(hits).map((hit) => ({ hit, result: fromLegalHit(hit) })) };
    })
  );

  // ── ٤) الإحالات قفزةً واحدة، والتعريفات ──
  const chosen = [...explicit, ...issueGroups.flatMap((g) => g.items), ...coverage.flatMap((c) => c.items)];
  const chosenKeys = new Set(chosen.map((i) => keyOf(i.hit)));
  let linked: Item[] = [];
  const fromSeqs = chosen.slice(0, 30).map((i) => i.hit.seq);
  if (fromSeqs.length) {
    try {
      const rows = await env.DB.prepare(
        `SELECT DISTINCT to_seq FROM legal_article_links
         WHERE from_seq IN (${fromSeqs.map(() => '?').join(',')}) AND to_seq IS NOT NULL`
      )
        .bind(...fromSeqs)
        .all<{ to_seq: number }>();
      const targets = (rows.results ?? []).map((r) => r.to_seq);
      const hits = joinArticleParts(await getHitsBySeqs(env, targets));
      linked = hits
        .filter((h) => !chosenKeys.has(keyOf(h)))
        .slice(0, LINKS_MAX)
        .map((hit) => ({ hit, result: fromLegalHit(hit) }));
      trace?.add({ stage: 'linked', count: linked.length });
    } catch (e) {
      trace?.fail('linked', e);
    }
  }
  let definitions: Item[] = [];
  const primaryLaw = issueGroups.find((g) => g.issue.layer === 'substantive' && g.items.length)?.items[0]?.hit.lawId;
  if (primaryLaw) {
    const def = await getDefinitionsArticle(env, primaryLaw).catch(() => null);
    if (def && !chosenKeys.has(keyOf(def))) definitions = [{ hit: def, result: fromLegalHit(def) }];
  }

  // ── التجميع بلا تكرار، بسقفٍ واحد ──
  const seen = new Set<string>();
  let budget = TOTAL_MAX;
  const take = (items: Item[]): RagResult[] => {
    const out: RagResult[] = [];
    for (const i of items) {
      const k = i.result.key ?? keyOf(i.hit);
      if (seen.has(k) || budget <= 0) continue;
      seen.add(k);
      budget--;
      out.push(i.result);
    }
    return out;
  };
  const groups: ResearchGroup[] = [];
  const push = (g: ResearchGroup) => g.results.length && groups.push(g);
  push({ kind: 'explicit', title: 'موادّ ذكرها المحامي', results: take(explicit) });
  for (const g of issueGroups) push({ kind: 'issue', title: g.issue.title, layer: g.issue.layer, results: take(g.items) });
  for (const c of coverage) {
    push({
      kind: 'coverage',
      title: `${LAYER_LABELS[c.layer]}: ${lawTitle.get(c.lawId) ?? c.lawId}`,
      layer: c.layer,
      results: take(c.items),
    });
  }
  push({ kind: 'linked', title: 'موادّ تحيل إليها الموادّ أعلاه', results: take(linked) });
  push({ kind: 'definitions', title: 'تعريفات النظام', results: take(definitions) });

  const results = groups.flatMap((g) => g.results);
  trace?.add({ stage: 'result', count: results.length });

  const gaps: ResearchGap[] = [
    ...issueGroups.filter((g) => !g.items.length).map((g) => ({ kind: 'issue' as const, title: g.issue.title, layer: g.issue.layer })),
    ...coverage
      .filter((c) => !c.items.length)
      .map((c) => ({ kind: 'layer' as const, title: lawTitle.get(c.lawId) ?? c.lawId, layer: c.layer })),
    ...unresolvedExplicit.map((t) => ({ kind: 'explicit' as const, title: t })),
  ];
  return { groups, gaps, results };
}

/** عنوانُ المجموعة في السياق. */
function groupHeading(g: ResearchGroup): string {
  switch (g.kind) {
    case 'issue':
      return `المسألة: ${g.title}${g.layer ? ` (${LAYER_LABELS[g.layer]})` : ''}`;
    case 'coverage':
      return `استكمال طبقة ${g.title}`;
    default:
      return g.title;
  }
}

/**
 * السياق مرتّباً تحت المسائل، بترقيمٍ متّصل — فالمادة الواحدة رقمٌ واحد مهما
 * تكرّر الاستشهاد بها، والعناوين تقول لماذا جاءت.
 */
export function formatLayeredContext(groups: ResearchGroup[]): string {
  if (!groups.some((g) => g.results.length)) return '';
  let n = 0;
  const sections = groups
    .filter((g) => g.results.length)
    .map((g) => `### ${groupHeading(g)}\n\n${g.results.map((r) => formatRagBlock(r, ++n)).join('\n\n---\n\n')}`);
  return wrapRagContext(sections.join('\n\n'));
}
