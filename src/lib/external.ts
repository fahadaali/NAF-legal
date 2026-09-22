/**
 * المصادر الخارجية: من ردِّ MCP إلى مقطعٍ يُعرض ويُستشهد به.
 *
 * ثلاثةُ محوّلات: تراث والشاملة مكتوبان لأن شكلَيهما مفحوصان، وثالثٌ عامّ
 * يقبل خادماً لم يُكتب له محوّل — فالخادم القانونيّ الذي يُربط بعد سنة يعمل
 * يوم يُضاف صفُّه، ويُكتب له محوّلٌ خاصّ إن استحقّ.
 *
 * ── الحاشية ليست كلام المؤلف ──
 *
 * الشاملة تردّ `matched_in: ['body','foot']` وتحذّر صراحةً: الحاشية كلام
 * المحقِّق أو المعلِّق لا كلام المصنِّف. ونسبتُها إلى المؤلف خطأٌ علميّ يُنقل
 * في مذكرةٍ تُرفع لمحكمة. فالوسم يُحمل مع المقطع إلى البرومبت وإلى الشاشة
 * معاً — كما تُحمل تنبيهات التعديل في `noticeLines()` بـ`lib/rag.ts`.
 */
import { callTool } from './mcp';
import { accessTokenFor } from './oauth';
import { tokenFor, type ExternalSource } from './sources';
import type { Env } from '../types';

/** سقفُ ما يُؤخذ من نصّ مقطعٍ واحد. صفحةُ تراث كاملةٌ تتجاوز ثلاثة آلاف حرف. */
const TEXT_MAX = 1500;

/** وسقفٌ كلّي للمصدر الواحد — ثمانيةُ مقاطع كاملة تُزاحم السياق النظامي. */
const TOTAL_MAX = 12000;

export interface ExternalHit {
  sourceId: string;
  sourceLabel: string;
  /** الكتاب. */
  title: string;
  author?: string;
  /** الجزء والصفحة كما يُستشهد بهما. */
  ref?: string;
  /** التصنيف — «الفقه الحنبلي»، «فقه المعاملات». */
  category?: string;
  text: string;
  /** رابطٌ خارجيّ إن كان للمصدر موقع — تراث نعم، والشاملة لا. */
  url?: string;
  /** من المتن أم من الحاشية. والحاشية كلام المحقِّق. */
  section?: 'متن' | 'حاشية';
  /** رتبةُ المصدر الأصلية — تُستعمل في الدمج إن تعذّر الترتيب الدلالي. */
  rank: number;
  score: number;
}

/** يُزيل وسوم الإبراز التي يضعها الخادم (`<em>` في تراث، `<mark>` في الشاملة). */
function stripMarks(s: string): string {
  return s.replace(/<\/?(?:em|mark|b|strong)>/g, '');
}

function clean(v: unknown): string {
  return typeof v === 'string' ? stripMarks(v).replace(/\s+/g, ' ').trim() : '';
}

function num(v: unknown): string {
  return typeof v === 'number' || typeof v === 'string' ? String(v) : '';
}

// ── تراث ──
function fromTurath(source: ExternalSource, data: any): ExternalHit[] {
  const rows = Array.isArray(data?.results) ? data.results : [];
  return rows.map((r: any, i: number): ExternalHit => {
    const m = r?.meta ?? {};
    const vol = num(m.vol);
    const page = num(m.page);
    // النصّ الكامل أنفع للإسناد من المقتطف، والمقتطف احتياطُه.
    const body = clean(r.text) || clean(r.snip);
    return {
      sourceId: source.id,
      sourceLabel: source.label,
      title: clean(m.book_name) || 'كتاب',
      author: clean(m.author_name) || undefined,
      ref: vol && page ? `${vol}/${page}` : page || undefined,
      category: Array.isArray(m.headings) && m.headings.length ? clean(m.headings[0]) : undefined,
      text: body.slice(0, TEXT_MAX),
      url: typeof r.link === 'string' && r.link.startsWith('https://') ? r.link : undefined,
      section: 'متن',
      rank: i,
      score: 0,
    };
  });
}

