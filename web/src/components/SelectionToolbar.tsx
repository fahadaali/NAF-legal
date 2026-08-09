// شريط التحديد — يظهر فوق ما حدّده القارئ في المحادثة.
//
// النسخ وحده لا يكفي: المحامي يقرأ مذكّرةً مولَّدة فيقف عند جملةٍ يريد أن
// يعود إليها — مادةٌ استُشهد بها، أو صياغةٌ يريد تغييرها. فالتظليل يُبقي ذلك
// الوقوف بعد أن تُغلق الصفحة، والاقتباس ينقله إلى صندوق الكتابة ليُبنى عليه
// السؤال التالي بلا نسخٍ ولصقٍ يدويّ.
//
// والأزرار تظهر بقدر ما يملكه القارئ: «مستخدم (اطّلاع)» لا يكتب في المنصة —
// فلا تظليل يُحفَظ له ولا صندوق يُقتَبس إليه — ويبقى له النسخ.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, ICON_SM } from '../lib/icons';

/**
 * فُرجةٌ بين الشريط وحافّة النافذة، وبينه وبين ما حُدِّد.
 *
 * قياسُ موضعٍ لا قيمةُ تصميم: الشريط يُوضع بحسابٍ من مستطيلٍ قاسه المتصفّح،
 * ولا يقع على شبكة المسافات أصلاً.
 */
const GAP = 8;

/** مستطيل ما حُدِّد، بإحداثيات النافذة. */
export interface SelectionAnchor {
  top: number;
  bottom: number;
  /** منتصف المستطيل أفقياً — `left` فيزيائيّ لأن القياس منه في الاتجاهين. */
  center: number;
}

export interface SelectionToolbarProps {
  anchor: SelectionAnchor;
  onCopy: () => void;
  /** يغيب عند القارئ: التظليل يُحفَظ في الخادم وهو لا يكتب. */
  onHighlight?: () => void;
  /** يحضر حين يقع التحديد داخل تظليلٍ قائم. */
  onRemoveHighlight?: () => void;
  /** يغيب عند القارئ: لا صندوق كتابةٍ يُقتَبس إليه. */
  onQuote?: () => void;
}

export default function SelectionToolbar({
  anchor,
  onCopy,
  onHighlight,
  onRemoveHighlight,
  onQuote,
}: SelectionToolbarProps) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);

  /* الموضع يُحسب بعد القياس لا قبله.
     شريطٌ يُوضع بمنتصف التحديد وحده يخرج نصفُه عن الشاشة حين يقع التحديد
     عند حافّتها — وهو يقع عندها كثيراً على عرض ٣٧٥. فيُقاس عرضه ثم يُحبَس
     داخل النافذة. وفوق التحديد ما وسِع، وتحته إن لم يسع. */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const left = Math.min(Math.max(anchor.center - w / 2, GAP), Math.max(GAP, window.innerWidth - w - GAP));
    const above = anchor.top - h - GAP >= GAP;
    setBox({ top: above ? anchor.top - h - GAP : anchor.bottom + GAP, left });
  }, [anchor.top, anchor.bottom, anchor.center]);

  // الشارة تعود إلى «نسخ» بعد لحظة، ولا تبقى معلّقة إن هُدم الشريط قبلها.
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  /* منعُ الافتراضي على `mousedown`: ضغطةُ الفأرة على الشريط تُلغي التحديد
     قبل أن يصل النقر، فيقع الفعل على تحديدٍ ذهب. */
  const hold = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div
      ref={ref}
      className="selection-toolbar"
      // قبل القياس يبقى مخفياً في مكانه: وميضٌ في زاوية الشاشة ثم قفزة.
      style={box ? { top: box.top, left: box.left } : { top: 0, left: 0, visibility: 'hidden' }}
      role="toolbar"
      onMouseDown={hold}
    >
      <button
        className="btn-sm"
        onClick={() => {
          onCopy();
          setCopied(true);
        }}
      >
        <Icon.copy size={ICON_SM} aria-hidden /> {copied ? 'تم النسخ' : 'نسخ'}
      </button>
      {onHighlight ? (
        <button className="btn-sm" onClick={onHighlight}>
          <Icon.highlightText size={ICON_SM} aria-hidden /> تظليل
        </button>
      ) : null}
      {/* بلا أيقونة: لا صفَّ لـ«مسح التظليل» في naf-icons.md، و`Eraser`
          مأخوذةٌ لمعنىً آخر. وزرٌّ بنصٍّ وحده أصدق من أيقونةٍ تعني غيره. */}
      {onRemoveHighlight ? (
        <button className="btn-sm" onClick={onRemoveHighlight}>
          مسح التظليل
        </button>
      ) : null}
      {onQuote ? (
        <button className="btn-sm" onClick={onQuote}>
          <Icon.quote size={ICON_SM} aria-hidden /> اقتباس
        </button>
      ) : null}
    </div>
  );
}
