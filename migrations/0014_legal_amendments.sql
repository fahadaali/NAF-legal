-- حقول التعديل والبنية والتكرار — الإصدار الثاني من مواصفة الاستيراد.
--
-- بوابة هيئة الخبراء تعرض **متن المادة الأصلي** وتضع تعديلاته في نافذة
-- منفصلة. والاستيراد السابق لم يكن يقرأ تلك النافذة، فكان يُدخل قاعدة المعرفة
-- نصّاً منسوخاً على أنه الجاري — وهو أخطر خطأ في منتج قانوني، لأنه لا يظهر
-- إلا كإجابةٍ تستشهد بنصٍّ صحيح الشكل باطل المضمون.
--
-- والملف الجديد يقرأ النافذة ويقول عن كل مادة: أعُدِّلت؟ وبأيّ أداة؟ وهل
-- طُبِّق التعديل على النصّ أم بقي النصّ أصلياً؟ وهل تحتاج المادة مراجعةً
-- بشرية قبل أن تدخل الاسترجاع؟
--
-- **ولماذا أعمدةٌ لا `meta_json`؟** لأن التصفية عليها تقع في SQL داخل طبقة
-- الاسترجاع — `is_repealed` استبعاداً تامّاً و`needs_review` حجباً مشروطاً —
-- وشرطٌ لا يُكتب في SQL يتجاوزه أوّل نداءٍ من مسار آخر: تقرير أو أتمتة أو
-- واجهة برمجية. وما بقي من حقول الملف يبقى في `meta_json` كما كان.

-- ── بنية النظام: أين تقع المادة منه ──
ALTER TABLE legal_chunks ADD COLUMN book TEXT;            -- الباب
ALTER TABLE legal_chunks ADD COLUMN chapter TEXT;         -- الفصل
ALTER TABLE legal_chunks ADD COLUMN section TEXT;         -- عنوان حرّ
ALTER TABLE legal_chunks ADD COLUMN article_label TEXT;   -- «المادة الخامسة والأربعون»
ALTER TABLE legal_chunks ADD COLUMN article_title TEXT;   -- «التعريفات»

-- ── أداة الإصدار والجهة والسحب ──
ALTER TABLE legal_chunks ADD COLUMN instrument TEXT;      -- نوع الأداة: مرسوم ملكي…
ALTER TABLE legal_chunks ADD COLUMN authority TEXT;       -- الجهة صاحبة النظام
ALTER TABLE legal_chunks ADD COLUMN captured_at TEXT;     -- وقت السحب من المصدر، كما ورد

-- ── المادة الطويلة المقسّمة ──
-- `#a` و`#b` أجزاءُ مادةٍ واحدة لا مادتان: تُعرض متتابعة، ويتكرّر السياق في
-- `embed_text` لكل جزء فيُسترجع الجزء بمعناه لا مبتوراً عمّا قبله.
ALTER TABLE legal_chunks ADD COLUMN part TEXT;
ALTER TABLE legal_chunks ADD COLUMN parts_total INTEGER;

-- ── النصّ السابق ──
-- ما كان قبل التعديل. للأرشيف والمقارنة لا للعرض ولا للاستشهاد، ولذلك هو
-- خارج أعمدة كل استعلام عرض — كـ`embed_text` تماماً.
ALTER TABLE legal_chunks ADD COLUMN text_superseded TEXT;

-- ── تكرار الرقم ──
-- المرسوم المعدِّل يُدخل مادةً جديدة برقم مادةٍ قائمة، فيصير في النظام موضعان
-- بالرقم نفسه ونصّاهما مختلفان. وهي **مادة مستقلّة لا نسخة معدَّلة**:
-- `duplicate_of` يجمع أخواتها، و`duplicate_index` يرتّبها بينها.
ALTER TABLE legal_chunks ADD COLUMN is_duplicate INTEGER NOT NULL DEFAULT 0 CHECK (is_duplicate IN (0,1));
ALTER TABLE legal_chunks ADD COLUMN duplicate_of TEXT;
ALTER TABLE legal_chunks ADD COLUMN duplicate_index INTEGER;

