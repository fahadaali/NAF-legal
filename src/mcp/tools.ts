/**
 * أدوات القراءة في خادم MCP — الأنظمة واللوائح وتصنيفاتها ومكتبة البنود.
 *
 * **ولا أداةَ هنا تنادي نموذجاً.** كلُّها قراءةٌ من D1، والدلاليُّ في البحث
 * تضمينٌ من Workers AI (`bge-m3`) لا نداءٌ لـAnthropic. فالذي يفكّر ويكتب
 * الجواب نموذجُ الأداة نفسها على اشتراك صاحبها، والمنصة تعطيه النصوص فقط.
 * ومن ثمّ لا مكان هنا للبحث المعمّق ولا المخطِّط ولا التوسيم ولا التوليد:
 * كلُّها تنادي Claude المنصة.
 *
 * **والنطاق ما ليس سرّاً** (قرار صاحب المنصة): الأنظمة واللوائح، وتصنيفاتها،
 * والمسائل القانونية المعتمدة، والإحالات وسجلّ التعديلات، ومكتبة البنود —
 * للعضو والضيف معاً. ولا تصل أداةٌ إلى القضايا ولا الملفات ولا قاعدة المعرفة
 * الداخلية ولا محادثات غير صاحبها.
 *
 * **وتصفية السريان والحجب كما في المنصة حرفاً.** كلُّ أداةٍ تمرّ بـ`searchLegal`
 * و`getArticle` و`getChunkById` و`getHitsBySeqs` نفسها، فما تحجبه المنصة —
 * الملغى، وما ينتظر المراجعة، والمعطوب — محجوبٌ هنا بالشرط نفسه في SQL. ولا
 * يُفتح الملغى إلا بطلبٍ صريح، كما في `/api/legal/search`.
 *
 * **والتنبيهات فوق النصّ لا بعده.** كلُّ مادةٍ تُنسَّق بـ`formatRagBlock`
 * نفسها التي تبني سياق التوليد في المنصة، فتصل الأداةَ بتنبيهها («عُدّلت،
 * والنصّ أصلي»، «نفاذٌ مؤجَّل») كما يصل Claude المنصة. وأخطرُ خطأ في منتجٍ
 * قانوني أن يُستشهد بنصٍّ أصليٍّ على أنه الجاري.
 */
import type { Env } from '../types';
import {
  DOC_TYPES,
  RETRIEVAL_REPEALED,
  searchLegal,
  getArticle,
  getChunkById,
  getHitsBySeqs,
  getDefinitionsArticle,
  getChunkAmendment,
  hiddenReason,
  resolveLawByTitle,
  listLaws,
  listLawArticles,
  lawArticleStats,
  listLawBooks,
  listLawChanges,
  getLawWithRegulations,
  withAttachments,
  withParts,
  canonicalDocType,
  articleBaseId,
} from '../lib/legal';
import type { LegalHit, LawSummary } from '../lib/legal';
import { joinArticleParts, fromLegalHit, formatRagBlock } from '../lib/rag';
import { approvedIssues } from '../lib/research/issues';
import { arabicGlobPatterns } from '../lib/arabic';
import { dualDate } from '../lib/hijri';
import { argBool, argInt, argString } from './protocol';
import type { McpTool, McpToolResult } from './protocol';

/** سقفُ محرّك البحث نفسه (`searchLegal`) — لا حدٌّ للمنصة على الاستخدام. */
const SEARCH_MAX = 50;

const ok = (text: string): McpToolResult => ({ text });
const refuse = (text: string): McpToolResult => ({ text, isError: true });

/** حالُ النظام سطراً: ساري، ملغى، لم يبدأ العمل به. */
/**
 * حالُ النظام سطراً — بألفاظ «حال النظام» المسجّلة (`naf-terms.md` §٣):
 * «نظام لاغٍ»، و«لم يبدأ العمل به — من ‹التاريخ›». والتاريخ ميلاديّ يتبعه
 * الهجريّ (§٨): تاريخُ نفاذٍ يُستشهد به.
 */
function lawState(l: LawSummary): string {
  if (l.law_repealed) return 'نظام لاغٍ';
  if (l.law_pending) {
    return l.law_effective_from
      ? `لم يبدأ العمل به — من ${dualDate(l.law_effective_from)}`
      : 'لم يبدأ العمل به — وتاريخ نفاذه غير مسجّل في المنصة';
  }
  /* وما سواهما نافذ — **ولا يُعاد نصُّ `law_status` المحفوظ أبداً.**
     ذاك لفظُ بطاقة البوابة يوم الاستيراد: نظامٌ استُورد قبل نفاذه يبقى لفظُه
     «لم يبدأ العمل به» بعد أن يحلّ تاريخه ويُعمل به. وكان يُعاد هنا حين لا يكون
     الحالُ المحسوب «ملغى» ولا «لم يبدأ» — فقرأت الأداةُ نظام التنفيذ (م/237)
     «لم يبدأ العمل به» وقد بدأ. والحالُ هنا محسوبٌ عند كل استعلام: الإلغاءُ من
     ‎law_repealed‎، والنفاذُ من ‎law_pending‎ مقيَّماً بتاريخ ‎law_effective_from‎
     في ‎listLaws‎ — فيتبدّل وحده حين يحلّ التاريخ، بلا دفعةٍ جديدة ولا يدٍ تعود إليه. */
  return 'نافذ';
}

