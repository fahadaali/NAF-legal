/* نصوصُ واجهة مذكرة البحث والبحث المعمّق — في موضعٍ واحد.
 *
 * **مقترحةٌ لا مسجَّلة بعد.** كلُّ ما هنا في `docs/naf-ui-proposal-research.md`
 * بانتظار تسجيله في naf-ui (`naf-terms.md`)، والواجهة لا تُدمج قبل ذلك. وجمعُها
 * هنا لا في المكوّنات ليُقابَل الملفُّ بالسجلّ سطراً بسطر حين يُدمج، ويُعدَّل
 * لفظٌ غيّره المراجع في موضعٍ واحد.
 *
 * وما كان مسجَّلاً أصلاً — «اعتماد»، «استبعاد»، «حفظ»، «إلغاء»، «مسودة»،
 * «معتمد»، «مؤرشف»، «إعادة المحاولة» — يُكتب في موضعه كما يُكتب في سائر الشاشات.
 */
import type { GroundingLayer, ResearchJob } from './api';

export const RT = {
  memo: 'مذكرة البحث',
  gapsHeading: 'ما لم يُوجد له سند',
  gapLine: 'لا سند نظامي لهذه المسألة في قاعدة المعرفة',
  editSources: 'تعديل الأسانيد',
  draftFromMemo: 'صياغة من المذكرة',
  deepResearch: 'بحث معمّق',
  deepHint: 'يُكمل المساعد البحث في قاعدة المعرفة على جولاتٍ قبل الصياغة، ويستغرق دقائق',
  canLeave: 'يمضي البحث ولو غادرت الصفحة',
  stageAnalysing: 'جارٍ تحليل السؤال',
  stageSearching: 'جارٍ البحث في الأنظمة',
  done: 'تم البحث',
  failed: 'تعذّر إكمال البحث. أعد المحاولة',
  stalled: 'توقّف البحث قبل أن يكتمل. أعد المحاولة',
  startFailed: 'تعذّر بدء البحث. أعد المحاولة بعد قليل',
  needsManualCheck: 'بحاجة لتأكيد يدوي',
  groundingMap: 'خريطة الإسناد',
  issuesList: 'قائمة المسائل',
  groundingMapNote:
    'الأنظمة التي يُستكمل منها البحث في كل مجال وطبقة. لا يقرأ المحرّك منها إلا المعتمد.',
  issuesNote:
    'المسائل التي توسَم بها موادّ الأنظمة ويُحصر بها البحث. لا توسَم الموادّ إلا بالمعتمد منها.',
  domainCol: 'المجال',
  layerCol: 'الطبقة',
  issueCol: 'المسألة',
  taggedCol: 'الموادّ الموسومة',
} as const;

/** «جولة البحث N» — العددُ معزولٌ اتجاهياً في موضع عرضه. */
export const roundLabel = 'جولة البحث';

/** «N مادة». */
export const articlesUnit = 'مادة';

/** «N مادة مستبعدة» — قبل الحفظ. */
export const excludedUnit = 'مادة مستبعدة';

/** «N مادة لم تُوسم بعد». */
export const untaggedUnit = 'مادة لم تُوسم بعد';

/** اسمُ علامة الإسناد داخل النصّ لقارئ الشاشة. */
export const citeMarkLabel = (title: string) => `السند النظامي: ${title}`;

/** طبقات الإسناد — كما يكتبها الخادم في عناوين المجموعات (`LAYER_LABELS`). */
export const LAYER_LABELS: Record<GroundingLayer, string> = {
  substantive: 'موضوعي',
  procedural: 'إجرائي',
  evidence: 'إثبات',
  general: 'أحكام عامة',
  regulation: 'لائحة تنفيذية',
};

/** سطرُ مرحلة المهمّة الجارية. `round:N` تعيد رقمها ليُعزل في العرض. */
export function stageOf(job: Pick<ResearchJob, 'status' | 'stage'>): { label: string; round?: number } {
  const round = job.stage?.match(/^round:(\d+)$/);
  if (round) return { label: roundLabel, round: Number(round[1]) };
  if (job.stage === 'planned' || job.stage === 'retrieved') return { label: RT.stageSearching };
  return { label: RT.stageAnalysing };
}

/** خطأ المهمّة برمزه — رمزٌ لا يُعرف يُقرأ «تعذّر إكمال البحث». */
export function jobErrorText(code: string | null): string {
  return code === 'research_stalled' ? RT.stalled : RT.failed;
}
