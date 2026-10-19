// الإحالات بين المواد — «مع مراعاة المادة (76) من نظام المرافعات الشرعية».
//
// المادة القانونية لا تُقرأ وحدها: تحيل إلى مادةٍ في نظامها، أو في نظامٍ آخر، أو في
// لائحتها. والبحث بالتشابه لا يجد المحال إليه لأنه لا يشبه السؤال. فتُستخرج
// الإحالات من النصوص مرّةً — بقواعد حتمية لا بنموذج — وتُحفظ في
// `legal_article_links`، ويتبعها الاسترجاع قفزةً واحدة.
//
// والاستخراج على `text_norm` (النصّ المطبَّع): الأرقام فيه غربية، والهمزات
// والتاء المربوطة موحّدة، فتكفي القواعدَ صيغةٌ واحدة لكل لفظ.
import { normalizeArabic } from '../arabic';
import type { Env } from '../../types';

// ── الأعداد الترتيبية بالحروف ──
//
// الأنظمة السعودية تكتب أرقام المواد المحال إليها بالحروف كثيراً: «المادة (الرابعة
// والسبعين)»، «المادة الثالثة والعشرين بعد المائة». والجداول بعد التطبيع
// (ة→ه، ى→ي، ئ→ي، أ→ا).

const UNITS: Record<string, number> = {
  الاولي: 1, الاول: 1, الحاديه: 1, الحادي: 1, اولي: 1,
  الثانيه: 2, الثاني: 2, ثانيه: 2,
  الثالثه: 3, الثالث: 3, ثالثه: 3,
  الرابعه: 4, الرابع: 4, رابعه: 4,
  الخامسه: 5, الخامس: 5, خامسه: 5,
  السادسه: 6, السادس: 6, سادسه: 6,
  السابعه: 7, السابع: 7, سابعه: 7,
  الثامنه: 8, الثامن: 8, ثامنه: 8,
  التاسعه: 9, التاسع: 9, تاسعه: 9,
  العاشره: 10, العاشر: 10,
};

const TEENS_WORD = new Set(['عشره', 'عشر']);

const TENS: Record<string, number> = {
  العشرين: 20, العشرون: 20, عشرين: 20, عشرون: 20,
  الثلاثين: 30, الثلاثون: 30, ثلاثين: 30, ثلاثون: 30,
  الاربعين: 40, الاربعون: 40, اربعين: 40, اربعون: 40,
  الخمسين: 50, الخمسون: 50, خمسين: 50, خمسون: 50,
  الستين: 60, الستون: 60, ستين: 60, ستون: 60,
  السبعين: 70, السبعون: 70, سبعين: 70, سبعون: 70,
  الثمانين: 80, الثمانون: 80, ثمانين: 80, ثمانون: 80,
  التسعين: 90, التسعون: 90, تسعين: 90, تسعون: 90,
};

// «المائة» و«المئة» بعد التطبيع: «المايه» و«الميه».
const HUNDREDS: Record<string, number> = {
  المايه: 100, الميه: 100, مايه: 100, ميه: 100,
  المايتين: 200, المايتان: 200, الميتين: 200, الميتان: 200, مايتين: 200,
  الثلاثمايه: 300, ثلاثمايه: 300, الثلاثميه: 300,
  الاربعمايه: 400, اربعمايه: 400, الاربعميه: 400,
  الخمسمايه: 500, خمسمايه: 500, الخمسميه: 500,
};

/** ألفاظٌ تقع بين أجزاء العدد ولا قيمة لها: «بعد المائة». */
const FILLERS = new Set(['بعد']);

/**
 * عددٌ ترتيبيّ بالحروف إلى رقمه: «الثالثه والعشرين بعد المايه» → 123.
 * يعيد null إن لم تكن الكلمات كلُّها من ألفاظ العدد.
 */
export function ordinalToNumber(words: string): number | null {
  const tokens = normalizeArabic(words)
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return null;
  let total = 0;
  let lastUnit = 0;
  for (const raw of tokens) {
    // «والعشرين» — واو العطف تُنزع حين يبقى بعدها لفظُ عدد.
    const t = raw.startsWith('و') && !(raw in UNITS) && !(raw in TENS) && !(raw in HUNDREDS) ? raw.slice(1) : raw;
    if (FILLERS.has(t)) continue;
    if (t in UNITS) {
      lastUnit = UNITS[t];
      total += lastUnit;
    } else if (TEENS_WORD.has(t)) {
      // «الثانيه عشره» = 12 — العشرة تضاف إلى الآحاد قبلها.
      if (!lastUnit || lastUnit === 10) return null;
      total += 10;
      lastUnit = 0;
    } else if (t in TENS) {
      total += TENS[t];
      lastUnit = 0;
    } else if (t in HUNDREDS) {
      total += HUNDREDS[t];
      lastUnit = 0;
    } else {
      return null;
    }
  }
  return total >= 1 && total <= 999 ? total : null;
}

