// الفحص الشهري لمصادر الأنظمة المستوردة — تقريرُ مشروع الاستيراد في المنصة.
//
// مشروع الاستيراد (nezam) يفحص كل شهر صفحات الأنظمة في مصادرها الرسمية
// (`src/check-updates.js`) ويكتب `report.json`. وهذه الوحدة تستقبله:
//
//   ١) البنود: ما رُصد لكل نظام يُحفظ بنداً مفتوحاً، والتقرير التالي يحدّثه ولا
//      يضاعفه، وما لم يعد يُرصد في فحصٍ كامل يُغلق («لم يعد يُرصد»).
//   ٢) التنبيه على المادة: تعديلٌ حديث صدر لمادةٍ بعينها ولم يُستورد، أو نظامٌ صار
//      لاغياً في مصدره — يُكتب سطراً في `legal_pending_updates`، ويقرؤه كل استرجاع
//      (`HIT_COLUMNS`) فيصل البحثَ والمساعدَ وأداةَ MCP والواجهة سطراً يبدأ
//      بـ«تنبيه:». وهو قرار صاحب المنصة (18 نوفمبر 2026): النصّ الذي عُدِّل في
//      مصدره لا يُعرض نافذاً بلا تنبيه حتى يُستورد تعديله.
//   ٣) الإغلاق بالاستيراد: استيرادُ النظام بسحبٍ بعد يوم الرصد يغلق بنوده ويرفع
//      تنبيهاته (`resolveOnImport` من `upsertLegalChunks`)، وردُّ الدفعة يعيد فتحها
//      (`reopenForBatch`). فالتنبيه لا يبقى بعد أن يُعالَج، ولا يسقط قبله.
//
// **والفحص يقترح ولا يقرّر:** البند لا يغيّر نصّاً ولا حالاً في القاعدة. التنبيه
// وحده ما يراه القارئ، وهو يقول «رُصد ولم يُستورد» لا «عُدِّلت» — والاستبعاد
// بيد المسؤول لما لا يستحقّه (نافذةٌ قديمة لم تُربط بمادة منذ السحب).
//
// العقد: `docs/legal-import.md` §١٥.

import type { Env } from '../types';
import { uuid } from './crypto';
import { normalizeArticleNo } from './arabic';
import { dualDate } from './hijri';

export const UPDATE_CHECK_CONTRACT = 'naf-update-check';
/** أقدمُ إصدارٍ يُقبل: الأوّل بلا أرقام موادّ ولا طرفَي الحالة، فلا يُبنى عليه تنبيه. */
export const MIN_REPORT_VERSION = 2;
/** سقفُ حجم التقرير — نحو 30 كيلوبايت عادةً، ونصفُ ميغابايت أكثرُ مما يحتاجه. */
export const MAX_REPORT_BYTES = 512 * 1024;

/** ما يرصده فحص الصفحات لنظامٍ في القاعدة — ويُغلق بالاستيراد أو بغيابه عن فحصٍ كامل. */
export const PAGE_KINDS = ['amendment', 'status', 'instrument', 'dates', 'count', 'text', 'brief', 'missing'] as const;
/** ما يُشتقّ من بقية التقرير: نظامٌ جديد، ونسخة، وإحلال، وملفُّ جهة. */
export const OTHER_KINDS = ['new_law', 'version', 'replacement', 'external'] as const;
export type FindingKind = (typeof PAGE_KINDS)[number] | (typeof OTHER_KINDS)[number];
const ALL_KINDS = new Set<string>([...PAGE_KINDS, ...OTHER_KINDS]);

export interface ReportWindow {
  article_no?: string | null;
  year?: number | null;
  recent?: boolean | null;
  fresh?: boolean | null;
  text?: string;
}

export interface ReportFinding {
  law_id: string;
  law_name?: string;
  url?: string;
  kind: string;
  level: number;
  detail: string;
  samples?: string[];
  windows?: ReportWindow[];
  from?: string;
  to?: string;
  to_repealed?: boolean;
  baseline?: boolean;
}

