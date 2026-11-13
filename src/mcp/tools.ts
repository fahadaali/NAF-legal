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
import { argBool, argInt, argString } from './protocol';
import type { McpTool, McpToolResult } from './protocol';

/** سقفُ محرّك البحث نفسه (`searchLegal`) — لا حدٌّ للمنصة على الاستخدام. */
const SEARCH_MAX = 50;

const ok = (text: string): McpToolResult => ({ text });
const refuse = (text: string): McpToolResult => ({ text, isError: true });

/** حالُ النظام سطراً: ساري، ملغى، لم يبدأ العمل به. */
function lawState(l: LawSummary): string {
  if (l.law_repealed) return 'ملغى';
  if (l.law_pending) return `لم يبدأ العمل به${l.law_effective_from ? ` (نافذ من ${l.law_effective_from})` : ''}`;
  return l.law_status || 'ساري';
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
    `  الموادّ: ${l.effective} نافذة${l.repealed ? ` · ${l.repealed} ملغاة` : ''}`,
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
        h.isRepealed && 'ملغاة',
      ]
        .filter(Boolean)
        .join(' · ');
      const block = formatRagBlock(fromLegalHit(h), i + 1);
      // سطرُ الموضع والمعرّف بعد سطر المصدر — والتنبيهات تبقى فوق النصّ.
      const nl = block.indexOf('\n');
      return `${block.slice(0, nl)}\n${meta}${where ? `\n${where}` : ''}${block.slice(nl)}`;
    })
    .join('\n\n---\n\n');
}

const ID_HINT = 'معرّف المادة (id) كما ورد في نتائج البحث.';

