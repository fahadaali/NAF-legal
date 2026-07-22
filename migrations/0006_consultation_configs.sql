-- إعدادات نماذج الاستشارات القابلة للتحكّم من لوحة الإدارة:
-- البرومبت، طلب الملف واسمه، والحقول المخصّصة وأنواعها.
CREATE TABLE IF NOT EXISTS consultation_configs (
  key        TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  updated_at INTEGER
);