/**
 * المادةُ ملغاة؟ بالشروط الثلاثة التي تحجبها بها المنصة (`EFFECTIVE_SQL`):
 * حالُ الاسترجاع، أو أحد الحقلين القديمين. والأوّل يشمل إلغاءَ النظام كلِّه
 * والإلغاءَ المجدول الذي حلّ يومه — وكانت الأداة تقرأ `isRepealed` وحده، فتصل
 * مادةُ نظامٍ لاغٍ بلا وسمٍ يقول إنها ملغاة.
 */
function isRepealedHit(h: LegalHit): boolean {
  return h.retrievalStatus === RETRIEVAL_REPEALED || h.isRepealed || h.status === 'repealed';
}

/**
 * سطورُ حال المادة، فوق نصّها مع تنبيهاتها.
 *
 * المنصة تعرض هذه الأحوال وسوماً في بطاقة المادة؛ والأداةُ لا ترى بطاقة، فتصلها
 * سطوراً بالألفاظ المسجّلة نفسها. وما يغيّر حكمَ الاستشهاد يبدأ بـ«تنبيه:» —
 * والتعليمات تُلزم الأداة بنقله مع النصّ: الملغاة، والمجدولُ إلغاؤها. وما
 * سواهما وصفٌ يُعين الباحث: لم يبدأ العمل به بتاريخه، والمستبقاة، والتعديلات
 * وطريقُ نسخها السابقة، والرقمُ السابق.
 *
 * والغايةُ أن تصل الموادّ كلُّها بحالها — النافذة والمعدَّلة والتي لم يبدأ
 * العمل بها والملغاة حين تُطلب — لا أن يُحجب منها ما يحتاجه باحثٌ في نصٍّ
 * سابق، ولا أن يُقرأ منها ما ليس جارياً على أنه جارٍ.
 */
function statusLines(h: LegalHit): string[] {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  if (isRepealedHit(h)) {
    const how =
      h.lawRepealed && !h.keptAfterRepeal
        ? ' — نظام لاغٍ'
        : h.scheduledRepealFrom && h.scheduledRepealFrom <= today
          ? ` — منذ ${dualDate(h.scheduledRepealFrom)}`
          : '';
    lines.push(`تنبيه: الحال: ملغاة${how}. نصٌّ سابق لا يُستشهد به على أنه نافذ، ويُذكر بحاله إن ذُكر.`);
  } else {
    if (h.scheduledRepealFrom && h.scheduledRepealFrom > today) {
      lines.push(`تنبيه: تُلغى في ${dualDate(h.scheduledRepealFrom)} — نافذةٌ إلى ذلك اليوم.`);
    }
    if (h.lawPending) {
      lines.push(`الحال: لم يبدأ العمل به — من ${h.lawEffectiveFrom ? dualDate(h.lawEffectiveFrom) : 'تاريخٍ لم يُذكر'}`);
    }
    if (h.keptAfterRepeal) lines.push('الحال: مستبقاة بعد إلغاء النظام — نافذةٌ وإن أُلغي نظامها.');
  }
  if (h.hasAmendments) {
    // «عددُ …: N» لا «N مرّات»: صيغةٌ تصحّ مع كل عدد، والعدد العربي يتغيّر معدودُه
    // بين الاثنين والعشرة وما فوقها.
    const times = h.amendmentsCount && h.amendmentsCount > 1 ? ` — عددُ تعديلاتها: ${h.amendmentsCount}` : '';
    const current = h.amendmentApplied ? ' — والنصّ المعروض هو الجاري بعد التعديل' : '';
    lines.push(`عُدّلت${times}${current}. نصوصُها السابقة وأدواتُ تعديلها وتواريخُها: get_article_amendment.`);
  }
  if (h.formerArticleNo) lines.push(`الرقم السابق: المادة ${h.formerArticleNo}`);
  return lines;
}

function docTypeLabel(v: string | null): string {
  return (v && DOC_TYPES[v]) || v || '—';
}

/** بطاقة نظامٍ في سطرين — المعرّف أوّلاً لأن الأدوات الأخرى تأخذه. */
function formatLaw(l: LawSummary): string {
  const issued = [l.instrument, l.instrument_no].filter(Boolean).join(' ');
  const date = l.issue_date ? (l.issue_date_hijri ? `${l.issue_date} (${l.issue_date_hijri})` : l.issue_date) : l.issue_date_hijri;
  return [
    `- ${l.law_title ?? l.law_id} — law_id: ${l.law_id}`,
    `  النوع: ${docTypeLabel(l.doc_type)} · الحال: ${lawState(l)}${l.parent_law_id ? ` · لائحةٌ لـ law_id: ${l.parent_law_id}` : ''}`,
    [issued && `  الأداة: ${issued}`, date && `التاريخ: ${date}`, l.authority && `الجهة: ${l.authority}`]
      .filter(Boolean)
      .join(' · '),
  ]
    .filter((line) => line.trim())
    .join('\n');
}

/**
 * مادةٌ للأداة: سطرُ مصدرها وتنبيهاتُها ونصُّها كما تبنيها المنصة لسياقها،
 * ومعها معرّفُها وموضعُها في النظام لتستدعيها الأداة أو تستشهد بها.
 */
function formatHits(hits: LegalHit[]): string {
  const joined = joinArticleParts(hits);
  return joined
    .map((h, i) => {
      const where = [h.book && `الباب: ${h.book}`, h.chapter && `الفصل: ${h.chapter}`, h.section && `الفرع: ${h.section}`]
        .filter(Boolean)
        .join(' · ');
      const meta = [
        `id: ${articleBaseId(h.id)}`,
        h.lawId && `law_id: ${h.lawId}`,
        `النوع: ${docTypeLabel(h.docType)}`,
        h.articleTitle && `العنوان: ${h.articleTitle}`,
      ]
        .filter(Boolean)
        .join(' · ');
      const block = formatRagBlock(fromLegalHit(h), i + 1);
      // سطرُ الموضع والمعرّف بعد سطر المصدر، ثم سطورُ الحال — والتنبيهات كلُّها
      // فوق النصّ.
      const nl = block.indexOf('\n');
      const status = statusLines(h);
      return `${block.slice(0, nl)}\n${meta}${where ? `\n${where}` : ''}${status.length ? `\n${status.join('\n')}` : ''}${block.slice(nl)}`;
    })
    .join('\n\n---\n\n');
}

