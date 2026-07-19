-- إضافات المنصّة: مراجعة المستندات، القوالب، التقييم، القضايا، المشاركة،
-- التحليلات، إصدارات الأنظمة، خلاصات الأخبار.

-- ── مجموعات القضايا والوسوم (§3 إنتاجية) ──
CREATE TABLE IF NOT EXISTS case_folders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  color      TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_folders_user ON case_folders(user_id);

ALTER TABLE conversations ADD COLUMN folder_id TEXT;
ALTER TABLE conversations ADD COLUMN tags_json TEXT;

-- ── تقييم الردود (§2 موثوقية) ──
CREATE TABLE IF NOT EXISTS message_feedback (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  rating     INTEGER NOT NULL,            -- 1 = 👍 ، -1 = 👎
  comment    TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (message_id, user_id)
);

-- ── مشاركة المسودّة للمراجعة (§3) ──
CREATE TABLE IF NOT EXISTS shares (
  id             TEXT PRIMARY KEY,
  message_id     TEXT NOT NULL,
  owner_id       TEXT NOT NULL,
  token          TEXT NOT NULL UNIQUE,
  reviewer_label TEXT,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','changes_requested')),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares(owner_id);

CREATE TABLE IF NOT EXISTS share_comments (
  id         TEXT PRIMARY KEY,
  share_id   TEXT NOT NULL,
  author     TEXT NOT NULL,               -- اسم المراجِع أو "المالك"
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
);

-- سجل نُسخ المسودّة (§3) — يُلتقط عند كل تصدير/تعديل معتمد
CREATE TABLE IF NOT EXISTS draft_versions (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  version    INTEGER NOT NULL,
  content    TEXT NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_msg ON draft_versions(message_id, version);

-- ── تحليلات الاستخدام والتكلفة (§4) ──
CREATE TABLE IF NOT EXISTS usage_events (
  id            TEXT PRIMARY KEY,
  user_id       TEXT,
  kind          TEXT NOT NULL,            -- planner | generation | verify | classify | extract | transcribe | tracking
  model         TEXT,
  input_tokens  INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd      REAL DEFAULT 0,
  consultation_type TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at DESC);

-- ── إعدادات المنصّة (رأسية الشركة، اسمها…) (§2 قوالب) ──
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER
);

-- ── إصدارات الأنظمة (§5) ──
CREATE TABLE IF NOT EXISTS kb_document_versions (
  id             TEXT PRIMARY KEY,
  kb_document_id TEXT NOT NULL,
  version        INTEGER NOT NULL,
  text_r2_key    TEXT,
  effective_from TEXT,                    -- تاريخ سريان النسخة
  effective_to   TEXT,                    -- تاريخ انتهاء السريان (null = سارية)
  note           TEXT,
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (kb_document_id) REFERENCES kb_documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_kbver_doc ON kb_document_versions(kb_document_id, version DESC);

-- مصدر رسمي مقترَح للتتبّع/الاستيعاب التلقائي (§5)
ALTER TABLE regulation_tracking ADD COLUMN source_url TEXT;
ALTER TABLE regulation_tracking ADD COLUMN suggested_title TEXT;

-- خلاصة أخبار جريدة أم القرى (§5)
CREATE TABLE IF NOT EXISTS news_digest (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  summary    TEXT,
  url        TEXT,
  published  TEXT,
  kind       TEXT,                        -- new_regulation | amendment | other
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_news_created ON news_digest(created_at DESC);