export interface UpdateReport {
  contract: string;
  version: number;
  run: string;
  mode: 'full' | 'quick';
  findings: ReportFinding[];
  checked_ids?: string[];
  newLaws?: { name: string; url: string; guid?: string; issued_hijri?: string | null; status?: string | null }[];
  versions?: { name: string; url: string; existing: string; issued_hijri?: string | null }[];
  replacements?: { name: string; url: string; target: string; target_id: string | null }[];
  external?: { changed?: { law_id: string; detail: string; suspect?: boolean }[] };
  summary?: Record<string, unknown>;
}

export class UpdateCheckError extends Error {
  constructor(public code: 'invalid' | 'stale', message: string) {
    super(message);
  }
}

/** ما يُحفظ للبند: مقتطفاتٌ للمسؤول، والتنبيهات ليُعاد بناؤها عند إعادة الفتح. */
interface FindingData {
  url?: string;
  samples?: string[];
  windows?: ReportWindow[];
  from?: string;
  to?: string;
  to_repealed?: boolean;
  baseline?: boolean;
  notices?: { article_no_norm: string; notice: string }[];
}

interface Collected {
  law_id: string;
  law_title: string | null;
  kind: FindingKind;
  level: 1 | 2 | 3;
  detail: string;
  signature: string;
  data: FindingData;
}

// ─────────────────────────── القراءة والتحقق ───────────────────────────

const RUN_RE = /^\d{4}-\d{2}-\d{2}$/;

/** يقرأ التقرير ويرفض ما لا يُبنى عليه — بسببٍ يُقال لا بفشلٍ صامت. */
export function parseReport(text: string): UpdateReport {
  if (text.length > MAX_REPORT_BYTES) throw new UpdateCheckError('invalid', 'التقرير أكبر مما يُقبل — ارفع report.json لا pages.jsonl');
  let r: any;
  try {
    r = JSON.parse(text);
  } catch {
    throw new UpdateCheckError('invalid', 'الملف ليس JSON صالحاً — المطلوب report.json من مجلد الفحص');
  }
  if (!r || r.contract !== UPDATE_CHECK_CONTRACT) {
    throw new UpdateCheckError('invalid', 'الملف ليس تقرير فحص — المطلوب report.json من data/reports/updates/<التاريخ>/');
  }
  if (!Number.isInteger(r.version) || r.version < MIN_REPORT_VERSION) {
    throw new UpdateCheckError('invalid', `إصدار التقرير ${r.version ?? '—'} أقدم من المقبول (${MIN_REPORT_VERSION}) — أعد بناءه بـ check-updates.js --reuse`);
  }
  if (!RUN_RE.test(String(r.run ?? ''))) throw new UpdateCheckError('invalid', 'يوم الفحص (run) مفقود أو بغير صيغة YYYY-MM-DD');
  if (r.mode !== 'full' && r.mode !== 'quick') throw new UpdateCheckError('invalid', 'وضع الفحص (mode) غير معروف');
  if (!Array.isArray(r.findings)) throw new UpdateCheckError('invalid', 'التقرير بلا قائمة بنود (findings)');
  r.findings.forEach((f: any, i: number) => {
    if (!f || typeof f.law_id !== 'string' || !f.law_id) throw new UpdateCheckError('invalid', `البند ${i + 1} بلا معرّف نظام`);
    if (!ALL_KINDS.has(f.kind)) throw new UpdateCheckError('invalid', `البند ${i + 1} بنوعٍ غير معروف: ${f.kind}`);
    if (![1, 2, 3].includes(f.level)) throw new UpdateCheckError('invalid', `البند ${i + 1} بأولويةٍ غير معروفة`);
    if (typeof f.detail !== 'string') throw new UpdateCheckError('invalid', `البند ${i + 1} بلا وصف`);
  });
  return r as UpdateReport;
}

