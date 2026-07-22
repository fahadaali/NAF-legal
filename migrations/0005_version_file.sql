-- ربط ملف الأصل (PDF/DOCX) بكل إصدار لتمكين الاطلاع على الملف لكل نسخة
ALTER TABLE kb_document_versions ADD COLUMN file_r2_key TEXT;
