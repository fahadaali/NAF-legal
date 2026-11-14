/**
 * بريدُ رمز التحقق للضيف — قالبُه كلُّه هنا، وألفاظُه من `naf-terms.md` §١٥.
 *
 * **قيمٌ حرفية وخصائص اتجاهٍ فيزيائية، عمداً.** هذا من استثناء القوالب البريدية
 * في `CLAUDE.md` §١: عملاء البريد لا يقرؤون `var(--…)` ولا `oklch()`، وبعضُ عملاء
 * سطح المكتب لا يعرف الخصائص المنطقية. فالألوان أدناه هي قيم الوضع الفاتح في
 * `naf-theme.css` محوّلةً إلى hex، والرسالة فاتحةٌ أيّاً كان وضع القارئ. وحين
 * يتغيّر الثيم تُحدَّث هنا يدوياً. ولا يخرج شيءٌ من هذا الملف إلى الواجهة.
 *
 * والرمز أوّلَ الموضوع: يُقرأ في الإشعار دون فتح الرسالة، وتلتقطه تعبئةُ الرمز
 * من البريد في الأجهزة. وفي المتن كبيرٌ في إطار، باتجاهٍ من اليسار فلا تُقلَب
 * أرقامه، بلا مسافاتٍ بينها فيُنسخ كما هو.
 */

// قيم الوضع الفاتح من `naf-theme.css` (oklch → hex).
const BG = '#E8EBED'; // --background
const CARD = '#FFFFFF'; // --card
const FG = '#333333'; // --foreground
const MUTED_FG = '#646A78'; // --muted-foreground
const MUTED = '#F9FAFB'; // --muted
const BORDER = '#D9D9D9'; // --border
const PRIMARY = '#937133'; // --primary
const FONT = "'IBM Plex Sans Arabic', Tahoma, Arial, sans-serif"; // --font-sans، وبدائلُ تعرفها عملاء البريد

const SUBJECT = (code: string) => `${code} — رمز التحقق لربط مستشار ناف`;
const TITLE = 'رمز التحقق';
const VALIDITY = 'صالح عشر دقائق، ولمرة واحدة.';
const FOOTER = 'لم تطلب هذا الرمز؟ تجاهل هذه الرسالة، ولن يُربط شيء.';
const SIGNATURE = 'مستشار ناف';

export function buildCodeEmail(code: string, logoUrl: string): { subject: string; text: string; html: string } {
  const text = `رمز التحقق: ${code} — ${VALIDITY}\n\n${code}\n\n${FOOTER}\n\n— ${SIGNATURE}`;
  // الرمز أرقامٌ ستّة يولّدها الخادم، فلا تهريب فيه. والشعار عنوانٌ من أصل المنصة.
  const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${TITLE}</title></head>
<body style="margin:0;padding:0;background:${BG};">
<div style="display:none;max-height:0;overflow:hidden;">${code} — ${TITLE}. ${VALIDITY}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:${CARD};border:1px solid ${BORDER};border-radius:12px;font-family:${FONT};direction:rtl;text-align:right;">
<tr><td align="center" style="padding:32px 32px 8px;">
<img src="${logoUrl}" width="56" height="56" alt="${SIGNATURE}" style="display:block;border:0;border-radius:12px;">
</td></tr>
<tr><td align="center" style="padding:8px 32px 0;font-size:20px;line-height:32px;font-weight:700;color:${FG};">${TITLE}</td></tr>
<tr><td align="center" style="padding:16px 32px;">
<div dir="ltr" style="display:inline-block;padding:12px 24px;background:${MUTED};border:1px solid ${BORDER};border-right:4px solid ${PRIMARY};border-radius:8px;font-family:'Courier New',monospace;font-size:34px;line-height:44px;font-weight:700;letter-spacing:6px;color:${FG};">${code}</div>
</td></tr>
<tr><td align="center" style="padding:0 32px 24px;font-size:15px;line-height:26px;color:${FG};">${VALIDITY}</td></tr>
<tr><td style="padding:16px 32px 28px;border-top:1px solid ${BORDER};font-size:13px;line-height:22px;color:${MUTED_FG};text-align:right;">${FOOTER}<br>— ${SIGNATURE}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  return { subject: SUBJECT(code), text, html };
}
