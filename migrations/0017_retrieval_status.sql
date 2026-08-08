-- الإصدار الثالث من مواصفة الاستيراد: حالُ الاسترجاع، والخطّ الزمني، وسجلّ
-- التعديلات المفكَّك.
--
-- **الحقل الحاسم `retrieval_status`.** المواصفة تجعله المصدر الوحيد لقرار
-- الاسترجاع، والغرض ألا تستنتج المنصة القاعدة من أربعة حقول منطقية: أيُّ
-- مسارٍ يُغفل شرطاً واحداً يُخرج نصّاً منسوخاً في وجه المستخدم.
--
-- ويُخزَّن بالقيم الثلاث المسجَّلة لا بألفاظها العربية، كما تُخزَّن الحالة:
-- `effective` نافذ · `effective_warning` نافذ بتحذير · `repealed` ملغى.
-- والمقابلة في `src/lib/legal.ts` — ترجمةٌ محصورة لا حالةٌ رابعة.
ALTER TABLE legal_chunks ADD COLUMN retrieval_status TEXT NOT NULL DEFAULT 'effective';

-- نصّ التحذير جاهزاً للعرض. يأتي من الملف، وله بديلٌ مسجَّل إن غاب.
ALTER TABLE legal_chunks ADD COLUMN retrieval_warning TEXT;

-- الخطّ الزمني: مصفوفة نسخ مرتَّبة، أوّلها الأصل وآخرها النافذ.
--
-- **ولا تُفهرَس.** نسخٌ تاريخية، وفهرستها تجعل البحث يطابق نصّاً منسوخاً —
-- ولذلك بقيت خارج `legal_fts` وخارج `embed_text` كليهما.
ALTER TABLE legal_chunks ADD COLUMN text_versions TEXT;

-- سجلّ التعديلات مفكَّكاً: عنصرٌ لكل عملية، والنافذة الواحدة قد تحمل عدّة.
-- به تصير المراجعة تحقّقاً من خطوةٍ معلومة لا قراءةَ نصٍّ خام.
ALTER TABLE legal_chunks ADD COLUMN amendment_events TEXT;

-- ── العطب مقابل التحذير ──
-- المواصفة تُدخل `نافذ_بتحذير` البحثَ موسوماً، وحجّتها أن الصمت ليس حياداً:
-- المادة صحيحة وينقصها دمجٌ تعذّر. وهذه الحجّة لا تصدق على ما وُسِم لعطبٍ في
-- السحب نفسه — تسرّبِ واجهة البوابة إلى المتن، أو رقمٍ مكرّر، أو نصٍّ مشبوه
-- الاقتطاع. عرضُ نصٍّ معطوب ليس كسراً للصمت.
--
-- فالتفريق محفوظٌ في عمود يُحسب عند الاستيراد لا في شرطٍ يُعاد حسابه مع كل
-- استعلام: شرط الديباجة `LIKE` على النصّ المطبَّع، ووضعُه في بوابة الاسترجاع
-- يجعل كلّ بحثٍ يمسحه.
ALTER TABLE legal_chunks ADD COLUMN has_defect INTEGER NOT NULL DEFAULT 0;

-- سبب العطب كما حُسب — للطابور وللشرح، لا لقرار الحجب (ذاك على `has_defect`).
ALTER TABLE legal_chunks ADD COLUMN defect_kind TEXT;

CREATE INDEX IF NOT EXISTS idx_legal_retrieval ON legal_chunks(retrieval_status, has_defect);

-- الباب مطبَّعاً — ليُرشَّح به البحث. المطابقة على النصّ الخام تجعل «الباب
-- الثالث» و«الباب الثّالث» بابين، وهما واحد.
ALTER TABLE legal_chunks ADD COLUMN book_norm TEXT;
CREATE INDEX IF NOT EXISTS idx_legal_book ON legal_chunks(law_id, book_norm);

-- ── أثر الدفعة ──
-- سجلّ الدفعات يقول ما فعلت: مضاف · محدَّث · محذوف. والمحذوف كان غائباً لأن
-- الاستيراد لم يكن يحذف شيئاً.
ALTER TABLE legal_imports ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;

-- بصمة الملف: تُطابَق ببصمة المُرسِل ليُعلم أن ما وصل هو ما أُرسل.
ALTER TABLE legal_imports ADD COLUMN file_sha256 TEXT;

-- معرّف الدفعة: الملف يُرفع على أجزاء، فتُجمع أجزاؤه بهذا ليُعرف عند الختام
-- ما ورد فيها كلِّها — وعليه وحده يقع حذف اليتيم.
ALTER TABLE legal_imports ADD COLUMN batch_id TEXT;
CREATE INDEX IF NOT EXISTS idx_imports_batch ON legal_imports(batch_id);

-- ── معرّفات الدفعة ──
-- ما ورد في الدفعة من معرّفات، جزءاً بعد جزء. تُقرأ في الخطوة الختامية
-- لتُقابَل بما في القاعدة لكل نظام، فيُعرف الزائد.
--
-- وتبقى بعد الختام لا تُمحى: هي ما يُثبت أنّ الحذف وقع على ما غاب عن دفعةٍ
-- تامّة لا على ما سقط من جزءٍ انقطع.
CREATE TABLE IF NOT EXISTS legal_batch_ids (
  batch_id   TEXT NOT NULL,
  chunk_id   TEXT NOT NULL,
  law_id     TEXT,
  at         INTEGER NOT NULL,
  PRIMARY KEY (batch_id, chunk_id)
);
CREATE INDEX IF NOT EXISTS idx_batch_law ON legal_batch_ids(batch_id, law_id);
