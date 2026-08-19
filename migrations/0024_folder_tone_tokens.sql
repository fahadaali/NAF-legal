-- ============================================================
-- شارةُ القضية تحمل نغمةً من سلّم ناف، لا قيمة hex خام.
--
-- الهجرات للأمام فقط: لا يُعدَّل هذا الملف بعد تشغيله ولو مرة واحدة.
-- ============================================================

-- `routes/folders.ts` كان يولّد ستّ قيم hex ويكتبها في `case_folders.color`،
-- والشريط الجانبي يرسمها `style={{ background: f.color }}`. فهي قيمةُ تصميمٍ
-- خام تُكتب في القاعدة وتُرسم في الواجهة: لا تتبع الوضعين الفاتح والداكن،
-- ولا تُحدَّث بتحديث الثيم، ولا يشملها أيٌّ من استثناءات `CLAUDE.md` §1
-- الأربعة — فتلك كلُّها سياقاتٌ لا تقرأ متغيّر CSS، وهذه تقرؤه.
--
-- والقيمة الآن اسمُ نغمةٍ يقابل `--chart-1..5` في `naf-theme.css`، ولها
-- قيمتان مسجَّلتان في الوضعين.
--
-- والمقابلة بالترتيب لا بالتقارب اللوني: الستّ القديمة أُسندت إلى الخمس
-- بالدور. فقد تتبدّل نغمةُ قضيةٍ قائمة — وهي شارةُ تمييزٍ لا معنى تحمله،
-- ومحاولةُ مطابقة اللون القديم تُدخل حساباً لونياً في هجرة بلا مقابل.

UPDATE case_folders SET color = 'chart-1' WHERE color = '#b8a488';
UPDATE case_folders SET color = 'chart-2' WHERE color = '#86a6d4';
UPDATE case_folders SET color = 'chart-3' WHERE color = '#6fca9a';
UPDATE case_folders SET color = 'chart-4' WHERE color = '#c2ad8e';
UPDATE case_folders SET color = 'chart-5' WHERE color = '#8f9bb3';
UPDATE case_folders SET color = 'chart-1' WHERE color = '#d0a879';

-- وما لم يطابق شيئاً — صفٌّ قديم بلون آخر، أو `NULL` — يأخذ الأولى.
-- والواجهة تحرس الحدّ الأخير أيضاً: قيمةٌ لا تُعرف تُرسم بالنغمة الأولى.
UPDATE case_folders SET color = 'chart-1' WHERE color IS NULL OR color NOT IN
  ('chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5');
