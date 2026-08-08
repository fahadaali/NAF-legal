/* ============================================================
   ربط مفاهيم المنصة بأيقونات Lucide.
   المرجع الوحيد: naf-icons.md من fahadaali/naf-ui#v1.18.0.
   لا تُضِف مفتاحاً هنا قبل تسجيل معناه في السجلّ — القاعدة في
   CLAUDE.md §3: المعنى الواحد أيقونة واحدة في المنصات الخمس.
   ============================================================ */

import {
  Activity,
  ArrowDown,
  Ban,
  BookX,
  Copy,
  ExternalLink,
  FileClock,
  FileDiff,
  History as HistoryIcon,
  ArrowLeft,
  ArrowUp,
  BadgeCheck,
  BookCheck,
  BookText,
  Bell,
  Briefcase,
  Calendar,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleSlash,
  CircleX,
  Clock,
  Download,
  FileImage,
  FileOutput,
  FilePlus2,
  FileSearch,
  FileText,
  FileType,
  Folder,
  Globe,
  Hourglass,
  Library,
  LifeBuoy,
  Link2,
  Link2Off,
  Menu,
  MessageSquare,
  Monitor,
  MessageSquareWarning,
  Mic,
  Moon,
  Paperclip,
  Pencil,
  RefreshCw,
  Replace,
  RotateCcw,
  ScanText,
  ScrollText,
  Search,
  Send,
  Share2,
  ShieldCheck,
  ShieldX,
  SlidersHorizontal,
  SpellCheck,
  Square,
  SquarePen,
  Stamp,
  Sun,
  Swords,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  TriangleAlert,
  Upload,
  Users,
  Wrench,
  X,
} from 'lucide-react';

/** المقاسات الثلاثة في naf-icons.md — لا مقاس رابع. */
export const ICON_SM = 16; // داخل النصوص والشارات
export const ICON_MD = 20; // داخل الأزرار والحقول — الافتراضي
export const ICON_LG = 24; // في التنقّل والعناوين

