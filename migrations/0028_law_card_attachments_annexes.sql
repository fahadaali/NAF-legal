-- الإصدارات الرابع والخامس والسادس من وثيقة الاستيراد: حالُ النظام من بطاقة
-- البوابة (§3-10)، والمرفقات ومواد «مكرر» وطريقة ربط التعديل (§3-11)،
-- والملاحق (§3-12).
--
-- **ولماذا أعمدةٌ لا `meta_json`؟** كانت هذه الحقول تصل فتُحفظ في `meta_json`
-- لأن العقد لا يعرفها — لا تضيع، لكن لا يُبنى عليها شيء. وأربعةٌ منها تدخل
-- طبقة الاسترجاع نفسها: الإلغاء المجدول يُقيَّم وقت الاستعلام (§6-8)، والملحق
-- والمرفق ومادة «مكرر» تُستثنى من الاستدعاء بالرقم أو تُضمّ إليه (§5-6، §5-7)،
-- والرقم السابق يُستدعى به كالحالي. وشرطٌ لا يُكتب في SQL يتجاوزه أوّلُ نداءٍ
-- من مسارٍ آخر.

-- ── حالُ النظام وبيانات إصداره ──
-- `status` في الملف صار حالةَ **النظام** من بطاقته: ساري · ملغى · لم يبدأ
-- العمل به · جاري العمل على النظام. ويُحفظ هنا كما ورد، وعمودُ `status` القديم
-- يبقى لحالِ المادة — ومعناه القديم لا يتّسع لقيمتين من الأربع.
ALTER TABLE legal_chunks ADD COLUMN law_status TEXT;
-- القيمة كما في البطاقة: البوابة تكتب الإلغاء «لاغي».
ALTER TABLE legal_chunks ADD COLUMN law_status_raw TEXT;
-- البوابة · قرار · افتراضي. وحضورُه علامةُ الختم: السطرُ مرّ بآخر خطوةٍ في
-- سلسلة المُرسِل، فحقولُ الحالة فيه مطويّةٌ في `retrieval_status`.
ALTER TABLE legal_chunks ADD COLUMN law_status_source TEXT;
ALTER TABLE legal_chunks ADD COLUMN law_repealed INTEGER NOT NULL DEFAULT 0 CHECK (law_repealed IN (0,1));
ALTER TABLE legal_chunks ADD COLUMN law_pending INTEGER NOT NULL DEFAULT 0 CHECK (law_pending IN (0,1));
-- ميلاديّان `YYYY-MM-DD` — يترتّبان نصّاً كما يترتّبان زمناً، فيُقارَنان بتاريخ
-- الخادم مباشرةً. وغيرُ ذلك يُرفض عند الاستيراد: هجريٌّ هنا يجعل المقارنة
-- تُلغي مادةً في غير يومها.
ALTER TABLE legal_chunks ADD COLUMN law_effective_from TEXT;
ALTER TABLE legal_chunks ADD COLUMN scheduled_repeal_from TEXT;
-- مادةٌ تبقى نافذة بعد إلغاء نظامها — لا يُخرجها إلغاءُ النظام من البحث.
ALTER TABLE legal_chunks ADD COLUMN kept_after_repeal INTEGER NOT NULL DEFAULT 0 CHECK (kept_after_repeal IN (0,1));
ALTER TABLE legal_chunks ADD COLUMN published_hijri TEXT;
ALTER TABLE legal_chunks ADD COLUMN published_gregorian TEXT;
-- أدواتُ الإصدار كلُّها نصّاً: مرسومٌ وقرارُ مجلس وزراء معاً. للعرض وحده.
ALTER TABLE legal_chunks ADD COLUMN instruments TEXT;

-- ── المرفقات ──
ALTER TABLE legal_chunks ADD COLUMN is_attachment INTEGER NOT NULL DEFAULT 0 CHECK (is_attachment IN (0,1));
-- معرّف المادة الأم — وفارغٌ لمرفقٍ لم يُعرف موضعه، فلا يُضمّ إلى مادة.
ALTER TABLE legal_chunks ADD COLUMN attachment_of TEXT;
ALTER TABLE legal_chunks ADD COLUMN has_attachment INTEGER NOT NULL DEFAULT 0 CHECK (has_attachment IN (0,1));
ALTER TABLE legal_chunks ADD COLUMN text_from_attachment INTEGER NOT NULL DEFAULT 0 CHECK (text_from_attachment IN (0,1));
-- كيف رُبطت نوافذ التعديل: رقم · عنوان · ترتيب — للتدقيق لا للعرض.
ALTER TABLE legal_chunks ADD COLUMN amend_link TEXT;

