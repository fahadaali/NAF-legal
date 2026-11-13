-- خادم MCP: تفويضُ أدوات الذكاء الاصطناعي، وضيوفُ الربط، ومصدرُ المحادثة.
--
-- المنصة خادمُ تفويضٍ (OAuth 2.1) لنفسها: تسجّل الأداةُ نفسها، ويدخل العضو من
-- المركز أو الضيف برمز التحقق، ثم تُصدر المنصة رمزاً تحمله الأداة إلى `/mcp`.
-- والرموز كلُّها مجزّأة (SHA-256): القاعدة لا تحمل رمزاً يصلح لو تسرّبت.
--
-- الهجرات للأمام فقط: ملفٌّ جديد، ولم تُعدَّل هجرةٌ سابقة.

-- الأدوات المسجّلة تسجيلاً ديناميكياً (RFC 7591). عامّةٌ بلا سرّ: الحارس PKCE.
CREATE TABLE IF NOT EXISTS mcp_clients (
  id            TEXT PRIMARY KEY,
  client_name   TEXT,
  -- JSON: عناوين الرجوع المسموحة، تُطابَق حرفياً.
  redirect_uris TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

-- الضيوف: بريدٌ يضيفه مسؤول المنصة، لا حساب له في المركز ولا في المنصة.
CREATE TABLE IF NOT EXISTS mcp_guests (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  -- البريد بأحرف صغيرة بلا مسافات — به تُطابَق الإضافةُ ورمزُ التحقق.
  email_norm  TEXT NOT NULL UNIQUE,
  added_by    TEXT,
  created_at  INTEGER NOT NULL
);

-- طلبُ تفويضٍ معلّق: من `/oauth/authorize` إلى أن يدخل صاحبه ويسمح أو ينصرف.
CREATE TABLE IF NOT EXISTS mcp_auth_requests (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  state           TEXT,
  scope           TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);

-- رمزُ التحقق للضيف — واحدٌ لكل طلب، مجزّأ، بعدّاد محاولات.
CREATE TABLE IF NOT EXISTS mcp_guest_codes (
  request_id  TEXT PRIMARY KEY,
  guest_id    TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  -- مرّاتُ الإرسال لهذا الطلب — سقفٌ على البريد لا على الاستخدام.
  sends       INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER NOT NULL
);

-- رمز التفويض: يُبادَل مرّةً واحدة بالرموز. يُمحى عند قراءته.
CREATE TABLE IF NOT EXISTS mcp_auth_codes (
  code_hash       TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  subject_kind    TEXT NOT NULL CHECK (subject_kind IN ('member', 'guest')),
  -- `members.user_id` — `sub` القادم من المركز، لا المعرّف المحلي.
  member_id       TEXT,
  guest_id        TEXT,
  scope           TEXT,
  expires_at      INTEGER NOT NULL
);

-- الربط: أداةٌ واحدة لصاحبٍ واحد. هو ما يُعرض في الإعدادات ويُلغى.
-- لا يُحذف عند الإلغاء: يبقى بحالة «غير مربوط» ليعرف صاحبه ما كان ومتى
-- (`naf-terms.md` §١٥ — «إلغاء الربط» لا «حذف»).
CREATE TABLE IF NOT EXISTS mcp_connections (
  id             TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  client_name    TEXT,
  subject_kind   TEXT NOT NULL CHECK (subject_kind IN ('member', 'guest')),
  member_id      TEXT,
  guest_id       TEXT,
  scope          TEXT,
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER,
  -- سقفٌ مطلق: بعده يعود صاحبه فيدخل من جديد، مهما جدّدت الأداة رمزها.
  expires_at     INTEGER NOT NULL,
  revoked_at     INTEGER,
  -- owner · admin · guest_removed · refresh_reuse
  revoked_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_connections_member ON mcp_connections(member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_connections_guest ON mcp_connections(guest_id);

-- الرموز: وصولٌ قصير العمر وتجديدٌ يُدوَّر. `used_at` لرمز التجديد المستعمَل —
-- عودتُه علامةُ سرقة، فيُلغى الربط كلُّه.
CREATE TABLE IF NOT EXISTS mcp_tokens (
  token_hash     TEXT PRIMARY KEY,
  connection_id  TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  expires_at     INTEGER NOT NULL,
  used_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_connection ON mcp_tokens(connection_id);

-- مصدرُ المحادثة: فارغٌ لما بدأ في المنصة، و`mcp` لما بدأ في أداةٍ مربوطة —
-- ومعه اسمُها لعلامة «من {الأداة}». يقول أين بدأت لا من يكملها (§١٥).
ALTER TABLE conversations ADD COLUMN origin TEXT;
ALTER TABLE conversations ADD COLUMN origin_client TEXT;
