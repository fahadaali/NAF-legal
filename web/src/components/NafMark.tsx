import { ICON_LG } from '../lib/icons';

/**
 * علامة ناف من السجلّ — fahadaali/naf-ui/naf-logo#v1.3.0.
 * نسختان لأن العلامة أحادية الحبر: الداكنة للأسطح الداكنة والعكس.
 * الاختيار بصنف `dark` على الجذر لا بحالة React، فتعمل قبل ترطيب
 * الصفحة ولا تحتاج تمرير الثيم إلى كل شاشة.
 * الشعار لا يُقلب ولا يُعاد تلوينه (naf-icons.md §قواعد القلب).
 */
export default function NafMark({ className = 'brand-logo-img' }: { className?: string }) {
  return (
    <span className="naf-mark" role="img" aria-label="ناف" style={{ display: 'inline-flex' }}>
      <img className={`${className} naf-mark-light`} src="/brand/naf-mark.svg" alt="" width={ICON_LG} height={ICON_LG} aria-hidden />
      <img className={`${className} naf-mark-dark`} src="/brand/naf-mark-dark.svg" alt="" width={ICON_LG} height={ICON_LG} aria-hidden />
    </span>
  );
}
