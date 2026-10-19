// المُخطِّط (Planner) — §5: يحلّل رسالة المستخدم وينتج خطة JSON
import { callClaude } from './claude';
import { logUsage, usageFromRaw } from './usage';
import type { Env, PlannerOutput, ConsultationType } from '../types';

const PLANNER_SYSTEM = () => `أنت مُخطِّط توجيه لمنصّة استشارات قانونية سعودية. مهمّتك تحليل رسالة المستخدم ونوع الاستشارة المختار، وإنتاج خطة تنفيذ بصيغة JSON فقط دون أي نص إضافي.

أعِد كائن JSON بالحقول التالية:
{
  "consultation_type": "<أحد: litigation.statement_of_claim | litigation.reply_memo | litigation.objection | litigation.judgment_analysis | contract | policy | consultation | document_review | legal_basis>",
  "needs_knowledge_base": <bool>,
  "kb_queries": [<استعلامات بحث نصّية بالعربية عن الأنظمة ذات الصلة>],
  "needs_internet_search": <bool>,
  "internet_queries": [<استعلامات إنترنت إن لزم>],
  "needs_uploaded_files": <bool>,
  "target_regulations": [<الأسماء الرسمية الكاملة للأنظمة واللوائح التي تتطلّبها المسألة>],
  "needs_fiqh_sources": <bool>,
  "fiqh_queries": [<استعلامات عربية عن التأصيل الفقهي إن لزم>],
  "clarifying_questions": [<أسئلة استيضاح إن نقص بيان جوهري، وإلا مصفوفة فارغة>],
  "output_format": "<text | docx>",
  "domain": "<أحد: ${LEGAL_DOMAINS.join(' | ')}>",
  "issues": [{"title": "<المسألة بإيجاز>", "layer": "<substantive | procedural | evidence | general | regulation>", "queries": [<استعلامات>], "laws": [<الأنظمة التي يُبحث فيها>]}],
  "explicit_articles": [{"law": "<اسم النظام الرسمي>", "article": "<رقم المادة>"}]
}

قواعد:
- مهام الصياغة (عقد، صحيفة دعوى، مذكرة، لائحة) تحتاج غالبًا قاعدة المعرفة، و output_format = "docx".
- فعّل needs_internet_search=true فقط عند مؤشّرات مثل: «آخر تعديل»، «نظام جديد»، «صدر مؤخّرًا»، «خبر»، «حكم حديث».
- الاستشارة التفسيرية عن نظام مستقر: needs_knowledge_base=true و needs_internet_search=false.
- **needs_fiqh_sources بخلاً لا سخاءً.** كتب الفقه تدعيمٌ لا إسناد، والمنصّة سعودية يحكمها النظام. فلا تطلبها لمسألةٍ يحكمها نظامٌ سعوديّ مستقرّ (مهلة اعتراض، إجراء مرافعات، بند عقدٍ نمطيّ) — إنما حين يُسأل عن تأصيلٍ فقهيّ صراحةً، أو قاعدةٍ كلّية يقوم عليها حكم، أو مسألةٍ لا نصّ نظاميّ فيها فيُرجع فيها إلى أصلها. و fiqh_queries بألفاظ الفقهاء لا بألفاظ الأنظمة: «شروط صحة الإجارة» لا «المادة كذا من نظام الإيجار».
- legal_basis (استدلال نظامي): المستند المرسَل هو المُدخَل لا الطلب، فـ needs_knowledge_base=true و needs_uploaded_files=true و output_format = "text" — المخرَج خريطةُ إسنادٍ عن نصٍّ قائم لا مستندٌ يُصاغ. واجعل kb_queries استعلاماتٍ عن الأنظمة التي يقوم عليها النصّ.
- **السياق مهم:** إن وُجد «سجل المحادثة» فالرسالة الحالية غالبًا **متابعة** لما سبق (تعديل، إضافة، تصحيح، سؤال متفرّع). افهمها في ضوء ما دار، ولا تعامِلها كطلب جديد منفصل.
- لا تطرح clarifying_questions إلا إذا كانت هناك معلومة جوهرية **مفقودة فعلًا** ولا يمكن استنتاجها من سجل المحادثة. في رسائل المتابعة اترك clarifying_questions فارغة غالبًا.
- **issues — شجرة المسائل، وهي أهمّ ما في الخطة حين يلزم الإسناد.** فكّك الطلب إلى مسائله القانونية (حتى ثماني)، ولكل مسألةٍ طبقتها:
  - substantive: الحكم الموضوعي (الاستحقاق، الالتزام، الجزاء) في النظام الخاص بالنزاع.
  - procedural: الاختصاص، وشكل الدعوى وإجراءاتها، والمواعيد، وطرق الاعتراض.
  - evidence: عبء الإثبات ووسائله وحجّيتها.
  - general: الأحكام العامة التي يقوم عليها النظام الخاص (أحكام الالتزام والعقد والتعويض في نظام المعاملات المدنية مثلاً).
  - regulation: ما فصّلته اللائحة التنفيذية للنظام.
  القضية الموضوعية تستند عادةً إلى أكثر من طبقة: صحيفة الدعوى تحتاج الموضوعي والإجرائي، وكثيراً ما تحتاج الإثبات والأحكام العامة. فلا تقصر المسائل على الموضوعي. ولكل مسألةٍ استعلامٌ أو اثنان بألفاظ النصوص النظامية لا بألفاظ السؤال، وفي laws الأسماء الرسمية الكاملة للأنظمة التي يُبحث فيها عنها. والاستشارة البسيطة مسألةٌ أو اثنتان.
- **explicit_articles:** كل مادةٍ ذكرها المستخدم برقمها ونظامها («المادة 77 من نظام العمل»)، وإلا مصفوفة فارغة. لا تضع مادةً لم يذكرها.
- **domain:** مجال القضية من القائمة. وما لا يدخل فيها: «أخرى».
- **target_regulations مهمّ:** اذكر فيه كل نظام أو لائحة يتوقّف عليه الإسناد في هذه المسألة، بالاسم الرسمي الكامل كما يُنشر («نظام العمل»، «اللائحة التنفيذية لنظام العمل»، «نظام المعاملات المدنية»). المنصّة تقارن هذه الأسماء بقاعدة المعرفة وتعرض على المستخدم طلب إضافة ما ينقص منها، فاسمٌ ناقص أو مختصَر يُضيّع هذه الفرصة. لا تضع فيه أسماء تخمينية لا تتطلّبها المسألة.`;

