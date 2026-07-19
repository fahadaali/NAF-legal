-- منصة مستشار ناف — مخطط قاعدة البيانات D1
-- المرجع: §9 من وثيقة المواصفات

-- المستخدمون والصلاحيات (§2)
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  name          TEXT,
  created_at    INTEGER NOT NULL
);

-- المحادثات
CREATE TABLE IF NOT EXISTS conversations (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  title             TEXT,
  consultation_type TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);

-- الرسائل
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         TEXT NOT NULL,
  metadata_json   TEXT,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at ASC);

-- المرفقات
CREATE TABLE IF NOT EXISTS attachments (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  r2_key          TEXT NOT NULL,
  filename        TEXT NOT NULL,
  mime            TEXT,
  size            INTEGER,
  parsed_text     TEXT,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversation_id);

-- قاعدة المعرفة: وثائق الأنظمة (§6)
CREATE TABLE IF NOT EXISTS kb_documents (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  source_authority TEXT,
  decree_number    TEXT,
  issue_date       TEXT,
  status           TEXT DEFAULT 'active' CHECK (status IN ('active', 'amended', 'repealed')),
  category         TEXT,
  version          INTEGER DEFAULT 1,
  r2_key           TEXT,
  last_verified    INTEGER,
  needs_update     INTEGER DEFAULT 0,
  chunk_count      INTEGER DEFAULT 0,
  ingest_status    TEXT DEFAULT 'pending' CHECK (ingest_status IN ('pending', 'processing', 'ready', 'error')),
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_category ON kb_documents(category);
CREATE INDEX IF NOT EXISTS idx_kb_needs_update ON kb_documents(needs_update);

-- تتبّع الأنظمة (§7)
CREATE TABLE IF NOT EXISTS regulation_tracking (
  id              TEXT PRIMARY KEY,
  kb_document_id  TEXT,
  last_checked    INTEGER,
  change_detected INTEGER DEFAULT 0,
  change_summary  TEXT,
  status          TEXT DEFAULT 'ok' CHECK (status IN ('ok', 'needs_review', 'new_suggested')),
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (kb_document_id) REFERENCES kb_documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tracking_status ON regulation_tracking(status);

-- ملفّات التصدير
CREATE TABLE IF NOT EXISTS exports (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  format     TEXT NOT NULL,
  r2_key     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

-- سجل التدقيق (§2)
CREATE TABLE IF NOT EXISTS audit_log (
  id           TEXT PRIMARY KEY,
  actor_id     TEXT,
  action       TEXT NOT NULL,
  target       TEXT,
  details_json TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
