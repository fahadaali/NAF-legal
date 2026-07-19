-- بذور اختيارية: قائمة الأنظمة الأولية المقترَحة لقاعدة المعرفة (§14.5)
-- هذه صفوف مرجعية (بلا محتوى مُضمَّن). يرفع المسؤول ملف كل نظام من لوحة الإدارة
-- ليُستخرج نصّه ويُضمَّن (ingest_status ينتقل من pending إلى ready).
-- التشغيل: npm run seed

INSERT OR IGNORE INTO kb_documents
  (id, title, source_authority, category, status, version, needs_update, ingest_status, created_at)
VALUES
  ('seed-marafaat',  'نظام المرافعات الشرعية',              'هيئة الخبراء بمجلس الوزراء', 'مرافعات',       'active', 1, 0, 'pending', strftime('%s','now')*1000),
  ('seed-madaniya',  'نظام المعاملات المدنية',             'هيئة الخبراء بمجلس الوزراء', 'معاملات مدنية', 'active', 1, 0, 'pending', strftime('%s','now')*1000),
  ('seed-amal',      'نظام العمل',                         'وزارة الموارد البشرية',      'عمل',           'active', 1, 0, 'pending', strftime('%s','now')*1000),
  ('seed-sharikat',  'نظام الشركات',                       'وزارة التجارة',              'شركات',         'active', 1, 0, 'pending', strftime('%s','now')*1000),
  ('seed-ithbat',    'نظام الإثبات',                       'هيئة الخبراء بمجلس الوزراء', 'إثبات',         'active', 1, 0, 'pending', strftime('%s','now')*1000),
  ('seed-jamiyat',   'نظام الجمعيات والمؤسسات الأهلية',    'وزارة الموارد البشرية',      'جمعيات',        'active', 1, 0, 'pending', strftime('%s','now')*1000);