/**
 * مجالات القضايا — مفاتيحُ خريطة الإسناد (`grounding_map.domain`).
 * والقائمة هنا لا في الخريطة: المُخطِّط يحتاجها ولو لم يُعتمد في الخريطة شيء بعد.
 */
export const LEGAL_DOMAINS = [
  'عمالي',
  'تجاري',
  'شركات',
  'مدني',
  'أحوال شخصية',
  'تنفيذ',
  'جزائي',
  'إداري',
  'تحكيم',
  'حماية البيانات',
  'أخرى',
] as const;

const LAYERS = ['substantive', 'procedural', 'evidence', 'general', 'regulation'] as const;

const str = { type: 'string' };
const strs = { type: 'array', items: str };

/** مخطّط الخطة — كل حقلٍ مطلوب، فلا يُسقط المُخطِّط حقلاً ولا يزيد. */
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'consultation_type', 'needs_knowledge_base', 'kb_queries', 'needs_internet_search', 'internet_queries',
    'needs_uploaded_files', 'target_regulations', 'needs_fiqh_sources', 'fiqh_queries', 'clarifying_questions',
    'output_format', 'domain', 'issues', 'explicit_articles',
  ],
  properties: {
    consultation_type: {
      type: 'string',
      enum: [
        'litigation.statement_of_claim', 'litigation.reply_memo', 'litigation.objection', 'litigation.judgment_analysis',
        'contract', 'policy', 'consultation', 'document_review', 'legal_basis',
      ],
    },
    needs_knowledge_base: { type: 'boolean' },
    kb_queries: strs,
    needs_internet_search: { type: 'boolean' },
    internet_queries: strs,
    needs_uploaded_files: { type: 'boolean' },
    target_regulations: strs,
    needs_fiqh_sources: { type: 'boolean' },
    fiqh_queries: strs,
    clarifying_questions: strs,
    output_format: { type: 'string', enum: ['text', 'docx'] },
    domain: { type: 'string', enum: [...LEGAL_DOMAINS] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'layer', 'queries', 'laws'],
        properties: { title: str, layer: { type: 'string', enum: [...LAYERS] }, queries: strs, laws: strs },
      },
    },
    explicit_articles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['law', 'article'],
        properties: { law: str, article: str },
      },
    },
  },
};

