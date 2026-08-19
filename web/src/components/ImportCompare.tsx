// نافذة إعادة رفع نظام: استبدالٌ أو مقارنة.
//
// إعادة الرفع تكتب فوق نصوص نظامية. وكتابةٌ بلا سؤال تجعل المستورِد يكتشف
// ما تغيّر بعد وقوعه — إن اكتشفه. فتُعرض المقارنة أولاً: كم مادة ستُضاف،
// وكم ستتغيّر وبأيّ حقل، وأيّ نصٍّ سيحلّ محلّ أيّ نصّ.
//
// والقديم لا يضيع على أي حال: يُؤرشَف في سجلّ تحديث النظام قبل الكتابة.
import { useState } from 'react';
import { type LegalImportDiff } from '../lib/api';
import { formatNumber } from '../lib/format';
import { modalCardProps, useModalDismiss } from '../lib/modal';

/** ألفاظ الحالة كما تظهر في بقيّة اللوحة — لا لفظان لمعنى واحد. */
const STATUS_LABELS: Record<string, string> = { active: 'ساري', amended: 'معدَّل', repealed: 'ملغى' };

/** أسماء الحقول التي تُقارَن، بالعربية. */
const FIELD_LABELS: Record<string, string> = {
  text: 'النصّ',
  article_no: 'رقم المادة',
  status: 'الحالة',
  is_repealed: 'النسخ',
  instrument_no: 'رقم الأداة',
  issue_date: 'تاريخ الإصدار',
};

export function ImportCompare({
  filename,
  diff,
  onApply,
  onCancel,
}: {
  filename: string;
  diff: LegalImportDiff;
  onApply: () => void;
  onCancel: () => void;
}) {
  useModalDismiss(onCancel);
  // «مقارنة» تُظهر التفصيل، و«استبدال» تعتمد بلا قراءته. والافتراض العرض:
  // من فتح النافذة أصلاً لأن في الملف ما يمسّ قائماً.
  const [detailed, setDetailed] = useState(false);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card intake" {...modalCardProps}>
        <div className="modal-head">
          <span className="modal-title">
            هذا النظام مستورد سابقاً — <bdi>{filename}</bdi>
          </span>
          <button className="modal-close" onClick={onCancel} title="إغلاق">×</button>
        </div>

        <div className="modal-body intake-body">
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>مواد جديدة</th>
                  <th>مواد تتغيّر</th>
                  <th>مواد بلا تغيير</th>
                  <th>مواد ليست في الملف</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><bdi>{formatNumber(diff.added)}</bdi></td>
                  <td><bdi>{formatNumber(diff.changed)}</bdi></td>
                  <td><bdi>{formatNumber(diff.unchanged)}</bdi></td>
                  <td><bdi>{formatNumber(diff.missing)}</bdi></td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* الغائب عن الملف يُحصى ولا يُحذف: ملفٌّ جزئيّ يجعل سائر النظام
              «غائباً»، والحذف على هذا الظنّ يمحو نظاماً كاملاً. */}
          {diff.missing > 0 ? (
            <p>مواد قائمة في القاعدة ولا وجود لها في هذا الملف — تبقى كما هي ولا تُحذف.</p>
          ) : null}

          {diff.changed > 0 && !detailed ? (
            <button className="btn-sm" onClick={() => setDetailed(true)}>مقارنة</button>
          ) : null}

          {detailed &&
            diff.changes.map((ch) => (
              <div key={ch.id} className="compare-row">
                <h4>
                  المادة <bdi>{ch.old_article_no ?? ch.id}</bdi>
                  {ch.fields.map((f) => (
                    <span key={f} className="pill warn">{FIELD_LABELS[f] ?? f}</span>
                  ))}
                </h4>
                {ch.old_article_no !== ch.new_article_no ? (
                  <p>
                    رقم المادة: <bdi>{ch.old_article_no ?? '—'}</bdi> ← <bdi>{ch.new_article_no ?? '—'}</bdi>
                  </p>
                ) : null}
                {ch.old_status !== ch.new_status ? (
                  <p>
                    الحالة: {STATUS_LABELS[ch.old_status] ?? ch.old_status} ←{' '}
                    {STATUS_LABELS[ch.new_status] ?? ch.new_status}
                  </p>
                ) : null}
                {/* النصّان لا يُعرضان إلا إن تغيّر النصّ: عرضُ نصٍّ واحد
                    مرّتين تحت عنوانَي «الحالي» و«الجديد» يُوهم فرقاً لا وجود له. */}
                {ch.fields.includes('text') ? (
                  <div className="compare-pair">
                    <div>
                      <div className="compare-label">النصّ الحالي</div>
                      <p>{ch.old_text}</p>
                    </div>
                    <div>
                      <div className="compare-label">النصّ الجديد</div>
                      <p>{ch.new_text}</p>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}

          {detailed && diff.changes_truncated > 0 ? (
            <p>
              ومواد أخرى متغيّرة لم تُعرَض: <bdi>{formatNumber(diff.changes_truncated)}</bdi>
            </p>
          ) : null}
        </div>

        <div className="modal-foot">
          <button className="btn-sm primary" onClick={onApply}>اعتماد</button>
          <button className="btn-sm" onClick={onCancel}>إلغاء</button>
        </div>
      </div>
    </div>
  );
}
