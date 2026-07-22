// المُخطِّط (Planner) — §5: يحلّل رسالة المستخدم وينتج خطة JSON
import { callClaude } from './claude';
import { logUsage, usageFromRaw } from './usage';
import type { Env, PlannerOutput, ConsultationType } from '../types';

const PLANNER_SYSTEM = `أنت مُخطِّط توجيه لمنصّة استشارات قانونية سعودية. مهمّتك تحليل رسالة المستخدم ونوع الاستشارة المختار، وإنتاج خطة تنفيذ بصيغة JSON فقط دون أي نص إضافي.

أعِد كائن JSON بالحقول التالية:
{
  "consultation_type": "<أحد: litigation.statement_of_claim | litigation.reply_memo | litigation.objection | litigation.judgment_analysis | contract | policy | consultation>",
  "needs_knowledge_base": <bool>,
  "kb_queries": [<استعلامات بحث نصّية بالعربية عن الأنظمة ذات الصلة>],
  "needs_internet_search": <bool>,
  "internet_queries": [<استعلامات إنترنت إن لزم>],
  "needs_uploaded_files": <bool>,
  "target_regulations": [<أسماء الأنظمة المرشّحة>],
  "clarifying_questions": [<أسئلة استيضاح إن نقص بيان جوهري، وإلا مصفوفة فارغة>],
  "output_format": "<text | docx>"
}

قواعد:
- مهام الصياغة (عقد، صحيفة دعوى، مذكرة، لائحة) تحتاج غالبًا قاعدة المعرفة، و output_format = "docx".
- فعّل needs_internet_search=true فقط عند مؤشّرات مثل: «آخر تعديل»، «نظام جديد»، «صدر مؤخّرًا»، «خبر»، «حكم حديث».
- الاستشارة التفسيرية عن نظام مستقر: needs_knowledge_base=true و needs_internet_search=false.
- **السياق مهم:** إن وُجد «سجل المحادثة» فالرسالة الحالية غالبًا **متابعة** لما سبق (تعديل، إضافة، تصحيح، سؤال متفرّع). افهمها في ضوء ما دار، ولا تعامِلها كطلب جديد منفصل.
- لا تطرح clarifying_questions إلا إذا كانت هناك معلومة جوهرية **مفقودة فعلًا** ولا يمكن استنتاجها من سجل المحادثة. في رسائل المتابعة اترك clarifying_questions فارغة غالبًا.`;

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
    const { text, raw } = await callClaude(env, {
      model: env.PLANNER_MODEL,
      system: PLANNER_SYSTEM,
      messages: [{ role: 'user', content: context }],
      max_tokens: 1024,
      temperature: 0,
    });
    await logUsage(env, { userId, kind: 'planner', model: env.PLANNER_MODEL, ...usageFromRaw(raw) });
    const plan = extractJson(text);
    return normalize(plan, selectedType, hasAttachments, forceInternet);
  } catch (e) {
    // احتياط: خطة افتراضية آمنة إن تعذّر المُخطِّط
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
  const type = (p.consultation_type ?? selectedType ?? 'consultation') as ConsultationType;
  return {
    consultation_type: type,
    needs_knowledge_base: p.needs_knowledge_base ?? true,
    kb_queries: Array.isArray(p.kb_queries) ? p.kb_queries.slice(0, 5) : [],
    needs_internet_search: forceInternet || (p.needs_internet_search ?? false),
    internet_queries: Array.isArray(p.internet_queries) ? p.internet_queries.slice(0, 3) : [],
    needs_uploaded_files: hasAttachments && (p.needs_uploaded_files ?? true),
    target_regulations: Array.isArray(p.target_regulations) ? p.target_regulations : [],
    clarifying_questions: Array.isArray(p.clarifying_questions) ? p.clarifying_questions : [],
    output_format: p.output_format === 'docx' ? 'docx' : type === 'consultation' || type === 'litigation.judgment_analysis' ? 'text' : 'docx',
  };
}