// ─────────────────────────── التنبيهات ───────────────────────────

const AR_DIGITS = (s: string) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));

/**
 * أداة التعديل من نصّ نافذته: «… بموجب المرسوم الملكي رقم (م/100) وتاريخ 1448/4/3هـ»
 * ← «بالمرسوم الملكي رقم (م/100) وتاريخ 1448/4/3هـ». وما لم يُقرأ يُترك ولا يُخمَّن.
 */
export function instrumentOf(text: string): string {
  const m = AR_DIGITS(String(text ?? '')).match(
    /(المرسوم الملكي|الأمر الملكي|قرار مجلس الوزراء)\s+رقم\s*\(\s*([^)]{1,20}?)\s*\)\s*(?:و|ب)?تاريخ\s*(\d{1,4}\s*\/\s*\d{1,2}\s*\/\s*\d{1,4})/
  );
  return m ? `ب${m[1]} رقم (${m[2].replace(/\s+/g, '')}) وتاريخ ${m[3].replace(/\s+/g, '')}هـ` : '';
}

/** تنبيه المادة — يقول ما رُصد ومتى، وما العمل. لا يقول «عُدِّلت» عن نصٍّ لم يُقرأ. */
export function amendmentNotice(run: string, windowText: string): string {
  const by = instrumentOf(windowText);
  return (
    `صدر تعديلٌ على هذه المادة${by ? ` ${by}` : ''} لم يُستورد بعد — رُصد في المصدر الرسمي في ${dualDate(run)}. ` +
    'فالنصّ المعروض قد لا يكون النافذ، ويُرجع إلى المصدر قبل الاستشهاد به.'
  );
}

/** تنبيه النظام كلّه: صار لاغياً في مصدره ولم يُستورد ذلك. */
export function repealNotice(run: string, to: string): string {
  return (
    `رُصد في المصدر الرسمي في ${dualDate(run)} أن حال هذا النظام صارت «${to}»، ولم يُستورد ذلك بعد؛ ` +
    'فلا يُستشهد بموادّه على أنها نافذة قبل الرجوع إلى المصدر.'
  );
}

/**
 * ما يُنبَّه به القارئ من بند — وما سواه للمسؤول وحده.
 *
 * نافذةٌ لها رقم مادة، وهي حديثة (من سنة السحب أو التي قبلها) أو جديدة منذ الفحص
 * السابق وليست قديمة. والقديمةُ كلُّها لا تُنبِّه: غالباً نافذةٌ لم تُربط بمادة منذ
 * السحب (النظام التجاري 467 و473 و483، 1435هـ) — وتنبيهٌ عليها يحذّر من نصٍّ نافذ.
 */
export function noticesFor(kind: string, run: string, data: FindingData): { article_no_norm: string; notice: string }[] {
  if (kind === 'status' && data.to_repealed && data.to) {
    return [{ article_no_norm: '', notice: repealNotice(run, data.to) }];
  }
  if (kind !== 'amendment') return [];
  const out = new Map<string, string>();
  for (const w of data.windows ?? []) {
    if (!w.article_no) continue;
    if (!(w.recent === true || (w.fresh === true && w.recent !== false))) continue;
    const key = normalizeArticleNo(w.article_no);
    if (key && !out.has(key)) out.set(key, amendmentNotice(run, w.text ?? ''));
  }
  return [...out].map(([article_no_norm, notice]) => ({ article_no_norm, notice }));
}

// ─────────────────────────── جمع البنود من التقرير ───────────────────────────

const boeId = (url: string | undefined, guid?: string) => {
  const g = guid || (String(url ?? '').match(/LawDetails\/([0-9a-f-]{36})/i) ?? [])[1];
  return g ? `boe:${g.toLowerCase()}` : null;
};

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const normSig = (s: string) => String(s ?? '').replace(/[ً-ْـ]/g, '').replace(/\s+/g, ' ').trim();