const ID_HINT = 'معرّف المادة (id) كما ورد في نتائج البحث.';

/**
 * صفحةٌ من قائمةٍ طويلة — فهرس الأنظمة ومكتبة البنود.
 *
 * كانتا تُعادان كاملتين: مئاتُ الأنظمة أو مئتا بندٍ بنصوصها في ردٍّ واحد يملأ
 * سياق الأداة — وبعض الأدوات تقصّ ما زاد على حدٍّ لها فيضيع آخر القائمة بلا
 * علامة. فالصفحةُ تقول موضعها من الكلّ وكيف تُطلب التالية.
 */
const LIST_DEFAULT = 50;
const LIST_MAX = 200;

function paginate<T>(all: T[], args: Record<string, unknown>): { page: T[]; header: string; next: string } {
  const offset = argInt(args, 'offset', 0, 0, 1_000_000);
  const limit = argInt(args, 'limit', LIST_DEFAULT, 1, LIST_MAX);
  const page = all.slice(offset, offset + limit);
  const header = page.length
    ? `العدد: ${all.length} — المعروض ${offset + 1}–${offset + page.length}`
    : `العدد: ${all.length} — لا شيء بعد هذا الموضع`;
  const next = offset + page.length < all.length ? `\n\nالتالي: offset ${offset + page.length}` : '';
  return { page, header, next };
}