// ── المكتبة الشاملة ──
function fromShamela(source: ExternalSource, data: any): ExternalHit[] {
  const rows = Array.isArray(data?.results) ? data.results : [];
  return rows.map((r: any, i: number): ExternalHit => {
    const matched: string[] = Array.isArray(r?.matched_in) ? r.matched_in : [];
    /* المتن يسبق الحاشية حين يطابق كلاهما: كلام المصنِّف هو المقصود، وكلام
       المحقِّق تابعٌ له. وحين لا يطابق إلا الحاشية تُؤخذ **موسومةً**. */
    const bodyHit = matched.includes('body') && clean(r.snippet_body);
    const text = bodyHit ? clean(r.snippet_body) : clean(r.snippet_foot) || clean(r.snippet_body);
    return {
      sourceId: source.id,
      sourceLabel: source.label,
      title: clean(r.book_name) || 'كتاب',
      author: clean(r.author_name) || undefined,
      ref: num(r.printed_page) || undefined,
      category: clean(r.category) || undefined,
      text: text.slice(0, TEXT_MAX),
      section: bodyHit ? 'متن' : 'حاشية',
      rank: i,
      score: 0,
    };
  });
}

// ── محوّلٌ عامّ: لخادمٍ لم يُكتب له محوّل بعد ──
function fromGeneric(source: ExternalSource, data: any): ExternalHit[] {
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data?.results)
      ? data.results
      : Array.isArray(data?.hits)
        ? data.hits
        : [];
  return rows
    .map((r: any, i: number): ExternalHit | null => {
      const m = r?.meta ?? r ?? {};
      const text =
        clean(r?.text) || clean(r?.snippet) || clean(r?.snip) || clean(r?.content) || clean(r?.body);
      if (!text) return null; // مقطعٌ بلا نصّ لا يُستشهد به ولا يُعرض
      return {
        sourceId: source.id,
        sourceLabel: source.label,
        title: clean(m.book_name) || clean(m.title) || clean(r?.title) || source.label,
        author: clean(m.author_name) || clean(m.author) || undefined,
        ref: num(m.page) || num(r?.page) || undefined,
        text: text.slice(0, TEXT_MAX),
        url: typeof r?.link === 'string' && r.link.startsWith('https://') ? r.link : undefined,
        rank: i,
        score: 0,
      };
    })
    .filter((h: ExternalHit | null): h is ExternalHit => h !== null);
}

const ADAPTERS: Record<string, (s: ExternalSource, d: any) => ExternalHit[]> = {
  turath: fromTurath,
  shamela: fromShamela,
};

export function adapt(source: ExternalSource, data: unknown): ExternalHit[] {
  const fn = ADAPTERS[source.id] ?? fromGeneric;
  let hits: ExternalHit[];
  try {
    hits = fn(source, data);
  } catch (e) {
    // شكلٌ تغيّر عند الخادم: يُسجَّل ولا يُرمى. المحوّل الخاصّ قد يُخطئ حيث
    // يصيب العامّ، فتُجرَّب العودة إليه قبل التسليم بالفراغ.
    console.error(`external ${source.id}: adapter failed: ${e instanceof Error ? e.message : e}`);
    try {
      hits = fromGeneric(source, data);
    } catch {
      return [];
    }
  }
  // سقفٌ كلّي: مقاطعُ مصدرٍ واحد لا تزاحم السياق النظامي.
  const out: ExternalHit[] = [];
  let used = 0;
  for (const h of hits) {
    if (!h.text) continue;
    if (used + h.text.length > TOTAL_MAX) break;
    used += h.text.length;
    out.push(h);
  }
  return out;
}

export interface SourceOutcome {
  sourceId: string;
  sourceLabel: string;
  status: 'ok' | 'unreachable' | 'unconfigured';
  hits: ExternalHit[];
  /** سببُ التعذّر — يُعرض للمسؤول في لوحة الإدارة لا للمستخدم في الشاشة. */
  error?: string;
  /**
   * عنوانُ وثيقة الموارد حين يدلّ ٤٠١ عليه — أي حين يكون الخادم على OAuth.
   *
   * يمرّ كما هو إلى المنادي ولا يُفسَّر هنا: `searchSource` تبحث، ومن أراد
   * أن يسبر بابَ التفويض سبره بنفسه (`lib/discover.ts`). وخلطُ السبر
   * بالبحث يجعل كلَّ استعلامٍ فقهيّ يجلب وثيقتين.
   */
  resourceMetadata?: string;
}