/** بصمة ما رُصد: النوافذ بنصّها للتعديل، وطرفا الحالة لها، والوصف لما سواهما. */
async function signatureOf(kind: string, detail: string, data: FindingData): Promise<string> {
  if (kind === 'amendment' && data.windows?.length) {
    return sha256Hex(data.windows.map((w) => normSig(w.text ?? '')).sort().join('\n'));
  }
  if (kind === 'status') return sha256Hex(`${data.from ?? ''}→${data.to ?? ''}`);
  // «منذ فحص …» تتغيّر بين الشهور والمرصود واحد.
  return sha256Hex(normSig(detail.replace(/^منذ فحص \d{4}-\d{2}-\d{2}: /, '')));
}

async function collect(report: UpdateReport): Promise<Collected[]> {
  const out = new Map<string, Collected>();
  const add = async (c: Omit<Collected, 'signature'>) => {
    const key = `${c.law_id}\u0000${c.kind}`;
    const prev = out.get(key);
    // بندٌ واحد لكل نظامٍ ونوع — والأعلى أولويةً يغلب.
    if (prev && prev.level <= c.level) return;
    out.set(key, { ...c, signature: await signatureOf(c.kind, c.detail, c.data) });
  };

  for (const f of report.findings) {
    const data: FindingData = {
      url: f.url,
      samples: (f.samples ?? []).slice(0, 3),
      windows: (f.windows ?? []).slice(0, 30).map((w) => ({
        article_no: w.article_no ?? null,
        year: w.year ?? null,
        recent: w.recent ?? null,
        fresh: w.fresh ?? null,
        text: String(w.text ?? '').slice(0, 600),
      })),
      from: f.from,
      to: f.to,
      to_repealed: f.to_repealed === true,
      baseline: f.baseline === true,
    };
    await add({
      law_id: f.law_id,
      law_title: f.law_name ?? null,
      kind: f.kind as FindingKind,
      level: f.level as 1 | 2 | 3,
      detail: f.detail,
      data,
    });
  }
  for (const n of report.newLaws ?? []) {
    const id = boeId(n.url, n.guid);
    if (!id) continue;
    await add({
      law_id: id,
      law_title: n.name,
      kind: 'new_law',
      level: 2,
      detail: `في المصدر الرسمي وليس في القاعدة${n.issued_hijri ? ` — صدر ${n.issued_hijri}هـ` : ''}${n.status ? ` · ${n.status}` : ''}`,
      data: { url: n.url },
    });
  }
  for (const v of report.versions ?? []) {
    await add({
      law_id: v.existing,
      law_title: v.name,
      kind: 'version',
      level: 2,
      detail: `نسخةٌ أخرى باسم هذا النظام في المصدر الرسمي${v.issued_hijri ? ` — صدرت ${v.issued_hijri}هـ` : ''}`,
      data: { url: v.url },
    });
  }
  for (const x of report.replacements ?? []) {
    if (!x.target_id) continue;
    await add({
      law_id: x.target_id,
      law_title: x.target,
      kind: 'replacement',
      level: 1,
      detail: `«${x.name}» ينصّ على أنه يحلّ محلّه`,
      data: { url: x.url },
    });
  }
  for (const e of report.external?.changed ?? []) {
    await add({
      law_id: e.law_id,
      law_title: null,
      kind: 'external',
      level: 2,
      detail: `ملفُّ الجهة تغيّر: ${e.detail}${e.suspect ? ' — الحجم نزل إلى العُشر أو أقل، فيُفتح يدوياً قبل الاستخراج' : ''}`,
      data: {},
    });
  }
  return [...out.values()];
}

// ─────────────────────────── الكتابة ───────────────────────────

interface FindingRow {
  id: string;
  law_id: string;
  kind: string;
  level: number;
  state: string;
  signature: string;
  first_run: string;
  data_json: string | null;
}

const parseData = (s: string | null): FindingData => {
  try {
    return s ? (JSON.parse(s) as FindingData) : {};
  } catch {
    return {};
  }
};