-- ── التعديل ──
ALTER TABLE legal_chunks ADD COLUMN has_amendments INTEGER NOT NULL DEFAULT 0 CHECK (has_amendments IN (0,1));
-- استبدال · إضافة · إلغاء · تعديل جزئي · تعديل جماعي · غير مصنَّف — تُخزَّن
-- كما وردت: تصنيفُ المصدر لا تصنيفُنا، وترجمتها إلى مفرداتٍ من عندنا تُفقد
-- القارئ ما قاله المرسوم.
ALTER TABLE legal_chunks ADD COLUMN amendment_kind TEXT;
-- **هل `text` نافذ؟** صفرٌ يعني أن النصّ المعروض أصليّ رغم وجود تعديل — وهو
-- الافتراض الآمن: الامتناع عند الشكّ أسلم من تطبيقٍ خاطئ يبدو صحيحاً.
ALTER TABLE legal_chunks ADD COLUMN amendment_applied INTEGER NOT NULL DEFAULT 0 CHECK (amendment_applied IN (0,1));
ALTER TABLE legal_chunks ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0,1));
ALTER TABLE legal_chunks ADD COLUMN amendment_instrument TEXT;  -- أداة التعديل: م/44
ALTER TABLE legal_chunks ADD COLUMN amended_on TEXT;            -- تاريخ التعديل الهجري كما ورد
ALTER TABLE legal_chunks ADD COLUMN effective_from_hijri TEXT;  -- نفاذٌ مؤجَّل بتاريخ هجري
ALTER TABLE legal_chunks ADD COLUMN amendments_count INTEGER;
-- النصّ الخام الكامل لنافذة التعديلات. التصنيف الآلي يقترح ولا يقرّر، فهذا
-- ما يرجع إليه المراجع البشري بلا إعادة سحب. وهو خارج أعمدة العرض كذلك.
ALTER TABLE legal_chunks ADD COLUMN amendments_raw TEXT;
ALTER TABLE legal_chunks ADD COLUMN amend_note TEXT;            -- سبب الإحالة للمراجعة

-- ── قرار المراجعة: قرارُ المنصة لا حقلٌ من الملف ──
-- المادة الموسومة `needs_review` تُحجب عن الاسترجاع الآلي حتى يعتمدها إنسان،
-- ولذلك يلزم أثرٌ للاعتماد. وهو عمودٌ هنا لا صفٌّ في جدولٍ آخر لأن التصفية
-- تقرؤه في كل استعلام بحث، والانضمام في كل استعلامٍ ثمنٌ بلا مقابل.
--
-- ويُمحى عند تغيّر النصّ أو تغيّر نافذة التعديلات: اعتمادُ نصٍّ لم يعد هو
-- النصّ ليس اعتماداً.
ALTER TABLE legal_chunks ADD COLUMN reviewed_at INTEGER;
ALTER TABLE legal_chunks ADD COLUMN reviewed_by TEXT;

CREATE INDEX IF NOT EXISTS idx_legal_review    ON legal_chunks(needs_review, reviewed_at);
CREATE INDEX IF NOT EXISTS idx_legal_duplicate ON legal_chunks(duplicate_of, duplicate_index);
CREATE INDEX IF NOT EXISTS idx_legal_amend     ON legal_chunks(has_amendments, amendment_applied);

-- ── سجلّ التحديث: متى وقع التعديل، لا متى استوردناه ──
-- المواد المعنية عُدِّلت قبل سنوات بمراسيم صدرت في تواريخها ولم نكن نلتقطها.
-- فتاريخ السجلّ يؤخذ من `amended_on` ويُنسَب التغيير إلى أداته، وإلا أظهر
-- السجلّ أن نظام العمل عُدِّل هذا العام وهو عُدِّل بالمرسوم م/44 لعام 1446هـ.
ALTER TABLE legal_chunk_versions ADD COLUMN amended_on TEXT;
ALTER TABLE legal_chunk_versions ADD COLUMN amendment_instrument TEXT;
-- `amendment` تعديلٌ نظاميّ وقع بمرسوم · `correction` تصحيحُ خطأٍ في سحبٍ سابق.
ALTER TABLE legal_chunk_versions ADD COLUMN change_kind TEXT;
-- `displaced` نصٌّ أزاحه استيراد · `superseded` نصٌّ سابق وصل في الملف نفسه.
ALTER TABLE legal_chunk_versions ADD COLUMN origin TEXT;
-- بصمة النصّ المؤرشف — بها لا يتكرّر السطر نفسه عند إعادة رفع الملف.
ALTER TABLE legal_chunk_versions ADD COLUMN text_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_legal_versions_hash ON legal_chunk_versions(chunk_id, text_hash);

-- ── وسم الدفعة ──
-- `correction` يميّز استيراد تصحيح البيانات عن التعديل النظامي الحقيقي.
ALTER TABLE legal_imports ADD COLUMN kind TEXT;
