-- إضافات: اعتماد المسودّات · المواعيد النظامية · الإشعارات · بنك البنود

-- اعتماد المسودّة من محامٍ (بوّابة ما قبل التصدير)
CREATE TABLE IF NOT EXISTS message_approvals (
  message_id  TEXT PRIMARY KEY,
  approved_by TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  note        TEXT
);

-- المواعيد النظامية المرتبطة بالقضايا/المحادثات
CREATE TABLE IF NOT EXISTS deadlines (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  conversation_id TEXT,
  folder_id       TEXT,
  title           TEXT NOT NULL,
  kind            TEXT,                 -- اعتراض · استئناف · جلسة · تسليم مذكرة · أخرى
  base_date       TEXT,                 -- تاريخ التبليغ/الأساس (كما أدخله المستخدم)
  due_date        TEXT NOT NULL,        -- YYYY-MM-DD ميلادي
  due_hijri       TEXT,                 -- المكافئ الهجري (أم القرى)
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  notified_at     INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deadlines_user ON deadlines(user_id, status, due_date);

-- إشعارات داخل المنصّة
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,             -- deadline · review · tracking · system
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  read_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at DESC);

-- بنك البنود المعتمدة لدى المكتب
CREATE TABLE IF NOT EXISTS clauses (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  category   TEXT,
  body       TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_clauses_category ON clauses(category);
