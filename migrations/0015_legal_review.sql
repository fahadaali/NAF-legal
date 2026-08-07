-- وحدة مراجعة المواد — حالُ المادة عند المراجع البشري، وأثرُ قراره.
--
-- **المبدأ الحاكم: الفصل التام.** المراجعة لا توقف شيئاً. المواد الجاهزة
-- تدخل الاسترجاع فور الاستيراد، والموسومة تنتظر في طابورٍ مستقلّ يُراجَع متى
-- اتّسع الوقت — مادةً أو خمسين — بلا أثر على الباقي وبلا إعادة استيراد.
--
-- والخطأ الذي يتجنّبه هذا: أن تصير المراجعة بوابةً تعطّل قاعدة المعرفة كلَّها
-- انتظاراً لفراغ المراجع.

-- ── حال المادة عند المراجع ──
-- `pending` تنتظر · `approved` اعتُمدت كما وردت · `edited` حُرِّر نصُّها ثم
-- اعتُمدت · `rejected` استُبعدت — خطأ تقطيعٍ أو تكرارٌ زائد · `deferred`
-- أُجِّل البتّ فيها.
--
-- والداخل في الاسترجاع منها اثنتان: `approved` و`edited`. أمّا `rejected`
-- و`deferred` فتبقيان محجوبتين، وتخرجان من الطابور فلا تعودان على المراجع.
ALTER TABLE legal_chunks ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (review_status IN ('pending','approved','edited','rejected','deferred'));

ALTER TABLE legal_chunks ADD COLUMN review_note TEXT;

-- نصّ المادة كما ورد من السحب قبل أيّ تحرير.
--
-- يُكتب مرّةً واحدة عند أوّل تحرير ولا يُمسّ بعدها: هو الأصل الذي يُرجَع إليه
-- عند التراجع، وكتابتُه في كل تحرير تجعل «الأصل» آخرَ ما حُرِّر لا ما جاء من
-- المصدر. ولا يُعرض في الاستشهاد ولا يُحذف.
ALTER TABLE legal_chunks ADD COLUMN text_original_import TEXT;

-- نوع التعديل مطبَّعاً — عليه تقوم طوابير التصنيف.
-- «غير مصنَّف» تُكتب بالشدّة وبدونها، والمطابقة الحرفية تُسقط نصف الطابور.
ALTER TABLE legal_chunks ADD COLUMN amendment_kind_norm TEXT;

CREATE INDEX IF NOT EXISTS idx_legal_review_status ON legal_chunks(review_status, needs_review);
CREATE INDEX IF NOT EXISTS idx_legal_kind_norm     ON legal_chunks(amendment_kind_norm);

-- ── ترحيل ما سبق ──
-- الاعتماد كان يُقرأ من `reviewed_at` وحده قبل أن تصير للحال قيمةٌ صريحة.
UPDATE legal_chunks SET review_status = 'approved' WHERE reviewed_at IS NOT NULL;

-- تطبيعٌ أوّليّ للقيم القائمة: الشدّة والتطويل وحدهما — وهما كلُّ ما يقع في
-- ستّ قيمٍ ثابتة. وأوّل استيراد بعد هذه الهجرة يكتبها بالتطبيع الكامل.
UPDATE legal_chunks
   SET amendment_kind_norm = REPLACE(REPLACE(amendment_kind, 'ّ', ''), 'ـ', '')
 WHERE amendment_kind IS NOT NULL;

-- ── سجلّ التدقيق ──
-- كل تغيير يُقيَّد: السجلّ، والحقل، والقيمة قبل وبعد، ومن غيّرها، ومتى.
--
-- وفي منتجٍ قانوني هذا ليس ترفاً: إن سُئلت لاحقاً عن مصدر نصّ مادةٍ في
-- استشارة، لزمك أن تُثبت من أين جاء ومن اعتمده. وهو جدولٌ مستقلّ عن
-- `legal_chunk_versions`: ذاك يحفظ **النصوص** التي أُزيحت، وهذا يحفظ
-- **القرارات** التي وقعت — ومن اعتمد نصّاً بلا تغييره لم يُزِح شيئاً وقراره
-- يجب أن يبقى.
CREATE TABLE IF NOT EXISTS legal_review_audit (
  id         TEXT PRIMARY KEY,
  chunk_id   TEXT NOT NULL,
  law_id     TEXT,
  -- الحقل الذي تغيّر: `review_status` · `text` · `review_note`
  field      TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  actor_id   TEXT,
  at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_audit_chunk ON legal_review_audit(chunk_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_review_audit_at    ON legal_review_audit(at DESC);
