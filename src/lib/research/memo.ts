// مذكرة البحث — المسائل وموادّها وما لا سند له، محفوظةً للمحادثة.
//
// تُحفظ بمفاتيح الموادّ لا بنصوصها: حين تُستعاد في دورٍ لاحق تُجلب الموادّ من
// القاعدة بنصّها الجاري وبالتصفية على السريان نفسها — فمادةٌ أُلغيت بعد بناء المذكرة
// لا تعود منها، ومادةٌ عُدِّلت تعود بنصّها الجديد.
import { getHitsBySeqs } from '../legal';
import { fromLegalHit, joinArticleParts } from '../rag';
import { getDocumentChunks } from './documents';
import type { ResearchGap, ResearchGroup, GroupKind } from './layered';
import type { Env, GroundingLayer } from '../../types';

export interface MemoItem {
  key: string;
  seq: number | null;
  /** «نظام العمل — المادة 77» — للعرض والمراجعة. */
  title: string;
}

export interface MemoGroup {
  kind: GroupKind;
  title: string;
  layer: GroundingLayer | null;
  items: MemoItem[];
}

export type MemoStatus = 'auto' | 'draft' | 'approved';

export interface Memo {
  id: string;
  conversation_id: string;
  message_id: string | null;
  version: number;
  groups: MemoGroup[];
  gaps: ResearchGap[];
  status: MemoStatus;
  approved_by: string | null;
  approved_at: number | null;
  created_at: number;
}

/** المجموعات كما رتّبها المحرّك إلى صيغة المذكرة. */
export function memoGroups(groups: ResearchGroup[]): MemoGroup[] {
  return groups
    .filter((g) => g.results.length)
    .map((g) => ({
      kind: g.kind,
      title: g.title,
      layer: g.layer ?? null,
      items: g.results.map((r) => ({
        key: r.key ?? r.documentId,
        seq: r.seq ?? null,
        title: [r.title, r.articleRef].filter(Boolean).join(' — '),
      })),
    }));
}

export async function saveMemo(
  env: Env,
  m: {
    conversationId: string;
    messageId: string | null;
    groups: MemoGroup[];
    gaps: ResearchGap[];
    status?: MemoStatus;
    version?: number;
  }
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO research_memos (id, conversation_id, message_id, version, groups_json, gaps_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      m.conversationId,
      m.messageId,
      m.version ?? 1,
      JSON.stringify(m.groups),
      JSON.stringify(m.gaps),
      m.status ?? 'auto',
      Date.now()
    )
    .run();
  return id;
}

function parseRow(r: Record<string, any>): Memo {
  return {
    id: r.id,
    conversation_id: r.conversation_id,
    message_id: r.message_id ?? null,
    version: r.version,
    groups: JSON.parse(r.groups_json),
    gaps: JSON.parse(r.gaps_json ?? '[]'),
    status: r.status,
    approved_by: r.approved_by ?? null,
    approved_at: r.approved_at ?? null,
    created_at: r.created_at,
  };
}

/** آخر مذكرةٍ في المحادثة. جدولٌ لم يُهيّأ = لا مذكرة. */
export async function latestMemo(env: Env, conversationId: string): Promise<Memo | null> {
  try {
    const r = await env.DB.prepare(
      'SELECT * FROM research_memos WHERE conversation_id = ? ORDER BY created_at DESC, version DESC LIMIT 1'
    )
      .bind(conversationId)
      .first<Record<string, any>>();
    return r ? parseRow(r) : null;
  } catch {
    return null;
  }
}

/** مذكرةٌ بمعرّفها — لصاحب محادثتها وحده. */
export async function getOwnedMemo(env: Env, id: string, userId: string): Promise<Memo | null> {
  const r = await env.DB.prepare(
    `SELECT m.* FROM research_memos m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.id = ? AND c.user_id = ?`
  )
    .bind(id, userId)
    .first<Record<string, any>>();
  return r ? parseRow(r) : null;
}

/**
 * مجموعاتُ المذكرة بموادّها من القاعدة — بنصّها الجاري، بلا ما في `exclude`،
 * و`max` سقفاً. وما لم يعد نافذاً يسقط بالتصفية ويُعدّ في `dropped`.
 */
export async function hydrateMemo(
  env: Env,
  memo: Memo,
  opts: { exclude?: Set<string>; max?: number; titlePrefix?: string; kind?: GroupKind } = {}
): Promise<{ groups: ResearchGroup[]; dropped: number }> {
  const exclude = opts.exclude ?? new Set<string>();
  let budget = opts.max ?? 60;
  const items = memo.groups.flatMap((g) => g.items).filter((i) => !exclude.has(i.key));
  const wanted = items.filter((i) => i.seq != null);
  const hits = joinArticleParts(await getHitsBySeqs(env, wanted.map((i) => i.seq!)));
  const bySeq = new Map(hits.map((h) => [h.seq, fromLegalHit(h)]));
  // ومقاطعُ الوثائق المرفوعة بمعرّفاتها — من وثائق ما زالت سارية.
  const docs = await getDocumentChunks(env, items.filter((i) => i.key.startsWith('doc:')).map((i) => i.key));
  const byKey = new Map(docs.map((r) => [r.key!, r]));
  let dropped = 0;
  const seen = new Set(exclude);
  const groups: ResearchGroup[] = [];
  for (const g of memo.groups) {
    const results = [];
    for (const it of g.items) {
      if (seen.has(it.key) || budget <= 0) continue;
      const r = it.seq != null ? bySeq.get(it.seq) : byKey.get(it.key);
      if (!r) {
        dropped++;
        continue;
      }
      seen.add(it.key);
      budget--;
      results.push(r);
    }
    if (results.length) {
      groups.push({
        kind: opts.kind ?? g.kind,
        title: opts.titlePrefix ? `${opts.titlePrefix}${g.title}` : g.title,
        layer: g.layer ?? undefined,
        results,
      });
    }
  }
  return { groups, dropped };
}
