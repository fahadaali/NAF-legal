-- طلبات إضافة نظام غير موجود في قاعدة المعرفة
-- يرفعها المستخدم من داخل المحادثة (حين يتبيّن أن نظامًا مطلوبًا للإسناد غير
-- موجود) أو من صفحة الدعم، وتظهر لمسؤول النظام في لوحة الإدارة.

CREATE TABLE IF NOT EXISTS regulation_requests (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  conversation_id TEXT,                    -- المحادثة التي نشأ منها الطلب إن وُجدت
  name            TEXT NOT NULL,           -- اسم النظام (الحقل الوحيد الإلزامي)
  url             TEXT,                    -- رابط النظام — اختياري
  has_bylaw       INTEGER NOT NULL DEFAULT 0,  -- هل له لائحة تنفيذية
  bylaw_url       TEXT,                    -- رابط اللائحة — اختياري
  note            TEXT,                    -- ملاحظة المستخدم — اختيارية
  source          TEXT NOT NULL DEFAULT 'support' CHECK (source IN ('chat', 'support')),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_note      TEXT,                    -- ملاحظة مسؤول النظام عند البتّ
  handled_by      TEXT,
  handled_at      INTEGER,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_regulation_requests_status ON regulation_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_regulation_requests_user ON regulation_requests(user_id, created_at DESC);