/** يبحث في مصدرٍ واحد. ولا يرمي: الحالُ تُوصَف في `status`. */
export async function searchSource(
  env: Env,
  source: ExternalSource,
  query: string
): Promise<SourceOutcome> {
  const base: Omit<SourceOutcome, 'status' | 'hits'> = {
    sourceId: source.id,
    sourceLabel: source.label,
  };
  /* الرمز: قيمةٌ من السرّ في الأنواع الثابتة، ومسكوكٌ يُجدَّد في التفويض.
     و`accessTokenFor` لا ترمي وتردّ `null` حين يلزم تفويض — فيتولّاه الحارس
     في `callTool` برسالةٍ تُقرأ. */
  const token =
    source.authScheme === 'oauth' ? await accessTokenFor(env, source) : tokenFor(env, source);
  /* السقفُ يُرسَل باسمه المسجَّل، أو لا يُرسَل.
     و`limit` لم تكن تُفرض عبثاً: `search_turath` لا تعرفها أصلاً، وخادمٌ
     يضبط `additionalProperties: false` يردّ الطلبَ كلَّه لأجل معاملٍ زائد —
     فيبدو المصدرُ معطَّلاً وهو سليم. والحدُّ عندنا قائمٌ على أي حال في
     `adapt` بسقفَي المقطع والمجموع. */
  const args: Record<string, unknown> = {
    ...source.args,
    [source.queryField]: query,
    ...(source.limitField ? { [source.limitField]: source.maxResults } : {}),
  };
  const outcome = await callTool(env, source, token, source.searchTool, args);
  if (!outcome.ok) {
    console.error(`external ${source.id}: ${outcome.kind}: ${outcome.message}`);
    return {
      ...base,
      status: outcome.kind === 'config' ? 'unconfigured' : 'unreachable',
      hits: [],
      error: outcome.message,
      ...(outcome.resourceMetadata ? { resourceMetadata: outcome.resourceMetadata } : {}),
    };
  }
  return { ...base, status: 'ok', hits: adapt(source, outcome.data) };
}

/**
 * يبحث في كلّ مصادر دورٍ بالتوازي.
 *
 * `allSettled` لا `all`: مصدرٌ بطيء لا يحبس غيره، وساقطٌ لا يُسقط الدور.
 * وكلُّ مصدرٍ يعود بحالته — ومصدرٌ لم يُجب تُقال حالُه ولا تُقرأ مجموعتُه
 * الفارغة «لا نتائج»، فيظنّ القارئ أن كتب الفقه خَلَت من مسألته وهي لم
 * تُسأل أصلاً (`naf-terms.md` — «تعذّر الوصول إلى المصدر»).
 */
export async function searchSources(
  env: Env,
  sources: ExternalSource[],
  query: string
): Promise<SourceOutcome[]> {
  if (!sources.length || !query.trim()) return [];
  const settled = await Promise.allSettled(sources.map((s) => searchSource(env, s, query)));
  return settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          sourceId: sources[i].id,
          sourceLabel: sources[i].label,
          status: 'unreachable' as const,
          hits: [],
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        }
  );
}

/**
 * كتلةُ التدعيم الفقهي في البرومبت — مستقلّةٌ عن `<سياق_نظامي>` عمداً.
 *
 * وسمان مختلفان لأن منزلتيهما مختلفتان: ذاك سندٌ يُلزم، وهذا تأصيلٌ يقوّي.
 * ولو جاءا في وسمٍ واحد لَما بقي في السياق ما يفرّقهما، ولخرجت مادةٌ نظامية
 * وقولُ فقيهٍ في فقرةٍ واحدة بصياغةٍ واحدة — في مذكرةٍ تُرفع لمحكمة.
 *
 * وسطرُ التنبيه فوق النصّ لا تحته، كما في `noticeLines()` بـ`lib/rag.ts`:
 * ما يُقرأ بعد النصّ يُقرأ متأخّراً.
 */
export function formatFiqhContext(hits: ExternalHit[]): string {
  if (!hits.length) return '';
  const blocks = hits
    .map((h, i) => {
      const cite = [h.title, h.author, h.ref ? `ص. ${h.ref}` : '', h.category]
        .filter(Boolean)
        .join(' — ');
      const notice =
        h.section === 'حاشية'
          ? 'تنبيه: هذا المقطع من الحاشية، وهو كلام المحقِّق لا المصنِّف — فلا يُنسب إليه.\n'
          : '';
      return `[${i + 1}] ${cite} (${h.sourceLabel})\n${notice}${h.text}`;
    })
    .join('\n\n---\n\n');
  return `\n\n<تدعيم_فقهي>\nالمقاطع التالية من كتب الفقه، للتأصيل والتقوية. **ليست أنظمةً سعودية ولا تقوم مقامها**: تُذكر في قسمٍ ختاميّ وحده عنوانه «التأصيل الفقهي»، منسوبةً إلى كتابها ومؤلِّفها وصفحتها، ولا تُخلط بمواد الأنظمة ولا تُصاغ صياغةَ الإلزام. وما سبقه سطرٌ يبدأ بـ«تنبيه:» فالتنبيه جزءٌ منه لا حاشيةٌ عليه — انقله مع النسبة:\n\n${blocks}\n</تدعيم_فقهي>`;
}
