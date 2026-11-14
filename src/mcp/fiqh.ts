/**
 * البحث في كتب الفقه — عبر المصادر الخارجية المربوطة بالمنصة.
 *
 * دردشةُ المنصة تبحث في هذه المصادر (تراث والمكتبة الشاملة) حين يطلب المُخطِّط
 * تأصيلاً فقهياً. وهذه الأداة تفتح البحث نفسه لأداة العضو: بالمصادر نفسها،
 * وباعتمادها نفسه، وبالمحوّل نفسه (`lib/external.ts`) — فلا نداءَ ثانٍ يُكتب
 * ولا ربطَ ثانٍ يُدار.
 *
 * **للعضو وحده.** المصدر الخارجي مربوطٌ باسم المنصة لا باسم قارئ
 * (`naf-terms.md` §١٥ — «وكتب الفقه للعضو لا للضيف»). والقارئ عضوٌ، والبحث
 * قراءة، فيراها.
 *
 * **ومخرجُها تأصيلٌ لا إسناد**، كما في المنصة نفسها: يُقال فوق المقاطع، والحاشيةُ
 * تُوسم بأنها كلام المحقِّق. ومصدرٌ لم يُجب يُقال «تعذّر الوصول إلى المصدر» ولا
 * يُسكت عنه — فراغُه ليس «لا نتائج».
 */
import type { Env } from '../types';
import { enabledSources } from '../lib/sources';
import { searchSources, type ExternalHit, type SourceOutcome } from '../lib/external';
import { argString } from './protocol';
import type { McpPrincipal, McpTool, McpToolResult } from './protocol';

const ok = (text: string): McpToolResult => ({ text });
const refuse = (text: string): McpToolResult => ({ text, isError: true });

const isMember = (p: McpPrincipal) => p.kind === 'member';

const GROUNDING_NOTE =
  'المقاطع التالية من كتب الفقه، للتأصيل والتقوية. ليست أنظمةً سعودية ولا تقوم مقامها: ' +
  'تُذكر في قسمٍ ختاميّ وحده عنوانه «التأصيل الفقهي»، منسوبةً إلى الكتاب والمؤلِّف والصفحة المطبوعة، ' +
  'ولا تُخلط بموادّ الأنظمة ولا تُصاغ صياغةَ الإلزام.';

function formatHit(h: ExternalHit, i: number): string {
  const cite = [
    `الكتاب: ${h.title}`,
    h.author && `المؤلِّف: ${h.author}`,
    h.ref && `الصفحة المطبوعة: ${h.ref}`,
    h.category && `التصنيف: ${h.category}`,
  ]
    .filter(Boolean)
    .join(' — ');
  const lines = [`[${i + 1}] ${cite}`];
  if (h.section === 'حاشية') lines.push('تنبيه: هذا المقطع من الحاشية، وهو كلام المحقِّق لا المؤلِّف — فلا يُنسب إليه.');
  if (h.url) lines.push(`الرابط: ${h.url}`);
  lines.push(h.text);
  return lines.join('\n');
}

function formatOutcome(o: SourceOutcome): string {
  const head = `## ${o.sourceLabel}`;
  if (o.status !== 'ok') return `${head}\nتعذّر الوصول إلى المصدر — فلم يُسأل، وغيابُ نتائجه لا يعني خلوَّ كتبه من المسألة.`;
  if (!o.hits.length) return `${head}\nلا نتائج مطابقة في هذا المصدر. جرّب لفظاً آخر للمسألة.`;
  return `${head}\n\n${o.hits.map(formatHit).join('\n\n---\n\n')}`;
}

export function fiqhTools(env: Env): McpTool[] {
  return [
    {
      name: 'search_fiqh_sources',
      title: 'البحث في كتب الفقه',
      description:
        'بحثٌ في كتب الفقه عبر المصادر الخارجية المربوطة بمنصة مستشار ناف (تراث والمكتبة الشاملة)، ' +
        'يُرجع المقاطع بنصّها وكتابها ومؤلِّفها وصفحتها المطبوعة، وهل هي من المتن أم من الحاشية. ' +
        'للتأصيل الفقهي حين يطلبه المستخدم أو تقتضيه المسألة — لا بدلاً من الأنظمة: النظام السعودي هو السند. ' +
        'اكتب المسألة بلفظ الفقهاء («خيار العيب»، «الشرط الجزائي»، «ضمان المتلفات») لا بلفظ النظام.',
      readOnly: true,
      visibleTo: isMember,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'المسألة بلفظ الفقهاء، بالعربية.' },
          source: { type: 'string', description: 'معرّف مصدرٍ واحد (turath أو shamela). بلا قيمةٍ يُبحث في المصادر كلّها.' },
        },
        required: ['query'],
      },
      async run(args) {
        const query = argString(args, 'query', 500);
        if (!query) return refuse('query مطلوب: المسألة بلفظ الفقهاء.');
        const only = argString(args, 'source', 50);
        const all = await enabledSources(env, 'fiqh');
        const sources = only ? all.filter((s) => s.id === only) : all;
        if (!all.length) return ok('لا مصادر خارجية لكتب الفقه مربوطةٌ بالمنصة الآن، فلا بحث فقهي. قل ذلك للمستخدم.');
        if (!sources.length) {
          return refuse(`لا مصدر بهذا المعرّف. المصادر المربوطة: ${all.map((s) => `${s.id} (${s.label})`).join('، ')}.`);
        }
        const outcomes = await searchSources(env, sources, query);
        return ok(`${GROUNDING_NOTE}\n\n${outcomes.map(formatOutcome).join('\n\n===\n\n')}`);
      },
    },
  ];
}