export async function runPlanner(
  env: Env,
  userMessage: string,
  selectedType: string | undefined,
  hasAttachments: boolean,
  forceInternet: boolean,
  userId?: string,
  history?: { role: string; content: string }[]
): Promise<PlannerOutput> {
  // آخر بضع رسائل من المحادثة لإعطاء المُخطِّط سياقًا (بدون الرسالة الحالية)
  const priorTurns = (history ?? [])
    .filter((m) => m.role !== 'system')
    .slice(-7, -1)
    .map((m) => `${m.role === 'user' ? 'المستخدم' : 'المستشار'}: ${m.content.slice(0, 600)}`)
    .join('\n');
  const historyBlock = priorTurns ? `سجل المحادثة (الأحدث في الأسفل):\n${priorTurns}\n\n` : '';

  const context = `نوع الاستشارة المختار: ${selectedType ?? 'غير محدّد'}
هل رفع المستخدم ملفات؟ ${hasAttachments ? 'نعم' : 'لا'}
هل فعّل المستخدم البحث في الإنترنت يدويًا؟ ${forceInternet ? 'نعم' : 'لا'}

${historyBlock}رسالة المستخدم الحالية:
${userMessage}`;

  try {
    const request = {
      model: env.PLANNER_MODEL,
      system: PLANNER_SYSTEM(),
      messages: [{ role: 'user' as const, content: context }],
      // توجيهٌ لا اجتهاد: خرجُه JSON قصير، وهو على مسار كل دور محادثة.
      // و`low` على Opus 5 قويٌّ لهذا الصنف، وأقلُّ زمناً قبل بدء التوليد.
      effort: 'low' as const,
      max_tokens: 8192,
    };
    /* مخرجٌ منظَّم أولاً. وإن رُدّ الطلب لعلّةٍ في المخطّط نفسه (400) — حقلٌ لا
       يقبله الـAPI — فالطلب نفسه بلا مخطّط، والتقاطُ JSON من النصّ كما كان: خطةٌ
       بلا ضمان المخطّط أنفع من خطةٍ احتياطية لا استعلام فيها. */
    let result: { text: string; raw: any };
    try {
      result = await callClaude(env, { ...request, format: PLAN_SCHEMA });
    } catch (e) {
      if (!/Claude API 400/.test(String((e as Error)?.message))) throw e;
      console.error('planner schema rejected — retrying without structured output');
      result = await callClaude(env, request);
    }
    const { text, raw } = result;
    await logUsage(env, { userId, kind: 'planner', model: env.PLANNER_MODEL, ...usageFromRaw(raw) });
    const plan = extractJson(text);
    return normalize(plan, selectedType, hasAttachments, forceInternet);
  } catch (e) {
    // احتياط: خطة افتراضية آمنة إن تعذّر المُخطِّط.
    //
    // ويُسجَّل السبب. صمتُ هذا الموضع بالذات هو ما جعل انقطاع Claude كاملاً
    // يظهر للمستخدم جملةً واحدة عند التوليد وحده: المُخطِّط يفشل أولاً ثم
    // يمضي بخطته الاحتياطية كأن شيئاً لم يكن، فلا يبقى أثر يقول أين انقطع.
    console.error('planner failed:', e instanceof Error ? e.message : e);
    return normalize({}, selectedType, hasAttachments, forceInternet);
  }
}

