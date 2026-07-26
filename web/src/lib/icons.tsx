/* ============================================================
   ربط مفاهيم المنصة بأيقونات Lucide.
   المرجع الوحيد: naf-icons.md من fahadaali/naf-ui#v1.3.0.
   لا تُضِف مفتاحاً هنا قبل تسجيل معناه في السجلّ — القاعدة في
   CLAUDE.md §3: المعنى الواحد أيقونة واحدة في المنصات الخمس.
   ============================================================ */

import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BadgeCheck,
  BookCheck,
  Bell,
  Briefcase,
  Calendar,
  CircleCheck,
  CircleHelp,
  Download,
  FileImage,
  FileOutput,
  FileText,
  FileType,
  Folder,
  Globe,
  Library,
  Menu,
  MessageSquare,
  MessageSquareWarning,
  Mic,
  Moon,
  Paperclip,
  Pencil,
  RefreshCw,
  Replace,
  ScrollText,
  Search,
  Send,
  Share2,
  SpellCheck,
  Square,
  Stamp,
  Sun,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  TriangleAlert,
  Upload,
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
  pleading: ScrollText,    // لائحة
  appointment: Calendar,   // موعد
  attachment: Paperclip,   // مرفق
  officialSource: BadgeCheck, // مصدر رسمي — وليست ShieldCheck (صلاحيات)
  citationChecked: BookCheck, // إسناد مُتحقَّق منه — وليست CircleCheck (اعتماد)
  clauseBank: Library,     // بنك البنود
  folder: Folder,          // مجلّد
  tools: Wrench,           // الأدوات
  systemCheck: Activity,   // فحص النظام — نتيجته نصّ ولون لا أيقونة ثانية
  // الحالات
  approved: CircleCheck,   // معتمد
  warning: TriangleAlert,  // تحذير
  changesRequested: MessageSquareWarning, // مطلوب تعديلات — وليست CircleX (مرفوض)
  awaitingClarification: CircleHelp,      // بانتظار توضيح — وليست Clock
  // التنقّل
  notifications: Bell,     // الإشعارات
  menu: Menu,              // القائمة
  next: ArrowLeft,         // التالي
  light: Sun,              // الوضع الفاتح
  dark: Moon,              // الوضع الداكن
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

/** أيقونة نوع الاستشارة: من السجلّ إن كان المعنى مسجَّلاً، وإلا إيموجي مؤقّتة. */
export function ConsultationIcon({
  option,
  size = ICON_MD,
}: {
  option?: { iconKey?: keyof typeof Icon; icon?: string };
  size?: number;
}) {
  const key = option?.iconKey;
  if (key) {
    const Glyph = Icon[key];
    return <Glyph size={size} aria-hidden />;
  }
  if (option?.icon) return <span aria-hidden>{option.icon}</span>;
  return <Icon.consultation size={size} aria-hidden />;
}
