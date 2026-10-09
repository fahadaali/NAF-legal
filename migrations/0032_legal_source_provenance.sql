-- الإصدار الثامن من وثيقة الاستيراد: مصدرُ السجل — اللوائح من خارج البوابة (§3-13).
--
-- لوائح تنفيذية لا تنشرها بوابة هيئة الخبراء، مصدرها موقع الجهة أو الجريدة
-- الرسمية: صفحةٌ نصية، أو ملفٌّ بطبقة نص، أو ملفٌّ ممسوح. وما جاء من ملفٍّ
-- يُستشهد بصفحته ونسخة الجهة: «المادة 12، ص 14، نسخة 2025-04» (§6-4).
--
-- **ولماذا أعمدةٌ لا `meta_json`؟** للسبب نفسه في `0028`: الصفحة والنسخة
-- تدخلان سطرَ الاستشهاد في سياق المساعد، وتُعرضان بجوار النص. وحقلٌ يُقرأ في
-- كل نتيجة لا يُستخرج من نصٍّ مخزَّن في كل قراءة.

-- صفحة · ملف-نصي · مسح-ضوئي. غائبٌ في سجلات البوابة.
ALTER TABLE legal_chunks ADD COLUMN source_kind TEXT;
-- `[من, إلى]` نصّاً — صفحاتُ السجل في ملف الجهة. يُستشهد بها.
ALTER TABLE legal_chunks ADD COLUMN source_pages TEXT;
-- نسخةُ الجهة كما في ملفها: «2025-04» · «الإصدار الرابع 2022م». تُعرض بجوار النص.
ALTER TABLE legal_chunks ADD COLUMN source_version TEXT;
-- بصمةُ ملف الجهة — للتدقيق.
ALTER TABLE legal_chunks ADD COLUMN source_sha256 TEXT;
-- أدنى ثقة سطرٍ كما أعطاها محرّك التعرّف — **للتدقيق وحده**: لا يُبنى عليه
-- عرضٌ ولا حجبٌ ولا تحذير. قيمُ المحرّك خشنة، والسطر الضعيف لم يدخل إلا بعد
-- أن قوبل بالأصل.
ALTER TABLE legal_chunks ADD COLUMN ocr_confidence REAL;

-- ما وصل قبل هذه الهجرة حُفظ في `meta_json` لأن العقد لم يعرفه: يُنقل إلى
-- أعمدته ويُرفع من هناك، فلا يبقى للحقل مصدران. والصفحاتُ تُنقل حين تكون
-- مصفوفةً من عددين وحدها — ما خالفها يُترك لإعادة الرفع التي تفحصه.
UPDATE legal_chunks SET
  source_kind = json_extract(meta_json, '$.source_kind'),
  source_pages = CASE WHEN json_type(meta_json, '$.source_pages') = 'array'
                       AND json_array_length(meta_json, '$.source_pages') = 2
                       AND json_type(meta_json, '$.source_pages[0]') = 'integer'
                       AND json_type(meta_json, '$.source_pages[1]') = 'integer'
                      THEN json_extract(meta_json, '$.source_pages') END,
  source_version = CAST(json_extract(meta_json, '$.source_version') AS TEXT),
  source_sha256 = json_extract(meta_json, '$.source_sha256'),
  ocr_confidence = CASE WHEN json_type(meta_json, '$.ocr_confidence') IN ('integer', 'real')
                        THEN json_extract(meta_json, '$.ocr_confidence') END,
  meta_json = NULLIF(
    json_remove(meta_json, '$.source_kind', '$.source_pages', '$.source_version', '$.source_sha256', '$.ocr_confidence'),
    '{}'
  )
WHERE meta_json IS NOT NULL AND json_valid(meta_json)
  AND (json_type(meta_json, '$.source_kind') IS NOT NULL
       OR json_type(meta_json, '$.source_pages') IS NOT NULL
       OR json_type(meta_json, '$.source_version') IS NOT NULL
       OR json_type(meta_json, '$.source_sha256') IS NOT NULL
       OR json_type(meta_json, '$.ocr_confidence') IS NOT NULL);