// ── استخراج الإحالات ──

export interface ParsedRef {
  /** أرقام المواد المحال إليها (مطبَّعة) — فارغةٌ لإحالةٍ إلى نظامٍ بلا مادة. */
  articles: string[];
  /**
   * إلى أين:
   * `self` هذا النظام (أو لا قيد) · `named` نظامٌ مسمّى · `regulation` لائحة هذا النظام
   * · `parent` النظام الذي هذه لائحته · `previous` المادة السابقة.
   */
  scope: 'self' | 'named' | 'regulation' | 'parent' | 'previous';
  /** عنوان النظام المسمّى كما كُتب (مطبَّعاً) — لـ`named`. */
  lawTitle?: string;
  /** المقطع الذي وُجدت فيه الإحالة — للمراجعة. */
  excerpt: string;
}

/** لفظ «المادة» ومعه سوابقه المتصلة: «للمادتين» · «بالماده» · «وفقاً للماده». */
const ARTICLE_WORD = /(?:^|[\s(«"])((?:و|ف)?(?:بال|لل|كال|ال)?(?:ماده|مادتين|مادتان|مواد))(?=[\s(])/g;

/** ما ينتهي عنده سرد أرقام المواد. */
const LIST_STOP = /[.،؛:\n]|(?:\s(?:من|في|وفق|الي|علي|او|اذا|ما|لا|التي|الذي|عن|حتي|ان|بما)\s)/;

/** يقرأ أرقاماً من سردٍ: «(5، 6، 7)» · «(5) و(6)» · «الرابعه والسبعين» · «74 مكرر». */
function numbersIn(segment: string): string[] {
  const out: string[] = [];
  // ما بين قوسين أوّلاً: كلُّ قوسٍ رقمٌ أو سردٌ أو عددٌ بالحروف.
  const groups = segment.match(/\(([^()]{1,80})\)/g);
  const pieces = groups?.length ? groups.map((g) => g.slice(1, -1)) : [segment];
  for (const piece of pieces) {
    const digits = piece.match(/\d{1,4}/g);
    if (digits?.length) {
      out.push(...digits);
      continue;
    }
    // بالحروف. العددُ المركّب «السابعه والسبعين» يُقرأ كاملاً أولاً؛ وما لا يُقرأ
    // كاملاً سردٌ يُفصل بـ«و» قبل لفظٍ معرَّف: «الخامسه والسادسه».
    for (const part of piece.split(/،|,/)) {
      const whole = ordinalToNumber(part);
      if (whole) {
        out.push(String(whole));
        continue;
      }
      for (const sub of part.split(/\sو(?=ال)/)) {
        const n = ordinalToNumber(sub);
        if (n) out.push(String(n));
      }
    }
  }
  return [...new Set(out)];
}

/** الإحالات في نصٍّ مطبَّع. */
export function parseRefs(textNorm: string): ParsedRef[] {
  const refs: ParsedRef[] = [];
  for (const m of textNorm.matchAll(ARTICLE_WORD)) {
    const at = (m.index ?? 0) + m[0].length - m[1].length;
    const after = textNorm.slice(at + m[1].length, at + m[1].length + 220);
    const excerpt = textNorm.slice(at, at + 160);

    // «الماده السابقه» — والتالية لا تُتبع: نادرةٌ وملتبسة.
    if (/^\s*\(?السابقه\)?/.test(after)) {
      refs.push({ articles: [], scope: 'previous', excerpt });
      continue;
    }

    // السردُ إلى أوّل فاصلٍ يقطعه — والأقواس تُبقي فواصلها داخلها.
    const parenEnd = after.match(/^\s*(?:\([^()]{1,80}\)\s*(?:،\s*|و\s*)?)+/);
    let listPart: string;
    let rest: string;
    if (parenEnd) {
      listPart = parenEnd[0];
      rest = after.slice(parenEnd[0].length);
    } else {
      const stop = after.search(LIST_STOP);
      listPart = stop === -1 ? after.slice(0, 80) : after.slice(0, stop);
      rest = stop === -1 ? '' : after.slice(stop);
    }
    const articles = numbersIn(listPart);
    if (!articles.length) continue; // «هذه الماده»، «الماده المذكوره» — لا رقم.

    // «المادة (15) مكرر» مادةٌ غير المادة 15، ولا تُحلّ برقمها — فلا تُتبع، وغيابُ
    // الإحالة أهون من إحالةٍ إلى غير المقصود.
    if (/^\s*مكرر/.test(rest)) continue;

    // ما بعد السرد: «من هذا النظام» · «من اللايحه» · «من النظام» · «من نظام …».
    const scopeText = rest;
    let scope: ParsedRef['scope'] = 'self';
    let lawTitle: string | undefined;
    const from = scopeText.match(/^\s*(?:من|في|ب)\s*(.{0,140})/);
    if (from) {
      const tail = from[1];
      if (/^(?:هذا النظام|النظام ذاته)/.test(tail)) scope = 'self';
      else if (/^(?:هذه اللايحه|اللايحه ذاتها)/.test(tail)) scope = 'self';
      else if (/^(?:اللايحه|اللايحه التنفيذيه)(?!\s+(?:التنفيذيه\s+)?ل?نظام)/.test(tail)) scope = 'regulation';
      else if (/^النظام(?=[\s.،؛:]|$)/.test(tail)) {
        // «من النظام» في لائحةٍ نظامُها، وفي نظامٍ هو نفسه. ويُحفظ المقطع: «النظام
        // الاساسي للحكم» عنوانُ نظامٍ يبدأ بـ«النظام»، فيُحلّ بعنوانه إن طابق.
        scope = 'parent';
        lawTitle = tail.match(/^[^.،؛:()«»"]{2,90}/)?.[0].trim();
      }
      else {
        const named = tail.match(/^((?:اللايحه التنفيذيه ل|لايحه )?نظام [^.،؛:()«»"]{2,90})/);
        if (named) {
          scope = 'named';
          lawTitle = named[1]
            .replace(/\s+(?:الصادر|الصادره|المشار|المعدل|وتعديلاته|و\S*\s*لايحته).*$/, '')
            .trim();
        }
      }
    }
    refs.push({ articles, scope, lawTitle, excerpt });
  }
  return refs;
}

// ── الحفظ والحلّ ──

export interface KnownLaw {
  lawId: string;
  /** العنوان كما في القاعدة — للعرض. */
  title: string;
  titleNorm: string;
  parentLawId: string | null;
  isRegulation: boolean;
}

/** الأنظمة المعروفة — لحلّ العنوان المسمّى إلى معرّف. */
export async function knownLaws(env: Env): Promise<KnownLaw[]> {
  const rows = await env.DB.prepare(
    `SELECT law_id, MAX(law_title) AS law_title, MAX(parent_law_id) AS parent_law_id, MAX(doc_type) AS doc_type
     FROM legal_chunks WHERE law_id IS NOT NULL GROUP BY law_id`
  ).all<{ law_id: string; law_title: string | null; parent_law_id: string | null; doc_type: string | null }>();
  return (rows.results ?? [])
    .filter((r) => r.law_title)
    .map((r) => ({
      lawId: r.law_id,
      title: r.law_title!,
      titleNorm: normalizeArabic(r.law_title!),
      parentLawId: r.parent_law_id,
      isRegulation: !!r.parent_law_id || r.doc_type === 'regulation',
    }));
}

/**
 * العنوان المسمّى إلى نظام: أطولُ عنوانٍ معروف يبدأ به المقطع المكتوب.
 *
 * «نظام المرافعات الشرعيه» يطابق «نظام المرافعات الشرعيه» لا «نظام المرافعات امام
 * ديوان المظالم». وعنوانان متساويان طولاً ومطابقةً لا يُختار أحدهما.
 */
export function resolveNamed(title: string, laws: KnownLaw[]): string | null {
  const t = normalizeArabic(title);
  const hits = laws.filter((l) => t === l.titleNorm || t.startsWith(`${l.titleNorm} `));
  if (!hits.length) return null;
  const best = Math.max(...hits.map((h) => h.titleNorm.length));
  const top = hits.filter((h) => h.titleNorm.length === best);
  return top.length === 1 ? top[0].lawId : null;
}

/** مقاطعُ في الدفعة الواحدة. */
const LINK_BATCH = 50;

export interface LinkRunResult {
  processed: number;
  links: number;
  resolved: number;
  remaining: number;
}

/**
 * يستخرج إحالات المقاطع التي لم تُستخرج إحالاتها — أو تغيّر نصّها بعد ذلك
 * (المحفّز في الهجرة 0036 يعيد `links_at` فارغاً) — ثم يحلّ ما بقي معلّقاً من
 * إحالاتٍ سابقة إلى موادَّ وصلت بعدها.
 */
export async function extractPendingLinks(env: Env, limit = 300): Promise<LinkRunResult> {
  const pending = await env.DB.prepare(
    `SELECT seq, law_id, parent_law_id, article_no_norm, text_norm
     FROM legal_chunks WHERE links_at IS NULL ORDER BY seq LIMIT ?`
  )
    .bind(limit)
    .all<{ seq: number; law_id: string | null; parent_law_id: string | null; article_no_norm: string | null; text_norm: string }>();
  const rows = pending.results ?? [];

  let links = 0;
  if (rows.length) {
    const laws = await knownLaws(env);
    const regulationOf = new Map<string, string[]>();
    for (const l of laws) {
      if (l.parentLawId) regulationOf.set(l.parentLawId, [...(regulationOf.get(l.parentLawId) ?? []), l.lawId]);
    }

    for (let i = 0; i < rows.length; i += LINK_BATCH) {
      const slice = rows.slice(i, i + LINK_BATCH);
      const stmts: D1PreparedStatement[] = [];
      for (const r of slice) {
        stmts.push(env.DB.prepare('DELETE FROM legal_article_links WHERE from_seq = ?').bind(r.seq));
        const seen = new Set<string>();
        for (const ref of parseRefs(r.text_norm ?? '')) {
          let lawId: string | null = null;
          let title: string | null = null;
          let articles = ref.articles;
          switch (ref.scope) {
            case 'self':
              lawId = r.law_id;
              break;
            case 'parent': {
              const named = ref.lawTitle ? resolveNamed(ref.lawTitle, laws) : null;
              lawId = named ?? r.parent_law_id ?? r.law_id;
              break;
            }
            case 'regulation': {
              const regs = r.law_id ? (regulationOf.get(r.law_id) ?? []) : [];
              lawId = regs.length === 1 ? regs[0] : null;
              title = regs.length === 1 ? null : 'اللايحه';
              break;
            }
            case 'named':
              title = ref.lawTitle ?? null;
              lawId = title ? resolveNamed(title, laws) : null;
              break;
            case 'previous': {
              const n = Number(r.article_no_norm);
              if (!Number.isInteger(n) || n < 2) continue;
              lawId = r.law_id;
              articles = [String(n - 1)];
              break;
            }
          }
          for (const a of articles.length ? articles : [null]) {
            const key = `${lawId ?? title}|${a}`;
            if (seen.has(key)) continue;
            seen.add(key);
            // لا إحالةَ من المادة إلى نفسها: «الماده (5)» في متن المادة 5 ذكرٌ لا إحالة.
            if (lawId === r.law_id && a && a === r.article_no_norm) continue;
            stmts.push(
              env.DB.prepare(
                `INSERT OR IGNORE INTO legal_article_links
                   (from_seq, to_law_id, to_law_title, to_article_no, scope, excerpt, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
              ).bind(r.seq, lawId, lawId ? null : title, a, ref.scope, ref.excerpt.slice(0, 200), Date.now())
            );
            links++;
          }
        }
        stmts.push(env.DB.prepare('UPDATE legal_chunks SET links_at = ? WHERE seq = ?').bind(Date.now(), r.seq));
      }
      await env.DB.batch(stmts);
    }
  }

  // الحلّ إلى مقطع: أوّلُ أجزاء المادة بالرقم، بلا ملحقٍ ولا مرفقٍ ولا «مكرر».
  // ويُعاد لكل معلّق في كل شوط: مادةٌ تُستورد بعد الإحالة إليها تُوصل حين تصل.
  const resolved = await env.DB.prepare(
    `UPDATE legal_article_links SET to_seq = (
       SELECT c.seq FROM legal_chunks c
       WHERE c.law_id = legal_article_links.to_law_id
         AND (c.article_no_norm = legal_article_links.to_article_no OR c.former_article_no_norm = legal_article_links.to_article_no)
         AND c.is_annex = 0 AND c.is_attachment = 0 AND c.is_mukarrar = 0
       ORDER BY c.seq LIMIT 1)
     WHERE to_seq IS NULL AND to_law_id IS NOT NULL AND to_article_no IS NOT NULL`
  ).run();

  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM legal_chunks WHERE links_at IS NULL').first<{ n: number }>();
  return { processed: rows.length, links, resolved: resolved.meta?.changes ?? 0, remaining: left?.n ?? 0 };
}
