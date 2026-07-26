// أنواع الاستشارات وبطاقاتها — §3, §4
export interface ConsultationOption {
  type: string;
  label: string;
  description: string;
  /** مفتاح من Icon في lib/icons — المعنى مسجَّل في naf-icons.md. */
  iconKey?: 'memo' | 'pleading' | 'consultation' | 'contract'
    | 'statementOfClaim' | 'judgmentAnalysis' | 'internalPolicy' | 'documentReview';
  group?: string;
}

export const CONSULTATIONS: ConsultationOption[] = [
  {
    type: 'litigation.statement_of_claim',
    label: 'صحيفة دعوى',
    description: 'تحرير صحيفة دعوى نظامية مكتملة الأركان الشكلية والموضوعية.',
    iconKey: 'statementOfClaim',
    group: 'التقاضي',
  },
  {
    type: 'litigation.reply_memo',
    label: 'مذكرة رد',
    description: 'تفنيد ادّعاءات الخصم دفعًا شكليًا وموضوعيًا.',
    iconKey: 'memo',
    group: 'التقاضي',
  },
  {
    type: 'litigation.objection',
    label: 'لائحة اعتراضية',
    description: 'بناء أسباب اعتراض مسبَّبة مع ضبط المواعيد النظامية.',
    iconKey: 'pleading',
    group: 'التقاضي',
  },
  {
    type: 'litigation.judgment_analysis',
    label: 'تحليل حكم قضائي',
    description: 'استخراج الوقائع والأسباب وتقييم التسبيب وفرص الاعتراض.',
    iconKey: 'judgmentAnalysis',
    group: 'التقاضي',
  },
  {
    type: 'contract',
    label: 'صياغة عقد',
    description: 'صياغة عقد متوازن مكتمل البنود وفق نظام المعاملات المدنية.',
    iconKey: 'contract',
  },
  {
    type: 'policy',
    label: 'كتابة لوائح وسياسات',
    description: 'إنتاج لائحة/سياسة منظَّمة متوافقة مع المرجعية النظامية.',
    iconKey: 'internalPolicy',
  },
  {
    type: 'consultation',
    label: 'استشارة قانونية',
    description: 'رأي قانوني مسبَّب مع الإسناد لمواد نظامية محدّدة.',
    iconKey: 'consultation',
  },
  {
    type: 'document_review',
    label: 'مراجعة وتدقيق مستند',
    description: 'رفع عقد/مذكرة والحصول على تحليل مخاطر بندًا ببند مع مقترحات.',
    iconKey: 'documentReview',
  },
];

export function labelFor(type: string | null | undefined): string {
  return CONSULTATIONS.find((c) => c.type === type)?.label ?? 'استشارة';
}
export function optionFor(type: string | null | undefined): ConsultationOption | undefined {
  return CONSULTATIONS.find((c) => c.type === type);
}
