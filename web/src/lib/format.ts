/* ============================================================
   دوال التنسيق المشتركة لمنصات ناف.
   لا تنسّق رقماً ولا تاريخاً ولا مبلغاً في مكوّن. من هنا حصراً.

   القواعد المعتمدة:
   - أرقام غربية دائماً
   - فاصل الآلاف بالفاصلة
   - المبالغ بخانتين عشريتين دائماً
   - الوقت بنظام ٢٤ ساعة
   - التاريخ الميلادي: 2026/07/26
   - التاريخ الهجري: 1448/02/11 هـ
   ============================================================ */

const AMOUNT_FORMAT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const NUMBER_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
})

const HIJRI_FORMAT = new Intl.DateTimeFormat("en-US-u-ca-islamic-umalqura-nu-latn", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value)
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

/**
 * يعزل قيمة اتجاهياً داخل نص عربي.
 *
 * للسلاسل الخام التي لا يصلح فيها <bdi>: رسائل confirm ونصوص الحالة
 * والتنبيهات. في JSX استعمل <bdi> لا هذه.
 *
 * المحرفان U+2068 (عزل أول) و U+2069 (إنهاء العزل).
 *
 * القاعدة توجب عزل كل رقم وتاريخ ومبلغ، و<bdi> يغطّي JSX وحده — فبدون
 * هذه الدالة تبقى كل رسالة فيها رقم منحرفة.
 *
 * @example
 *   setMsg(`تم حذف ${isolate(count)} عنصراً`)
 *   confirm(`حذف ${isolate(n)} عنصراً نهائياً؟`)
 */
export function isolate(value: string | number): string {
  return `\u2068${value}\u2069`
}

/** المبلغ بلا رمز العملة: 12400 -> "12,400.00" */
export function formatAmount(value: number): string {
  return AMOUNT_FORMAT.format(value)
}

/** عدد صحيح بفاصل آلاف: 12400 -> "12,400" */
export function formatNumber(value: number): string {
  return NUMBER_FORMAT.format(value)
}

/** ميلادي: "2026/07/26" */
export function formatDate(value: Date | string | number): string {
  const date = toDate(value)
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
}

/** هجري أم القرى: "1448/02/11 هـ" */
export function formatHijriDate(value: Date | string | number): string {
  const parts = HIJRI_FORMAT.formatToParts(toDate(value))
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ""
  return `${get("year")}/${get("month")}/${get("day")} هـ`
}

/** المزدوج: الميلادي أولاً ثم الهجري بين قوسين */
export function formatDualDate(value: Date | string | number): string {
  return `${formatDate(value)} (${formatHijriDate(value)})`
}

/**
 * الشهر والسنة لعناوين التقويم ومنتقي التاريخ: "2026/07".
 *
 * مشتقّة من الصيغة الميلادية المعتمدة بحذف اليوم — ليست صيغة جديدة.
 * أسماء الأشهر العربية ليست صيغة معتمدة لعرض قيمة تاريخ.
 */
export function formatMonth(value: Date | string | number): string {
  const date = toDate(value)
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}`
}

/** نظام ٢٤ ساعة: "14:30" */
export function formatTime(value: Date | string | number): string {
  const date = toDate(value)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}


/**
 * عنوان تجميع قائمة زمنية: "اليوم" · "أمس" · "2026/07/26"
 *
 * تسميةُ واجهةٍ لا قيمةُ تاريخ — المسجَّل في naf-terms.md §٥ «عناوين تجميع
 * القوائم الزمنية». والتاريخ داخل الصفّ يبقى على `formatDate` ولا يُستبدل
 * بهذا العنوان.
 *
 * واثنان لا ثالث لهما: «قبل يومين» وأخواتها تفرض على قارئها حساباً ليعرف
 * اليوم المقصود، وما بعد الأمس يُكتب تاريخاً صريحاً.
 *
 * والمقارنة بحدود اليوم المحلّي لا بفارق ٢٤ ساعة: رسالةٌ عند منتصف الليل
 * وأخرى بعده بدقيقة يومان مختلفان وإن لم يفصل بينهما إلا دقيقة.
 */
export function formatDayHeading(value: Date | string | number, now: Date = new Date()): string {
  const date = toDate(value)
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (days === 0) return "اليوم"
  if (days === 1) return "أمس"
  return formatDate(date)
}

/** الجوال السعودي: "+966 5X XXX XXXX" */
export function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, "").replace(/^00966|^966|^0/, "")
  if (digits.length !== 9) return value
  return `+966 ${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5)}`
}

/** الميلادي مع الوقت: "2026/07/26 14:30" */
export function formatDateTime(value: Date | string | number): string {
  return `${formatDate(value)} ${formatTime(value)}`
}
