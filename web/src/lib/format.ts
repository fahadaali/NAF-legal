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

/** نظام ٢٤ ساعة: "14:30" */
export function formatTime(value: Date | string | number): string {
  const date = toDate(value)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** الجوال السعودي: "+966 5X XXX XXXX" */
export function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, "").replace(/^00966|^966|^0/, "")
  if (digits.length !== 9) return value
  return `+966 ${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5)}`
}