/** المفتاح هو المعنى، لا الشكل. كل سطر مطابق لصفّ في naf-icons.md. */
export const Icon = {
  // الإجراءات
  edit: Pencil,            // تعديل
  delete: Trash2,          // حذف
  search: Search,          // بحث
  upload: Upload,          // رفع
  download: Download,      // تنزيل
  export: FileOutput,      // تصدير
  share: Share2,           // مشاركة
  send: Send,              // إرسال — اتجاهية، انظر أدناه
  refresh: RefreshCw,      // تحديث
  proofread: SpellCheck,   // تدقيق لغوي
  rewrite: Replace,        // صياغة بديلة
  webSearch: Globe,        // البحث في الإنترنت
  moveUp: ArrowUp,         // نقل لأعلى
  moveDown: ArrowDown,     // نقل لأسفل
  close: X,                // إغلاق — ولا تُستعمل للحذف أبداً
  // الكيانات
  matter: Briefcase,       // ملف / مسألة
  consultation: MessageSquare, // استشارة
  contract: Stamp,         // عقد
  memo: FileText,          // مذكرة
  pleading: ScrollText,    // لائحة قضائية — اعتراضية واستئنافية
  statementOfClaim: FilePlus2, // صحيفة دعوى — اللائحة الافتتاحية
  internalPolicy: BookText,    // لائحة داخلية / سياسة — لا ScrollText
  judgmentAnalysis: ScanText,  // تحليل حكم قضائي
  documentReview: FileSearch,  // مراجعة وتدقيق مستند — الفعل لا الحالة
  litigation: Swords,          // التقاضي — تصنيف لا كيان
  appointment: Calendar,   // موعد
  attachment: Paperclip,   // مرفق
  officialSource: BadgeCheck, // مصدر رسمي — وليست ShieldCheck (صلاحيات)
  citationChecked: BookCheck, // إسناد مُتحقَّق منه — وليست CircleCheck (اعتماد)
  clauseBank: Library,     // بنك البنود
  folder: Folder,          // مجلّد
  tools: Wrench,           // الأدوات
  systemCheck: Activity,   // فحص النظام — الفعل
  connected: Link2,        // مربوط
  disconnected: Link2Off,  // غير مربوط
  // الحالات
  approved: CircleCheck,   // معتمد
  pendingReview: Clock,    // بانتظار المراجعة
  rejected: CircleX,       // مرفوض — وليست X (إغلاق)
  warning: TriangleAlert,  // تحذير
  failed: CircleAlert,     // فشل — وليست TriangleAlert (تحذير: لم يقع بعد)
  changesRequested: MessageSquareWarning, // مطلوب تعديلات — وليست CircleX (مرفوض)
  awaitingClarification: CircleHelp,      // بانتظار توضيح — وليست Clock
  accessDenied: ShieldX,   // الوصول مرفوض — وليست CircleX (مرفوض: حكمٌ على مستند)
  // حالات مراجعة المادة المستوردة — مسجَّلة في naf-icons.md تحت
  // «مراجعة المحتوى النظامي». والمعتمدة تأخذ `approved` أعلاه فلا صفّ لها.
  reviewEdited: SquarePen,  // محرَّرة — حالُ نصٍّ بعد التحرير، وليست Pencil (فعل التعديل)
  reviewExcluded: Ban,      // مستبعدة — مقطعٌ يُخرَج، وليست CircleX (مرفوض: مستند عاد بحكم)
  reviewDeferred: Hourglass, // مؤجَّلة — وليست Clock (بانتظار المراجعة: الحال التي خرجت منها)
  // حالُ الاسترجاع ونافذة سجلّ التعديلات — naf-icons.md تحت العنوان نفسه.
  // والإلغاء واقعةٌ نظامية لا قرارُ مراجعٍ عندنا، فلا `Ban` (مستبعدة).
  repealedArticle: BookX,   // ملغاة — أُلغيت بمرسوم، وليست Ban (قرار مراجع)
  amendmentLog: FileDiff,   // سجل التعديلات — ما فُعل بالمادة، وليست History (ما صارت إليه)
  versionTimeline: HistoryIcon, // الخط الزمني — «سجلّ النسخ» المسجَّلة أصلاً
  originalText: FileClock,  // الأصل — نصٌّ من زمنٍ مضى، وليست Archive (فعلُ الأرشفة)
  copy: Copy,               // نسخ
  externalLink: ExternalLink, // رابط خارجي — الوجهة خارج النظام
  // الأعضاء والصلاحيات
  permissions: ShieldCheck, // صلاحيات
  members: Users,          // مستخدمو النظام جمعاً — وليست User (عميل فرد)
  enabled: CircleCheck,    // مفعّل
  disabled: CircleSlash,   // معطّل
  reactivate: RotateCcw,   // إعادة التفعيل — استعادة لا اعتماد، فلا UserCheck
  // التنقّل
  support: LifeBuoy,       // الدعم — قرار معتمد من المالك، بانتظار تسجيله في naf-icons.md
  notifications: Bell,     // الإشعارات
  menu: Menu,              // القائمة
  adminPanel: SlidersHorizontal, // لوحة الإدارة — وليست Settings (إعدادات) ولا LayoutDashboard (لوحة التحكم)
  next: ArrowLeft,         // التالي
  light: Sun,              // المظهر: الوضع الفاتح
  dark: Moon,              // المظهر: الوضع الداكن
  system: Monitor,         // المظهر: يتبع النظام
  // الوسائط وأنواع الملفات
  fileImage: FileImage,    // ملف صورة
  fileText: FileType,      // ملف نصّي — وليست FileText (مذكرة)
  micStart: Mic,           // بدء الإملاء
  micStop: Square,         // إيقاف التسجيل
  // تقييم الإجابة — إبهام لا مقياس، فلا Star
  helpful: ThumbsUp,
  needsWork: ThumbsDown,
} as const;

/* الأيقونات الاتجاهية:
   أسماء الأسهم والشيفرون في naf-icons.md مسجَّلة بمظهرها النهائي في
   RTL (رجوع = ArrowRight، التالي = ArrowLeft) — أي عكس المتعارف عليه
   في LTR — فتُستعمل كما هي بلا قلب إضافي، وإلا انقلبت مرّتين.
   أمّا ما لا يحمل اسمه جهةً — Send و LogOut — فيحتاج قلباً صريحاً،
   وهو مطبَّق في styles.css على `.send-btn svg`.
   الصياغة في السجلّ تحتمل قراءتين؛ السؤال مرفوع في audit/report.md. */

/** أيقونة نوع الاستشارة. كل الأنواع مسجَّلة في naf-icons.md، فلا احتياطي. */
export function ConsultationIcon({
  option,
  size = ICON_MD,
}: {
  option?: { iconKey?: keyof typeof Icon };
  size?: number;
}) {
  const Glyph = option?.iconKey ? Icon[option.iconKey] : Icon.consultation;
  return <Glyph size={size} aria-hidden />;
}