-- ── الرقم السابق ──
-- «(المادة 231 حالياً) (المادة 240 سابقاً)» — تُستدعى بالرقمين.
ALTER TABLE legal_chunks ADD COLUMN former_article_no TEXT;
ALTER TABLE legal_chunks ADD COLUMN former_article_no_norm TEXT;

-- ── الملاحق ومواد «مكرر» ──
-- الملحق رقمُه اصطلاحيّ (`1001` فما بعده) للترتيب وحده: لا يُعرض ولا يُستشهد
-- به ولا يُستدعى.
ALTER TABLE legal_chunks ADD COLUMN is_annex INTEGER NOT NULL DEFAULT 0 CHECK (is_annex IN (0,1));
-- مادة «مكرر» مستقلّة برقم المادة الأصل — تُعرف بلاحقة معرّفها
-- (`…/art-015-mukarrar`)، ولا حقلَ لها في الملف غيرُها.
ALTER TABLE legal_chunks ADD COLUMN is_mukarrar INTEGER NOT NULL DEFAULT 0 CHECK (is_mukarrar IN (0,1));

CREATE INDEX IF NOT EXISTS idx_legal_attachment_of ON legal_chunks(attachment_of);
CREATE INDEX IF NOT EXISTS idx_legal_former       ON legal_chunks(law_id, former_article_no_norm);
CREATE INDEX IF NOT EXISTS idx_legal_repeal_due   ON legal_chunks(scheduled_repeal_from);

-- ── ترحيل ما سبق ──
-- ما استُورد قبل هذه الهجرة من ملفٍّ حمل هذه الحقول حُفظت فيه في `meta_json`.
-- فتُنقل إلى أعمدتها ليعمل عليها ما بُني الآن، إلى أن تُرفع الدفعة التالية
-- فتكتبها في موضعها. والنقلُ قراءةٌ لما ورد لا استنباط: ما لم يرد يبقى على
-- افتراضه.
UPDATE legal_chunks SET
  law_status_source = json_extract(meta_json, '$.law_status_source'),
  law_status_raw = json_extract(meta_json, '$.status_raw'),
  law_repealed = CASE WHEN json_extract(meta_json, '$.law_repealed') IN (1, '1', 'true') THEN 1 ELSE 0 END,
  law_pending = CASE WHEN json_extract(meta_json, '$.law_pending') IN (1, '1', 'true') THEN 1 ELSE 0 END,
  kept_after_repeal = CASE WHEN json_extract(meta_json, '$.kept_after_repeal') IN (1, '1', 'true') THEN 1 ELSE 0 END,
  -- التاريخان يُنقلان حين يكونان بالصيغة وحدها: ما خالفها يُترك لإعادة الرفع
  -- التي تفحصه، ولا يُنقل ليُقارَن مقارنةً خاطئة.
  law_effective_from = CASE WHEN json_extract(meta_json, '$.law_effective_from')
                              GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                            THEN json_extract(meta_json, '$.law_effective_from') END,
  scheduled_repeal_from = CASE WHEN json_extract(meta_json, '$.scheduled_repeal_from')
                                 GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                               THEN json_extract(meta_json, '$.scheduled_repeal_from') END,
  published_hijri = json_extract(meta_json, '$.published_hijri'),
  published_gregorian = json_extract(meta_json, '$.published_gregorian'),
  is_attachment = CASE WHEN json_extract(meta_json, '$.is_attachment') IN (1, '1', 'true') THEN 1 ELSE 0 END,
  attachment_of = json_extract(meta_json, '$.attachment_of'),
  has_attachment = CASE WHEN json_extract(meta_json, '$.has_attachment') IN (1, '1', 'true') THEN 1 ELSE 0 END,
  text_from_attachment = CASE WHEN json_extract(meta_json, '$.text_from_attachment') IN (1, '1', 'true') THEN 1 ELSE 0 END,
  amend_link = json_extract(meta_json, '$.amend_link'),
  former_article_no = CAST(json_extract(meta_json, '$.former_article_no') AS TEXT),
  former_article_no_norm = CASE WHEN json_type(meta_json, '$.former_article_no') = 'integer'
                                THEN CAST(json_extract(meta_json, '$.former_article_no') AS TEXT) END,
  is_annex = CASE WHEN json_extract(meta_json, '$.is_annex') IN (1, '1', 'true') THEN 1 ELSE 0 END
WHERE meta_json IS NOT NULL AND json_valid(meta_json);

-- ومادة «مكرر» من معرّفها — وهو ما يعرفها به الملف نفسه.
UPDATE legal_chunks SET is_mukarrar = 1
 WHERE id GLOB '*-mukarrar' OR id GLOB '*-mukarrar[0-9]' OR id GLOB '*-mukarrar[0-9][0-9]';