function extractJson(text: string): Partial<PlannerOutput> {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    return JSON.parse(match[0]);
  } catch {
    return {};
  }
}

function normalize(
  p: Partial<PlannerOutput>,
  selectedType: string | undefined,
  hasAttachments: boolean,
  forceInternet: boolean
): PlannerOutput {
  // اختيار المستخدم الصريح للنوع يسبق تخمين المُخطِّط، فلا يُبدَّل توجيه النظام
  // على مستشارٍ اختار «لائحة اعتراضية» مثلًا لأنه رفع صك حكم.
  const type = (selectedType ?? p.consultation_type ?? 'consultation') as ConsultationType;
  return {
    consultation_type: type,
    needs_knowledge_base: p.needs_knowledge_base ?? true,
    kb_queries: Array.isArray(p.kb_queries) ? p.kb_queries.slice(0, 5) : [],
    needs_internet_search: forceInternet || (p.needs_internet_search ?? false),
    internet_queries: Array.isArray(p.internet_queries) ? p.internet_queries.slice(0, 3) : [],
    needs_uploaded_files: hasAttachments && (p.needs_uploaded_files ?? true),
    target_regulations: Array.isArray(p.target_regulations) ? p.target_regulations : [],
    needs_fiqh_sources: p.needs_fiqh_sources === true,
    // ثلاثةٌ سقفاً: كلُّ استعلامٍ نداءُ شبكةٍ إلى كلّ مصدرٍ مفعَّل، ثم تضمين.
    fiqh_queries: Array.isArray(p.fiqh_queries) ? p.fiqh_queries.slice(0, 3) : [],
    clarifying_questions: Array.isArray(p.clarifying_questions) ? p.clarifying_questions : [],
    domain: typeof p.domain === 'string' && (LEGAL_DOMAINS as readonly string[]).includes(p.domain) ? p.domain : 'أخرى',
    // ثماني مسائل سقفاً، واستعلامان لكلٍّ منها، وثلاثة أنظمة: كل استعلامٍ بحثٌ في
    // كل نظامٍ مسمّى، والسقف يُبقي الدور في حدود زمنه.
    issues: (Array.isArray(p.issues) ? p.issues : [])
      .filter((i) => i && typeof i.title === 'string' && (LAYERS as readonly string[]).includes(i.layer))
      .slice(0, 8)
      .map((i) => ({
        title: i.title,
        layer: i.layer,
        queries: (Array.isArray(i.queries) ? i.queries : []).filter((q) => typeof q === 'string' && q.trim()).slice(0, 2),
        laws: (Array.isArray(i.laws) ? i.laws : []).filter((l) => typeof l === 'string' && l.trim()).slice(0, 3),
      }))
      .filter((i) => i.queries.length),
    explicit_articles: (Array.isArray(p.explicit_articles) ? p.explicit_articles : [])
      .filter((a) => a && typeof a.law === 'string' && a.article != null)
      .slice(0, 10)
      .map((a) => ({ law: a.law, article: String(a.article) })),
    /* `legal_basis` مخرَجُه خريطةُ إسنادٍ عن نصٍّ قائم لا مستندٌ يُصاغ، فيبقى
       `text` ولو قال المُخطِّط غيره. وبقيّةُ الأنواع على ما كانت. */
    output_format:
      type === 'legal_basis'
        ? 'text'
        : p.output_format === 'docx'
          ? 'docx'
          : type === 'consultation' || type === 'litigation.judgment_analysis'
            ? 'text'
            : 'docx',
  };
}
