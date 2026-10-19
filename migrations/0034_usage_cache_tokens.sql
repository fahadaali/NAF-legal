-- رموز التخزين المؤقّت في سجلّ الاستخدام.
--
-- التوليد صار يُخزّن البرومبت والسجلّ مؤقّتاً، والقراءة من المخزَّن بجزءٍ من سعر
-- المدخلات والكتابة فيه بأكثر منه. وبلا هذين العمودين تحسب لوحة التحليلات كل
-- مدخلٍ بسعرٍ واحد، فلا يظهر الوفر ولا تصحّ الكلفة.
ALTER TABLE usage_events ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_events ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
