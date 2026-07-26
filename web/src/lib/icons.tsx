/* ============================================================
   ربط مفاهيم المنصة بأيقونات Lucide.
   المرجع الوحيد: naf-icons.md من fahadaali/naf-ui#v1.3.0.
   لا تُضِف مفتاحاً هنا قبل تسجيل معناه في السجلّ — القاعدة في
   CLAUDE.md §3: المعنى الواحد أيقونة واحدة في المنصات الخمس.
   ============================================================ */

import {
  ArrowLeft,
  Bell,
  Briefcase,
  Calendar,
  CircleCheck,
  Download,
  FileOutput,
  FileText,
  Menu,
  MessageSquare,
  Paperclip,
  Pencil,
  RefreshCw,
  ScrollText,
  Search,
  Send,
  Share2,
  Stamp,
  Trash2,
  TriangleAlert,
  Upload,
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
  close: X,                // إغلاق — ولا تُستعمل للحذف أبداً
  // الكيانات
  matter: Briefcase,       // ملف / مسألة
  consultation: MessageSquare, // استشارة
  contract: Stamp,         // عقد
  memo: FileText,          // مذكرة
  pleading: ScrollText,    // لائحة
  appointment: Calendar,   // موعد
  attachment: Paperclip,   // مرفق
  // الحالات
  approved: CircleCheck,   // معتمد
  warning: TriangleAlert,  // تحذير
  // التنقّل
  notifications: Bell,     // الإشعارات
  menu: Menu,              // القائمة
  next: ArrowLeft,         // التالي
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