export function readTools(env: Env): McpTool[] {
  return [
    {
      name: 'search_regulations',
      title: 'البحث في الأنظمة واللوائح',
      description:
        'بحثٌ هجين (دلاليّ ولفظيّ) في الأنظمة واللوائح السعودية النافذة على منصة مستشار ناف. ' +
        'يُرجع الموادّ بنصّها ومصدرها وتنبيهاتها (تعديلٌ لم يُدمج، نفاذٌ مؤجَّل). ' +
        'ضيّق البحث بـ law_id (من list_laws) أو doc_type أو book أو issue_key (من list_legal_issues). ' +
        'الموادّ الملغاة لا تظهر إلا بـ include_repealed — للمقارنة التاريخية لا للاستشهاد.',
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
          include_repealed: { type: 'boolean', description: 'إظهار الملغى. الافتراضي لا.' },
          limit: { type: 'integer', minimum: 1, maximum: SEARCH_MAX, description: 'عدد النتائج. الافتراضي 10.' },
        },
      },
      async run(args) {
        const query = argString(args, 'query', 1000) ?? '';
        const lawId = argString(args, 'law_id', 200);
        const issueKey = argString(args, 'issue_key', 200);
        if (!query && !lawId && !issueKey) return refuse('اكتب query، أو حدّد law_id أو issue_key للتصفّح.');
        const docTypeRaw = argString(args, 'doc_type', 50);
        const hits = await searchLegal(env, query, {
          limit: argInt(args, 'limit', 10, 1, SEARCH_MAX),
          lawId,
          docType: docTypeRaw ? (canonicalDocType(docTypeRaw) ?? docTypeRaw) : null,
          articleNo: argString(args, 'article_no', 50),
          book: argString(args, 'book', 300),
          issueKey,
          includeRepealed: argBool(args, 'include_repealed'),
          lexicalOnly: argString(args, 'mode', 20) === 'lexical',
        });
        if (!hits.length) {
          return ok('لم يُعثر على موادّ مطابقة. وسّع البحث: احذف مرشّحاً، أو جرّب لفظاً آخر، أو mode: hybrid.');
        }
        return ok(formatHits(hits));
      },
    },

    {
      name: 'get_article',
      title: 'استدعاء مادة',
      description:
        'نصّ مادةٍ بعينها كاملاً مع أجزائها ومرفقاتها وتنبيهاتها. ' +
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
        if (!hits.length) return refuse('المادة غير موجودة.');
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
        },
      },
      async run(args) {
        const q = argString(args, 'query', 200);
        const docTypeRaw = argString(args, 'doc_type', 50);
        const docType = docTypeRaw ? (canonicalDocType(docTypeRaw) ?? docTypeRaw) : null;
        const includeRepealed = argBool(args, 'include_repealed');
        const patterns = q ? arabicGlobPatterns(q).map(globToRegex) : [];
        const laws = (await listLaws(env)).filter(
          (l) =>
            (includeRepealed || !l.law_repealed) &&
            (!docType || l.doc_type === docType) &&
            patterns.every((re) => re.test(`${l.law_title ?? ''} ${l.authority ?? ''}`))
        );
        if (!laws.length) return ok('لا أنظمة مطابقة. جرّب لفظاً أقصر أو احذف doc_type.');
        const types = Object.entries(DOC_TYPES)
          .map(([k, v]) => `${k}: ${v}`)
          .join(' · ');
        return ok(`أنواع الوثائق — ${types}\nالعدد: ${laws.length}\n\n${laws.map(formatLaw).join('\n')}`);
      },
    },

    {
      name: 'get_law',
      title: 'بطاقة نظام',
      description: 'بطاقة نظامٍ بحاله وأداة إصداره، ولوائحه، وأبوابه بترتيبها — قبل التصفّح أو البحث داخله.',
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
        const books = await listLawBooks(env, lawId);
        const parts = [formatLaw(law)];
        if (law.source_url) parts.push(`المصدر الرسمي: ${law.source_url}`);
        parts.push(books.length ? `الأبواب:\n${books.map((b) => `- ${b}`).join('\n')}` : 'لا أبواب مسجّلة.');
        parts.push(regulations.length ? `اللوائح والتنظيمات التابعة:\n${regulations.map(formatLaw).join('\n')}` : 'لا لوائح تابعة.');
        return ok(parts.join('\n\n'));
      },
    },

    {
      name: 'browse_law_articles',
      title: 'تصفّح موادّ نظام',
      description: 'موادّ نظامٍ بترتيب ورودها فيه، صفحةً صفحة — لقراءة النظام متتابعاً.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          law_id: { type: 'string' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'الافتراضي 20.' },
          include_repealed: { type: 'boolean' },
        },
        required: ['law_id'],
      },
      async run(args) {
        const lawId = argString(args, 'law_id', 200);
        if (!lawId) return refuse('law_id مطلوب.');
        const offset = argInt(args, 'offset', 0, 0, 1_000_000);
        const { articles, total } = await listLawArticles(env, lawId, {
          offset,
          limit: argInt(args, 'limit', 20, 1, 100),
          // التصفّح يُظهر الملغى في المنصة افتراضياً؛ وهنا لا يظهر إلا بطلب —
          // الأداة تستشهد بما تقرأ، والاستشهاد لا يقع على ملغى.
          includeRepealed: argBool(args, 'include_repealed'),
        });
        if (!articles.length) return ok(total ? 'لا موادّ بعد هذا الموضع.' : 'لا موادّ نافذة لهذا النظام.');
        const next = offset + articles.length < total ? `\n\nالتالي: offset ${offset + articles.length}` : '';
        return ok(`الموادّ ${offset + 1}–${offset + articles.length} من ${total}\n\n${formatHits(articles)}${next}`);
      },
    },

    {
      name: 'get_article_amendment',
      title: 'تعديلات مادة',
      description: 'سجلّ تعديل مادةٍ: نسخُ نصّها بالترتيب وأدواتُ التعديل وتواريخها، وهل دُمج آخرُها في النصّ.',
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
          `عدد التعديلات: ${a.amendments_count ?? 0} · آخرها مدموجٌ في النصّ: ${a.amendment_applied ? 'نعم' : 'لا'}`,
          [a.amendment_instrument && `أداة التعديل: ${a.amendment_instrument}`, a.amended_on && `بتاريخ: ${a.amended_on}`]
            .filter(Boolean)
            .join(' · '),
          a.amend_note ? `ملاحظة: ${a.amend_note}` : '',
          a.source_url ? `المصدر الرسمي: ${a.source_url}` : '',
        ].filter(Boolean);
        if (a.versions.length) {
          lines.push(
            '',
            'نسخُ النصّ بالترتيب:',
            ...a.versions.map(
              (v) =>
                `\n[${v.seq}]${v.current ? ' (الجاري)' : ''}${v.label ? ` ${v.label}` : ''}${
                  v.from_instrument ? ` — ${v.from_instrument}` : ''
                }${v.from_date ? ` ${v.from_date}` : ''}\n${v.text}`
            )
          );
        } else if (a.text_superseded) {
          lines.push('', 'النصّ السابق:', a.text_superseded);
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
           ORDER BY category, title LIMIT 200`
        )
          .bind(...binds)
          .all<{ id: string; title: string; category: string | null; body: string }>();
        const list = rows.results ?? [];
        if (!list.length) return ok('لا بنود مطابقة. جرّب كلمةً واحدة أو احذف التصنيف.');
        return ok(list.map((c) => `## ${c.title}\nالتصنيف: ${c.category ?? '—'} · id: ${c.id}\n\n${c.body}`).join('\n\n---\n\n'));
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