export function readTools(env: Env): McpTool[] {
  return [
    {
      name: 'search_regulations',
      title: 'البحث في الأنظمة واللوائح',
      description:
        'بحثٌ هجين (دلاليّ ولفظيّ) في الأنظمة واللوائح السعودية على منصة مستشار ناف. ' +
        'يُرجع الموادّ بنصّها ومصدرها وحالها: نافذة، أو معدَّلة (ونصوصُها السابقة في get_article_amendment)، ' +
        'أو لم يبدأ العمل بها (بتاريخ نفاذها)، أو تُلغى في تاريخٍ قادم. ' +
        'ضيّق البحث بـ law_id (من list_laws) أو doc_type أو book أو issue_key (من list_legal_issues). ' +
        'الموادّ الملغاة لا تُخلط بالنافذة افتراضياً، ويُذكر عددُ ما طابق منها؛ ' +
        'ومع include_repealed: true تظهر بوسم «ملغاة» — لسؤالٍ تاريخيّ أو مقارنةٍ بنصٍّ سابق.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'سؤالٌ أو كلماتٌ بالعربية. يجوز تركه مع law_id أو issue_key للتصفّح.' },
          law_id: { type: 'string', description: 'حصرٌ في نظامٍ ولوائحه.' },
          doc_type: { type: 'string', enum: Object.keys(DOC_TYPES), description: 'نوع الوثيقة.' },
          article_no: { type: 'string', description: 'رقم المادة.' },
          book: { type: 'string', description: 'الباب كما ورد في النظام (من get_law).' },
          issue_key: { type: 'string', description: 'مسألةٌ قانونية معتمدة (من list_legal_issues).' },
          mode: { type: 'string', enum: ['hybrid', 'lexical'], description: 'hybrid افتراضياً؛ lexical لمطابقة الألفاظ وحدها.' },
          include_repealed: {
            type: 'boolean',
            description: 'إظهار الموادّ الملغاة مع النافذة، كلٌّ بحاله. لسؤالٍ عن نصٍّ سابق أو نظامٍ لاغٍ. الافتراضي لا.',
          },
          limit: { type: 'integer', minimum: 1, maximum: SEARCH_MAX, description: 'عدد النتائج. الافتراضي 10.' },
        },
      },
      async run(args) {
        const query = argString(args, 'query', 1000) ?? '';
        const lawId = argString(args, 'law_id', 200);
        const issueKey = argString(args, 'issue_key', 200);
        if (!query && !lawId && !issueKey) return refuse('اكتب query، أو حدّد law_id أو issue_key للتصفّح.');
        const docTypeRaw = argString(args, 'doc_type', 50);
        const includeRepealed = argBool(args, 'include_repealed');
        const scope = {
          lawId,
          docType: docTypeRaw ? (canonicalDocType(docTypeRaw) ?? docTypeRaw) : null,
          articleNo: argString(args, 'article_no', 50),
          book: argString(args, 'book', 300),
          issueKey,
        };
        const hits = await searchLegal(env, query, {
          ...scope,
          limit: argInt(args, 'limit', 10, 1, SEARCH_MAX),
          includeRepealed,
          lexicalOnly: argString(args, 'mode', 20) === 'lexical',
        });
        /* الملغاة لا تُخلط بالنافذة، ولا تختفي: يُعدّ ما طابق منها بحثاً لفظياً بالنطاق
           نفسه — بلا نداء تضمين — ويُقال عددُه وكيف تُطلب. فالباحث في نصٍّ سابق يعرف
           أن له في المنصة جواباً، ومن يسأل عن الجاري لا يقرأ نصّاً سابقاً في نتائجه. */
        let repealedNote = '';
        if (!includeRepealed) {
          const all = await searchLegal(env, query, { ...scope, limit: SEARCH_MAX, includeRepealed: true, lexicalOnly: true }).catch(
            () => [] as LegalHit[]
          );
          const repealed = joinArticleParts(all).filter(isRepealedHit).length;
          if (repealed) {
            repealedNote =
              `عددُ الموادّ الملغاة المطابقة للبحث وغير المعروضة هنا: ${repealed}. ` +
              'إن كان السؤال عن نصٍّ سابق أو نظامٍ لاغٍ، أعد البحث مع include_repealed: true فتظهر كلٌّ بحالها.';
          }
        }
        if (!hits.length) {
          return ok(
            ['لم يُعثر على موادّ نافذة مطابقة. وسّع البحث: احذف مرشّحاً، أو جرّب لفظاً آخر، أو mode: hybrid.', repealedNote]
              .filter(Boolean)
              .join('\n\n')
          );
        }
        return ok(`${formatHits(hits)}${repealedNote ? `\n\n===\n\n${repealedNote}` : ''}`);
      },
    },

    {
      name: 'get_article',
      title: 'استدعاء مادة',
      description:
        'نصّ مادةٍ بعينها كاملاً مع أجزائها ومرفقاتها وحالها وتنبيهاتها. ' +
        'الملغاة تُستدعى مع include_repealed: true، ونصوصُ المادة قبل تعديلها في get_article_amendment. ' +
        'بأحد ثلاثة: id، أو law_id مع article_no، أو law_title مع article_no.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: ID_HINT },
          law_id: { type: 'string' },
          law_title: { type: 'string', description: 'اسم النظام بالمطابقة التامّة.' },
          article_no: { type: 'string' },
          include_repealed: { type: 'boolean' },
        },
      },
      async run(args) {
        const includeRepealed = argBool(args, 'include_repealed');
        const id = argString(args, 'id', 300);
        if (id) {
          const hit = await getChunkById(env, id, includeRepealed);
          if (hit) {
            const scope = { lawId: hit.lawId, withRegulations: false, includeRepealed };
            return ok(formatHits(await withAttachments(env, await withParts(env, [hit], scope), scope)));
          }
          // يُقال لماذا غابت — كما في `/api/legal/article`.
          const reason = await hiddenReason(env, id);
          if (reason === 'repealed') return refuse('المادة منسوخة — أعد الطلب مع include_repealed: true للاطّلاع عليها.');
          if (reason === 'review') return refuse('المادة بانتظار المراجعة في المنصة، ولا يُستشهد بها حتى تُعتمد.');
          return refuse('المادة غير موجودة.');
        }
        const articleNo = argString(args, 'article_no', 50);
        const lawTitle = argString(args, 'law_title', 300);
        let lawId = argString(args, 'law_id', 200);
        if (!lawId && lawTitle) {
          const byTitle = await resolveLawByTitle(env, lawTitle);
          if (byTitle?.ambiguous) return refuse('في المنصة أكثر من نظامٍ بهذا الاسم. اختر law_id من list_laws.');
          lawId = byTitle?.lawId ?? null;
          if (!lawId) return refuse('لا نظام بهذا الاسم. ابحث عنه بـ list_laws.');
        }
        if (!lawId || !articleNo) return refuse('المطلوب: id، أو law_id مع article_no، أو law_title مع article_no.');
        const hits = await getArticle(env, { lawId, articleNo, includeRepealed });
        if (!hits.length) {
          // ملغاةٌ لا مفقودة: يُقال ذلك كما يُقال في الاستدعاء بالمعرّف، لا «غير موجودة».
          if (!includeRepealed && (await getArticle(env, { lawId, articleNo, includeRepealed: true })).length) {
            return refuse('المادة ملغاة — أعد الطلب مع include_repealed: true للاطّلاع على نصّها بحاله.');
          }
          return refuse('المادة غير موجودة.');
        }
        return ok(formatHits(hits));
      },
    },

    {
      name: 'list_laws',
      title: 'فهرس الأنظمة واللوائح',
      description:
        'الأنظمة واللوائح والتنظيمات والقرارات والتعاميم في المنصة بتصنيفها وحالها وأداة إصدارها وجهتها. ' +
        'منه يُؤخذ law_id لبقية الأدوات.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'جزءٌ من اسم النظام أو الجهة.' },
          doc_type: { type: 'string', enum: Object.keys(DOC_TYPES) },
          include_repealed: { type: 'boolean', description: 'إظهار الأنظمة الملغاة كلّها. الافتراضي لا.' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: LIST_MAX, description: `الافتراضي ${LIST_DEFAULT}.` },
        },
      },
      async run(args) {
        const q = argString(args, 'query', 200);
        const docTypeRaw = argString(args, 'doc_type', 50);
        const docType = docTypeRaw ? (canonicalDocType(docTypeRaw) ?? docTypeRaw) : null;
        const includeRepealed = argBool(args, 'include_repealed');
        const patterns = q ? arabicGlobPatterns(q).map(globToRegex) : [];
        const matching = (await listLaws(env)).filter(
          (l) =>
            (!docType || l.doc_type === docType) &&
            patterns.every((re) => re.test(`${l.law_title ?? ''} ${l.authority ?? ''}`))
        );
        const laws = includeRepealed ? matching : matching.filter((l) => !l.law_repealed);
        // الأنظمة اللاغية لا تختفي: يُقال عددُها وكيف تُطلب، كما في البحث.
        const hiddenRepealed = matching.length - laws.length;
        const repealedNote = hiddenRepealed
          ? `\n\nعددُ الأنظمة اللاغية المطابقة للطلب وغير المعروضة هنا: ${hiddenRepealed} — أعد الطلب مع include_repealed: true.`
          : '';
        if (!laws.length) return ok(`لا أنظمة نافذة مطابقة. جرّب لفظاً أقصر أو احذف doc_type.${repealedNote}`);
        const types = Object.entries(DOC_TYPES)
          .map(([k, v]) => `${k}: ${v}`)
          .join(' · ');
        const { page, header, next } = paginate(laws, args);
        return ok(`أنواع الوثائق — ${types}\n${header}\n\n${page.map(formatLaw).join('\n')}${next}${repealedNote}`);
      },
    },

    {
      name: 'get_law',
      title: 'بطاقة نظام',
      description:
        'بطاقة نظامٍ بحاله وأداة إصداره، وعددُ موادّه بحالها (نافذة، ملغاة، معدَّلة، تُلغى لاحقاً)، ولوائحه، وأبوابه بترتيبها. ' +
        'لسؤالٍ مثل «كم مادةً ملغاة في نظام كذا». ولسرد تلك الموادّ: browse_law_articles مع only.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: { law_id: { type: 'string' } },
        required: ['law_id'],
      },
      async run(args) {
        const lawId = argString(args, 'law_id', 200);
        if (!lawId) return refuse('law_id مطلوب.');
        const { law, regulations } = await getLawWithRegulations(env, lawId);
        if (!law) return refuse('النظام غير موجود.');
        const [books, st] = await Promise.all([listLawBooks(env, lawId), lawArticleStats(env, lawId)]);
        const parts = [formatLaw(law)];
        if (law.source_url) parts.push(`المصدر الرسمي: ${law.source_url}`);
        // بالمادة لا بالمقطع: أجزاءُ المادة الواحدة مادةٌ واحدة، والمرفقُ والملحق خارج العدّ.
        parts.push(
          [
            'إحصاءُ الموادّ (بالمادة لا بأجزائها، بلا المرفقات والملاحق، وبلا ما ينتظر المراجعة):',
            `- عددُ الموادّ: ${st.articles}`,
            `- النافذة: ${st.effective}`,
            `- الملغاة: ${st.repealed}`,
            `- المعدَّلة: ${st.amended}${st.amendedUnmerged ? ` — منها لم يُدمج تعديلُها في نصّها: ${st.amendedUnmerged}` : ''}`,
            st.scheduledRepeal ? `- تُلغى في تاريخٍ قادم: ${st.scheduledRepeal}` : '',
            'ولسردها: browse_law_articles مع only: repealed أو amended أو amended_unmerged أو scheduled_repeal.',
          ]
            .filter(Boolean)
            .join('\n')
        );
        parts.push(books.length ? `الأبواب:\n${books.map((b) => `- ${b}`).join('\n')}` : 'لا أبواب مسجّلة.');
        parts.push(regulations.length ? `اللوائح والتنظيمات التابعة:\n${regulations.map(formatLaw).join('\n')}` : 'لا لوائح تابعة.');
        return ok(parts.join('\n\n'));
      },
    },

    {
      name: 'browse_law_articles',
      title: 'تصفّح موادّ نظام',
      description:
        'موادّ نظامٍ بترتيب ورودها فيه، صفحةً صفحة — لقراءة النظام متتابعاً. ' +
        'ومع only تُسرد موادُّ حالٍ واحدة: الملغاة (repealed)، أو المعدَّلة (amended)، ' +
        'أو التي لم يُدمج تعديلُها (amended_unmerged)، أو التي تُلغى في تاريخٍ قادم (scheduled_repeal).',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          law_id: { type: 'string' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'الافتراضي 20.' },
          include_repealed: { type: 'boolean' },
          only: {
            type: 'string',
            enum: ['repealed', 'amended', 'amended_unmerged', 'scheduled_repeal'],
            description: 'حصرُ التصفّح في حالٍ واحدة.',
          },
        },
        required: ['law_id'],
      },
      async run(args) {
        const lawId = argString(args, 'law_id', 200);
        if (!lawId) return refuse('law_id مطلوب.');
        const offset = argInt(args, 'offset', 0, 0, 1_000_000);
        const onlyRaw = argString(args, 'only', 30);
        const only = (['repealed', 'amended', 'amended_unmerged', 'scheduled_repeal'] as const).find((o) => o === onlyRaw) ?? null;
        const includeRepealed = argBool(args, 'include_repealed') || only === 'repealed';
        const { articles, total } = await listLawArticles(env, lawId, {
          offset,
          limit: argInt(args, 'limit', 20, 1, 100),
          // التصفّح يُظهر الملغى في المنصة افتراضياً؛ وهنا بطلب — الأداة تستشهد بما
          // تقرأ. ولا يختفي: يُقال عددُ ما حُجب منه أدناه، ومع الطلب يظهر بوسمه.
          includeRepealed,
          // والمحجوبُ للمراجعة لا يصل الأداة أبداً — شاشةُ التصفّح في المنصة وحدها
          // تُظهره. وكان يصل هنا من الإعداد الافتراضي لتلك الشاشة.
          includeDefective: false,
          only,
        });
        let repealedNote = '';
        if (!includeRepealed && !only) {
          const all = await listLawArticles(env, lawId, { offset: 0, limit: 1, includeRepealed: true, includeDefective: false });
          const hidden = all.total - total;
          if (hidden > 0) {
            repealedNote = `\n\nعددُ الموادّ الملغاة في هذا النظام وغير المعروضة هنا: ${hidden} — أعد الطلب مع include_repealed: true فتظهر بترتيبها وحالها.`;
          }
        }
        if (!articles.length) {
          const none = only ? 'لا موادّ بهذه الحال في هذا النظام.' : 'لا موادّ نافذة لهذا النظام.';
          return ok(`${total ? 'لا موادّ بعد هذا الموضع.' : none}${repealedNote}`);
        }
        const next = offset + articles.length < total ? `\n\nالتالي: offset ${offset + articles.length}` : '';
        return ok(`الموادّ ${offset + 1}–${offset + articles.length} من ${total}\n\n${formatHits(articles)}${next}${repealedNote}`);
      },
    },

    {
      name: 'get_article_amendment',
      title: 'تعديلات مادة',
      description:
        'سجلّ تعديل مادةٍ: نصوصُها السابقة والجاري بالترتيب، وأدواتُ التعديل وتواريخها، وهل دُمج آخرُها في النصّ. ' +
        'لسؤالٍ عن نصّ المادة قبل تعديلها أو في تاريخٍ مضى. ويعمل على الملغاة أيضاً.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: ID_HINT } },
        required: ['id'],
      },
      async run(args) {
        const id = argString(args, 'id', 300);
        if (!id) return refuse('id مطلوب.');
        // الاطّلاع على التعديل يمرّ بشرط الحجب نفسه: مادةٌ بانتظار المراجعة لا يُقرأ سجلّها هنا.
        const visible = await getChunkById(env, id, true);
        if (!visible) return refuse('المادة غير موجودة أو بانتظار المراجعة.');
        const a = await getChunkAmendment(env, id);
        if (!a) return refuse('المادة غير موجودة.');
        const lines = [
          `id: ${a.id}`,
          a.amendments_count
            ? `عددُ التعديلات: ${a.amendments_count} · آخرها مدموجٌ في النصّ: ${a.amendment_applied ? 'نعم' : 'لا'}`
            : '',
          // تعديلٌ لم يُدمج: النصُّ المعروض للمادة هو الأصليّ نفسه — وهو جوابُ «النصّ
          // قبل التعديل» مباشرةً، فيُقال ولا يُترك للاستنتاج.
          a.amendments_count && !a.amendment_applied
            ? 'النصّ المعروض للمادة في get_article هو نصُّها الأصليّ قبل التعديل: التعديل لم يُدمج فيه، ونصُّه أدناه إن ورد.'
            : '',
          [a.amendment_instrument && `أداة التعديل: ${a.amendment_instrument}`, a.amended_on && `بتاريخ: ${a.amended_on}`]
            .filter(Boolean)
            .join(' · '),
          a.amend_note ? `ملاحظة: ${a.amend_note}` : '',
          a.source_url ? `المصدر الرسمي: ${a.source_url}` : '',
        ].filter(Boolean);

        /* النصُّ السابق في ثلاثة مواضع، يُعرض منها ما وُجد:
           ١) خطُّ النصوص الزمنيّ في ملف الاستيراد (`versions`) — الأصليُّ وما بعده.
           ٢) سجلُّ أحداث التعديل (`events`) — وفيه النصُّ الذي جاء به كلُّ تعديل،
              ولو لم يُدمج: فيُنقل بحروفه بدل أن يُصاغ.
           ٣) أرشيفُ المنصة (`legal_chunk_versions`) — ما أزاحه تحديثٌ لاحق. وتصحيحُ
              خطأ سحبٍ سابق (`correction`) ليس نصّاً نظامياً سابقاً، فلا يُعرض.
           وإن لم يوجد شيءٌ منها قيل ذلك صراحةً: صمتُ الأداة يدفع النموذج إلى صوغ
           «النصّ الأصلي» من عنده. */
        const shown = new Set<string>();
        const earlier = a.versions.filter((v) => !v.current);
        if (earlier.length) {
          lines.push(
            '',
            'نسخُ النصّ بالترتيب، من الأقدم إلى الأحدث. «(الجاري)» هو النافذ اليوم، وما قبله نصوصٌ سابقة: ' +
              'تُنقل بحروفها لمن يطلبها، بأداة تعديلها وتاريخها، ولا يُستشهد بها على أنها نافذة.' +
              (a.amendment_applied ? '' : ' وآخرُ تعديلٍ لم يُدمج في النصّ الجاري: لا تصغ النافذ من عندك.'),
            // مرقّمةً بترتيبها لا بـ`seq`: ذاك مفتاحُ ترتيبٍ قد يبدأ من الصفر.
            ...a.versions.map((v, i) => {
              shown.add(v.text.trim());
              return `\n[${i + 1}]${v.current ? ' (الجاري)' : ''}${v.label ? ` ${v.label}` : ''}${
                v.from_instrument ? ` — ${v.from_instrument}` : ''
              }${v.from_date ? ` ${v.from_date}` : ''}\n${v.text}`;
            })
          );
        } else if (a.text_superseded) {
          shown.add(a.text_superseded.trim());
          lines.push('', 'النصّ السابق (قبل آخر تعديل):', a.text_superseded);
        }

        const events = a.events.filter((e) => e.new_text || e.instrument || e.instrument_no || e.date_hijri);
        if (events.length) {
          lines.push(
            '',
            'أحداثُ التعديل كما وردت — أداةُ كلٍّ وتاريخُه، وهل دُمج، والنصُّ الذي جاء به:',
            ...events.map(
              (e, i) =>
                `\n[${i + 1}] ${[e.instrument, e.instrument_no].filter(Boolean).join(' ') || 'تعديل'}${e.date_hijri ? ` — ${e.date_hijri}` : ''}` +
                ` — ${e.applied ? 'مدموجٌ في النصّ' : 'لم يُدمج'}${e.new_text ? `\nالنصّ الذي جاء به:\n${e.new_text}` : ''}`
            )
          );
        }

        const base = articleBaseId(a.id);
        const archived = await env.DB.prepare(
          `SELECT text, amended_on, amendment_instrument FROM legal_chunk_versions
           WHERE (chunk_id = ? OR chunk_id LIKE ? ESCAPE '\\')
             AND (change_kind IS NULL OR change_kind <> 'correction') AND instr(changed_fields, 'text') > 0
           ORDER BY archived_at ASC LIMIT 20`
        )
          .bind(base, `${base.replace(/[\\%_]/g, (m) => `\\${m}`)}#%`)
          .all<{ text: string; amended_on: string | null; amendment_instrument: string | null }>();
        const fresh = (archived.results ?? []).filter((r) => !shown.has(r.text.trim()));
        if (fresh.length) {
          lines.push(
            '',
            'نصوصٌ سابقة أزاحتها تحديثاتُ المنصة، من الأقدم:',
            ...fresh.map(
              (r, i) =>
                `\n[${i + 1}]${r.amendment_instrument ? ` ${r.amendment_instrument}` : ''}${r.amended_on ? ` — ${r.amended_on}` : ''}\n${r.text}`
            )
          );
        }

        if (!earlier.length && !a.text_superseded && !events.some((e) => e.new_text) && !fresh.length) {
          lines.push(
            '',
            a.amendments_count
              ? 'لا يحفظ سجلُّ المنصة نصّاً سابقاً لهذه المادة ولا نصَّ تعديلها. فلا تصغ النصّ الأصلي من عندك: ' +
                  'قل إنه غير متاح في المنصة، وأحِل إلى المصدر الرسمي.'
              : 'لا تعديل على هذه المادة في سجلّ المنصة: نصُّها المعروض هو نصُّها منذ صدورها.'
          );
        }
        return ok(lines.join('\n'));
      },
    },

    {
      name: 'get_law_changes',
      title: 'سجلّ تحديث نظام',
      description: 'ما أُزيح من موادّ نظامٍ بالتعديل أو التصحيح، أحدثه أولاً، مع النصّ السابق والجاري.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          law_id: { type: 'string' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['law_id'],
      },
      async run(args) {
        const lawId = argString(args, 'law_id', 200);
        if (!lawId) return refuse('law_id مطلوب.');
        const offset = argInt(args, 'offset', 0, 0, 1_000_000);
        const { changes, total } = await listLawChanges(env, lawId, { offset, limit: argInt(args, 'limit', 25, 1, 100) });
        if (!changes.length) return ok('لا تغييرات مسجّلة لهذا النظام.');
        const body = changes
          .map((c) =>
            [
              `- المادة ${c.article_no ?? '—'}${c.current_article_no && c.current_article_no !== c.article_no ? ` (اليوم ${c.current_article_no})` : ''}`,
              `  ${c.change_kind === 'correction' ? 'تصحيح' : 'تعديل'}${c.amendment_instrument ? ` — ${c.amendment_instrument}` : ''}${c.amended_on ? ` ${c.amended_on}` : ''}`,
              `  النصّ السابق: ${c.text}`,
              c.current_text ? `  النصّ الجاري: ${c.current_text}` : '',
            ]
              .filter(Boolean)
              .join('\n')
          )
          .join('\n');
        const next = offset + changes.length < total ? `\n\nالتالي: offset ${offset + changes.length}` : '';
        return ok(`${total} تغييراً\n\n${body}${next}`);
      },
    },

    {
      name: 'list_legal_issues',
      title: 'المسائل القانونية',
      description:
        'المسائل القانونية المعتمدة في المنصة («فسخ العقد للإخلال»، «مواعيد الاعتراض»…) — كلٌّ موسومةٌ بموادّها. ' +
        'مرّر issue_key إلى search_regulations لتجد موادّ المسألة ولو لم تشترك مع سؤالك في لفظ.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          layer: {
            type: 'string',
            enum: ['substantive', 'procedural', 'evidence', 'general', 'regulation'],
            description: 'موضوعيّ · إجرائيّ · إثبات · عامّ · تنظيميّ.',
          },
        },
      },
      async run(args) {
        const layer = argString(args, 'layer', 30);
        const issues = (await approvedIssues(env)).filter((i) => !layer || i.layer === layer);
        if (!issues.length) return ok('لا مسائل معتمدة بعد في هذا التصنيف.');
        return ok(issues.map((i) => `- ${i.label} — issue_key: ${i.key} · ${i.layer}\n  ${i.description}`).join('\n'));
      },
    },

    {
      name: 'get_related_articles',
      title: 'إحالات مادة',
      description:
        'ما تحيل إليه المادة من موادّ (في نظامها أو غيره أو لائحته)، وما يحيل إليها — بنصوصها. ' +
        'الإحالة لا يجدها البحث بالتشابه، فهذه الأداة طريقها.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: ID_HINT } },
        required: ['id'],
      },
      async run(args) {
        const id = argString(args, 'id', 300);
        if (!id) return refuse('id مطلوب.');
        const base = articleBaseId(id);
        // البوابةُ نفسها التي في `get_article`: مادةٌ محجوبة — بانتظار المراجعة أو
        // معطوبة أو ملغاة — لا تُكشف إحالاتُها ولا يُقال إنها موجودة.
        if (!(await getChunkById(env, base))) {
          const reason = await hiddenReason(env, base);
          if (reason === 'repealed') return refuse('المادة منسوخة، فلا تُتبع إحالاتها.');
          if (reason === 'review') return refuse('المادة بانتظار المراجعة في المنصة، ولا يُستشهد بها حتى تُعتمد.');
          return refuse('المادة غير موجودة.');
        }
        // أجزاءُ المادة المقسّمة كلُّها: الإحالة قد تقع في جزئها الثاني.
        const own = await env.DB.prepare(`SELECT seq FROM legal_chunks WHERE id = ? OR id LIKE ? ESCAPE '\\'`)
          .bind(base, `${base.replace(/[\\%_]/g, (m) => `\\${m}`)}#%`)
          .all<{ seq: number }>();
        const seqs = (own.results ?? []).map((r) => r.seq);
        if (!seqs.length) return refuse('المادة غير موجودة.');
        const marks = seqs.map(() => '?').join(',');
        const [out, unresolved, incoming] = await Promise.all([
          env.DB.prepare(`SELECT DISTINCT to_seq FROM legal_article_links WHERE from_seq IN (${marks}) AND to_seq IS NOT NULL`)
            .bind(...seqs)
            .all<{ to_seq: number }>(),
          env.DB.prepare(
            `SELECT DISTINCT to_law_title, to_article_no FROM legal_article_links WHERE from_seq IN (${marks}) AND to_seq IS NULL`
          )
            .bind(...seqs)
            .all<{ to_law_title: string | null; to_article_no: string | null }>(),
          env.DB.prepare(`SELECT DISTINCT from_seq FROM legal_article_links WHERE to_seq IN (${marks})`)
            .bind(...seqs)
            .all<{ from_seq: number }>(),
        ]);
        const own_ = new Set(seqs);
        const [outHits, inHits] = await Promise.all([
          getHitsBySeqs(env, (out.results ?? []).map((r) => r.to_seq).filter((s) => !own_.has(s))),
          getHitsBySeqs(env, (incoming.results ?? []).map((r) => r.from_seq).filter((s) => !own_.has(s))),
        ]);
        const parts: string[] = [];
        parts.push(outHits.length ? `تحيل إليه المادة:\n\n${formatHits(outHits)}` : 'لا تحيل المادة إلى موادّ في المنصة.');
        const missing = (unresolved.results ?? []).filter((r) => r.to_law_title || r.to_article_no);
        if (missing.length) {
          parts.push(
            `إحالاتٌ إلى ما ليس في المنصة:\n${missing
              .map((r) => `- ${[r.to_law_title, r.to_article_no && `المادة ${r.to_article_no}`].filter(Boolean).join(' — ')}`)
              .join('\n')}`
          );
        }
        parts.push(inHits.length ? `يحيل إليها:\n\n${formatHits(inHits)}` : 'لا موادّ في المنصة تحيل إليها.');
        return ok(parts.join('\n\n===\n\n'));
      },
    },

    {
      name: 'get_definitions',
      title: 'تعريفات نظام',
      description: 'مادة التعريفات في نظام («يُقصد بالألفاظ والعبارات الآتية…») — الحكم يُقرأ بمعاني ألفاظه.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: { law_id: { type: 'string' } },
        required: ['law_id'],
      },
      async run(args) {
        const lawId = argString(args, 'law_id', 200);
        if (!lawId) return refuse('law_id مطلوب.');
        const def = await getDefinitionsArticle(env, lawId);
        if (!def) return ok('لم يُعثر على مادة تعريفات في هذا النظام.');
        return ok(formatHits([def]));
      },
    },

    {
      name: 'search_clauses',
      title: 'مكتبة البنود',
      description: 'البنود النموذجية المعتمدة في مكتب ناف للصياغة، بعنوانها وتصنيفها ونصّها. بلا query تُرجع المكتبة كلّها.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'كلماتٌ تُطابَق في العنوان أو النصّ أو التصنيف — كلُّها يجب أن ترد.' },
          category: { type: 'string', description: 'التصنيف بالمطابقة التامّة.' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: LIST_MAX, description: `الافتراضي ${LIST_DEFAULT}.` },
        },
      },
      async run(args) {
        const q = argString(args, 'query', 300);
        const category = argString(args, 'category', 200);
        // المطابقة المطبَّعة نفسها التي في `routes/clauses.ts`.
        const patterns = q ? arabicGlobPatterns(q) : [];
        const where: string[] = patterns.map(() => '(title GLOB ? OR body GLOB ? OR category GLOB ?)');
        const binds: unknown[] = patterns.flatMap((p) => [p, p, p]);
        if (category) {
          where.push('category = ?');
          binds.push(category);
        }
        const rows = await env.DB.prepare(
          `SELECT id, title, category, body FROM clauses${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
           ORDER BY category, title LIMIT 500`
        )
          .bind(...binds)
          .all<{ id: string; title: string; category: string | null; body: string }>();
        const list = rows.results ?? [];
        if (!list.length) return ok('لا بنود مطابقة. جرّب كلمةً واحدة أو احذف التصنيف.');
        const { page, header, next } = paginate(list, args);
        return ok(
          `${header}\n\n${page.map((c) => `## ${c.title}\nالتصنيف: ${c.category ?? '—'} · id: ${c.id}\n\n${c.body}`).join('\n\n---\n\n')}${next}`
        );
      },
    },
  ];
}

/**
 * نمطُ `GLOB` من `arabicGlobPatterns` إلى تعبيرٍ نمطيّ — لتصفية فهرس الأنظمة في
 * الذاكرة بالمطابقة المطبَّعة نفسها التي في SQL، لا بمطابقةٍ ثانية تخالفها.
 */
function globToRegex(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') out += '[\\s\\S]*';
    else if (ch === '?') out += '[\\s\\S]';
    else if (ch === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) out += '\\[';
      else {
        out += `[${glob.slice(i + 1, end).replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}