function noticeStatements(env: Env, findingId: string, lawId: string, run: string, notices: FindingData['notices']) {
  return [
    env.DB.prepare('DELETE FROM legal_pending_updates WHERE finding_id = ?').bind(findingId),
    ...(notices ?? []).map((n) =>
      env.DB.prepare(
        `INSERT INTO legal_pending_updates (finding_id, law_id, article_no_norm, notice, detected_run)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(findingId, lawId, n.article_no_norm, n.notice, run)
    ),
  ];
}

export interface IngestResult {
  duplicate: boolean;
  check_id: string;
  run: string;
  mode: 'full' | 'quick';
  added: number;
  updated: number;
  resolved: number;
  skipped_dismissed: number;
  notices: number;
}

/**
 * يستقبل التقرير. الملف نفسه مرّةً واحدة؛ والفحص الكامل الأقدم من آخر كاملٍ مرفوع
 * يُرفض — يعيد فتح ما أُغلق بعده. والسريع يضيف ويحدّث ولا يُغلق شيئاً: صفحاته
 * بعضُ الفهرس، فغيابُ بندٍ منه لا يعني أنه عولج.
 */
export async function ingestReport(
  env: Env,
  text: string,
  opts: { actorId?: string; filename?: string } = {}
): Promise<IngestResult> {
  const report = parseReport(text);
  const fileSha = await sha256Hex(text);
  const dup = await env.DB.prepare('SELECT id, run, mode FROM legal_update_checks WHERE file_sha256 = ?')
    .bind(fileSha)
    .first<{ id: string; run: string; mode: 'full' | 'quick' }>();
  if (dup) {
    return { duplicate: true, check_id: dup.id, run: dup.run, mode: dup.mode, added: 0, updated: 0, resolved: 0, skipped_dismissed: 0, notices: 0 };
  }
  if (report.mode === 'full') {
    const latest = await env.DB.prepare(`SELECT MAX(run) AS run FROM legal_update_checks WHERE mode = 'full'`).first<{ run: string | null }>();
    if (latest?.run && report.run < latest.run) {
      throw new UpdateCheckError('stale', `تقريرٌ أقدم من آخر فحصٍ كامل مرفوع (${latest.run}) — لا يُرفع فوقه`);
    }
  }

  const now = Date.now();
  const checkId = uuid();
  const items = await collect(report);
  let added = 0, updated = 0, skipped = 0, noticeCount = 0;
  const statements: D1PreparedStatement[] = [];

  for (const it of items) {
    it.data.notices = noticesFor(it.kind, report.run, it.data);
    noticeCount += it.data.notices.length;
    const open = await env.DB.prepare(
      `SELECT id FROM legal_update_findings WHERE law_id = ? AND kind = ? AND state = 'open'`
    )
      .bind(it.law_id, it.kind)
      .first<{ id: string }>();
    if (open) {
      statements.push(
        env.DB.prepare(
          `UPDATE legal_update_findings SET law_title = COALESCE(?, law_title), level = ?, detail = ?, signature = ?,
             data_json = ?, last_check_id = ?, last_run = ?, updated_at = ? WHERE id = ?`
        ).bind(it.law_title, it.level, it.detail, it.signature, JSON.stringify(it.data), checkId, report.run, now, open.id),
        ...noticeStatements(env, open.id, it.law_id, report.run, it.data.notices)
      );
      updated++;
      continue;
    }
    // ما استبعده المسؤول لا يعود ما دام المرصودُ نفسه — يُسجَّل أنه رُصد ثانيةً.
    const dismissed = await env.DB.prepare(
      `SELECT id FROM legal_update_findings WHERE law_id = ? AND kind = ? AND state = 'dismissed' AND signature = ?
       ORDER BY updated_at DESC LIMIT 1`
    )
      .bind(it.law_id, it.kind, it.signature)
      .first<{ id: string }>();
    if (dismissed) {
      statements.push(
        env.DB.prepare('UPDATE legal_update_findings SET last_check_id = ?, last_run = ? WHERE id = ?').bind(
          checkId, report.run, dismissed.id
        )
      );
      skipped++;
      noticeCount -= it.data.notices.length;
      continue;
    }
    const id = uuid();
    statements.push(
      env.DB.prepare(
        `INSERT INTO legal_update_findings
           (id, law_id, law_title, kind, level, detail, signature, data_json, state,
            first_check_id, last_check_id, first_run, last_run, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`
      ).bind(id, it.law_id, it.law_title, it.kind, it.level, it.detail, it.signature, JSON.stringify(it.data),
        checkId, checkId, report.run, report.run, now, now),
      ...noticeStatements(env, id, it.law_id, report.run, it.data.notices)
    );
    added++;
  }

  // ما فحصه فحصٌ كامل ولم يرصد فيه شيئاً من نوعه: لم يعد يُرصد، فيُغلق.
  let resolved = 0;
  if (report.mode === 'full' && Array.isArray(report.checked_ids)) {
    const checked = new Set(report.checked_ids);
    const present = new Set(items.map((i) => `${i.law_id}\u0000${i.kind}`));
    const openRows = await env.DB.prepare(
      `SELECT id, law_id, kind FROM legal_update_findings WHERE state = 'open' AND kind IN (${PAGE_KINDS.map(() => '?').join(',')})`
    )
      .bind(...PAGE_KINDS)
      .all<{ id: string; law_id: string; kind: string }>();
    for (const r of openRows.results ?? []) {
      if (!checked.has(r.law_id) || present.has(`${r.law_id}\u0000${r.kind}`)) continue;
      statements.push(...closeStatements(env, r.id, 'gone', null, opts.actorId ?? null, now));
      resolved++;
    }
  }

  statements.push(
    env.DB.prepare(
      `INSERT INTO legal_update_checks (id, run, mode, version, filename, file_sha256, summary_json, report_json,
         added, updated, resolved, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(checkId, report.run, report.mode, report.version, opts.filename ?? null, fileSha,
      JSON.stringify(report.summary ?? {}), text, added, updated, resolved, opts.actorId ?? null, now)
  );
  // معاملةٌ واحدة: التقرير يُكتب كلّه أو لا يُكتب.
  await env.DB.batch(statements);
  return { duplicate: false, check_id: checkId, run: report.run, mode: report.mode, added, updated, resolved, skipped_dismissed: skipped, notices: noticeCount };
}

function closeStatements(env: Env, id: string, how: 'imported' | 'gone' | null, batch: string | null, actor: string | null, now: number) {
  return [
    env.DB.prepare(
      `UPDATE legal_update_findings SET state = 'resolved', resolved_how = ?, resolved_batch = ?, resolved_by = ?,
         resolved_at = ?, updated_at = ? WHERE id = ? AND state = 'open'`
    ).bind(how, batch, actor, now, now, id),
    env.DB.prepare('DELETE FROM legal_pending_updates WHERE finding_id = ?').bind(id),
  ];
}

// ─────────────────────────── الإغلاق بالاستيراد وإعادة الفتح ───────────────────────────

/**
 * نظامٌ استُورد: تُغلق بنوده التي عالجها الاستيراد.
 *
 * «عالجها» لا «مرّ عليها»: يُغلق البند إن كان سحبُ النظام المستورد (`captured_at`)
 * يوم الرصد أو بعده — فإعادةُ بناء الملف من سحبٍ قديم ورفعُه لا تُسقط تنبيهاً على
 * تعديلٍ لم يُسحب. والإلغاءُ والإحلال يُغلقان حين يصير النظام لاغياً في القاعدة أو
 * يُجدول إلغاؤه. ويُغلق «نظامٌ جديد» حين يُستورد نظامٌ مصدرُه رابطُه نفسه.
 *
 * لا يرمي: الاستيراد كُتب، وتعذُّرُ الإغلاق يُسجَّل ويُعالَج في الفحص التالي.
 */
export async function resolveOnImport(env: Env, lawIds: string[], batchId: string | null): Promise<number> {
  let closed = 0;
  try {
    const now = Date.now();
    for (const lawId of [...new Set(lawIds.filter(Boolean))]) {
      const law = await env.DB.prepare(
        `SELECT MAX(captured_at) AS captured, MAX(law_repealed) AS repealed,
                MAX(scheduled_repeal_from) AS scheduled, MAX(source_url) AS url
         FROM legal_chunks WHERE law_id = ?`
      )
        .bind(lawId)
        .first<{ captured: string | null; repealed: number | null; scheduled: string | null; url: string | null }>();
      if (!law) continue;
      const ids = [lawId];
      const g = boeId(law.url ?? undefined);
      if (g) ids.push(g);
      const open = await env.DB.prepare(
        `SELECT id, law_id, kind, level, state, signature, first_run, data_json FROM legal_update_findings
         WHERE state = 'open' AND law_id IN (${ids.map(() => '?').join(',')})`
      )
        .bind(...ids)
        .all<FindingRow>();
      const captured = String(law.captured ?? '').slice(0, 10);
      const statements: D1PreparedStatement[] = [];
      for (const f of open.results ?? []) {
        const data = parseData(f.data_json);
        const repealedNow = law.repealed === 1 || !!law.scheduled;
        const ok =
          f.kind === 'new_law'
            ? true
            : f.kind === 'replacement' || (f.kind === 'status' && data.to_repealed)
              ? repealedNow
              : !!captured && captured >= f.first_run;
        if (!ok) continue;
        statements.push(...closeStatements(env, f.id, 'imported', batchId, null, now));
        closed++;
      }
      if (statements.length) await env.DB.batch(statements);
    }
  } catch (e) {
    console.error('update-check resolve on import failed:', e instanceof Error ? e.message : e);
  }
  return closed;
}

/**
 * دفعةٌ رُدّت: ما أغلقته يُفتح ثانيةً بتنبيهاته — النصّ الذي عالجه رجع إلى ما قبله.
 * وبندٌ فُتح بعده للنظام والنوع نفسيهما يبقى، ولا يُفتح القديم فوقه.
 */
export async function reopenForBatch(env: Env, batchId: string, lawId?: string): Promise<number> {
  let reopened = 0;
  try {
    const rows = await env.DB.prepare(
      `SELECT id, law_id, kind, level, state, signature, first_run, data_json FROM legal_update_findings
       WHERE state = 'resolved' AND resolved_how = 'imported' AND resolved_batch = ?${lawId ? ' AND law_id = ?' : ''}`
    )
      .bind(...(lawId ? [batchId, lawId] : [batchId]))
      .all<FindingRow>();
    for (const f of rows.results ?? []) {
      if (await reopenOne(env, f)) reopened++;
    }
  } catch (e) {
    console.error('update-check reopen failed:', e instanceof Error ? e.message : e);
  }
  return reopened;
}

async function reopenOne(env: Env, f: FindingRow): Promise<boolean> {
  const other = await env.DB.prepare(
    `SELECT id FROM legal_update_findings WHERE law_id = ? AND kind = ? AND state = 'open' AND id <> ?`
  )
    .bind(f.law_id, f.kind, f.id)
    .first<{ id: string }>();
  if (other) return false;
  const data = parseData(f.data_json);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE legal_update_findings SET state = 'open', resolved_how = NULL, resolved_batch = NULL, resolved_by = NULL,
         resolved_at = NULL, dismiss_note = NULL, updated_at = ? WHERE id = ?`
    ).bind(now, f.id),
    ...noticeStatements(env, f.id, f.law_id, f.first_run, data.notices),
  ]);
  return true;
}

// ─────────────────────────── قرار المسؤول ───────────────────────────

/** استبعاد بند: لا يستحقّ — ويُرفع تنبيهه، ولا يعود ما دام المرصودُ نفسه. */
export async function dismissFinding(env: Env, id: string, actorId: string, note: string | null): Promise<boolean> {
  const now = Date.now();
  const r = await env.DB.batch([
    env.DB.prepare(
      `UPDATE legal_update_findings SET state = 'dismissed', resolved_by = ?, resolved_at = ?, dismiss_note = ?, updated_at = ?
       WHERE id = ? AND state = 'open'`
    ).bind(actorId, now, note, now, id),
    env.DB.prepare('DELETE FROM legal_pending_updates WHERE finding_id = ?').bind(id),
  ]);
  return (r[0]?.meta?.changes ?? 0) > 0;
}

/** التراجع عن استبعاد. */
export async function reopenFinding(env: Env, id: string): Promise<boolean> {
  const f = await env.DB.prepare(
    `SELECT id, law_id, kind, level, state, signature, first_run, data_json FROM legal_update_findings WHERE id = ? AND state <> 'open'`
  )
    .bind(id)
    .first<FindingRow>();
  return f ? reopenOne(env, f) : false;
}

// ─────────────────────────── العرض ───────────────────────────

export interface FindingView {
  id: string;
  law_id: string;
  law_title: string | null;
  kind: string;
  level: number;
  detail: string;
  state: string;
  first_run: string;
  last_run: string;
  resolved_how: string | null;
  resolved_at: number | null;
  dismiss_note: string | null;
  in_base: boolean;
  url: string | null;
  samples: string[];
  notices: number;
}

export async function listUpdateChecks(env: Env): Promise<{
  checks: { id: string; run: string; mode: string; summary: Record<string, unknown>; added: number; updated: number; resolved: number; created_at: number }[];
  open: FindingView[];
  closed: FindingView[];
}> {
  const checks = await env.DB.prepare(
    `SELECT id, run, mode, summary_json, added, updated, resolved, created_at FROM legal_update_checks
     ORDER BY run DESC, created_at DESC LIMIT 12`
  ).all<{ id: string; run: string; mode: string; summary_json: string; added: number; updated: number; resolved: number; created_at: number }>();
  const cols = `f.id, f.law_id, f.law_title, f.kind, f.level, f.detail, f.state, f.first_run, f.last_run,
    f.resolved_how, f.resolved_at, f.dismiss_note, f.data_json,
    (SELECT COUNT(*) FROM legal_pending_updates p WHERE p.finding_id = f.id) AS notices,
    EXISTS (SELECT 1 FROM legal_chunks c WHERE c.law_id = f.law_id) AS in_base`;
  const open = await env.DB.prepare(
    `SELECT ${cols} FROM legal_update_findings f WHERE f.state = 'open' ORDER BY f.level, f.first_run, f.law_title`
  ).all<any>();
  const closed = await env.DB.prepare(
    `SELECT ${cols} FROM legal_update_findings f WHERE f.state <> 'open' ORDER BY f.resolved_at DESC LIMIT 30`
  ).all<any>();
  const view = (r: any): FindingView => {
    const d = parseData(r.data_json);
    return {
      id: r.id, law_id: r.law_id, law_title: r.law_title, kind: r.kind, level: r.level, detail: r.detail,
      state: r.state, first_run: r.first_run, last_run: r.last_run, resolved_how: r.resolved_how,
      resolved_at: r.resolved_at, dismiss_note: r.dismiss_note, in_base: r.in_base === 1,
      url: d.url ?? null, samples: d.samples ?? [], notices: r.notices ?? 0,
    };
  };
  return {
    checks: (checks.results ?? []).map((c) => ({
      id: c.id, run: c.run, mode: c.mode, summary: parseSummary(c.summary_json),
      added: c.added, updated: c.updated, resolved: c.resolved, created_at: c.created_at,
    })),
    open: (open.results ?? []).map(view),
    closed: (closed.results ?? []).map(view),
  };
}

function parseSummary(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
