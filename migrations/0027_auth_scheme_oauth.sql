-- نوعُ مصادقةٍ ثالث: التفويض
--
-- سبرُ خادم الشاملة أثبت أنه موردٌ محميّ بـOAuth 2.1: تسجيلٌ ديناميّ، وS256،
-- ومنحتا `authorization_code` و`client_credentials`. فلا يكفيه رمزٌ ثابت ولا
-- مصادقةٌ أساسية، ويحتاج قيمةً ثالثة في `auth_scheme`.
--
-- **وإعادةُ بناء الجدول ليست اختياراً.** الهجرة 0026 كتبت
-- `CHECK (auth_scheme IN ('bearer','basic'))`، وSQLite لا تُوسّع قيد عمودٍ ولا
-- تُسقطه: لا `ALTER … DROP CONSTRAINT` فيها. والبديلُ الوحيد عن البناء هو نزعُ
-- القيد أصلاً — وذلك ينقض حجّة 0025 كلَّها في أن العمود يوثّق نفسه. فالبناء.
--
-- ولا مرجعَ خارجيّاً إلى هذا الجدول في أيّ هجرة (فُحص)، فالإسقاطُ آمن. والفهرس
-- يسقط مع الجدول فيُعاد بناؤه — ونسيانُه يجعل كلّ استعلامٍ فقهيّ مسحاً كاملاً.
--
-- **ولا عمودَ جديداً.** حالُ التفويض تُقرأ من `last_status` و`last_error`
-- القائمَين — وهما TEXT بلا قيد — فشارةُ «مربوط»/«غير مربوط» تعمل كما هي بلا
-- مفردةٍ موازية. وعمودٌ يُضاف اليوم ليقول ما يقوله عمودٌ قائم هو بدايةُ
-- مصدرَي حقيقةٍ في صفٍّ واحد.
--
-- **ولا رمزٌ ولا سرُّ عميلٍ هنا** — كما في 0025 حرفاً: الاعتمادات في KV
-- مختومةً تحت `mcpoauth:` (انظر `src/lib/sealed.ts`)، والصفُّ يحمل الإعداد
-- وحده. فمن قرأ نسخةً من القاعدة لم يقرأ مفتاحاً يعمل.

CREATE TABLE external_sources_new (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'mcp' CHECK (kind IN ('mcp')),
  endpoint      TEXT,
  role          TEXT NOT NULL DEFAULT 'fiqh' CHECK (role IN ('fiqh', 'legal')),
  enabled       INTEGER NOT NULL DEFAULT 0,
  search_tool   TEXT NOT NULL,
  args_json     TEXT NOT NULL DEFAULT '{}',
  query_field   TEXT NOT NULL DEFAULT 'q',
  limit_field   TEXT,
  max_results   INTEGER NOT NULL DEFAULT 8,
  timeout_ms    INTEGER NOT NULL DEFAULT 12000,
  token_key     TEXT,
  last_checked  INTEGER,
  last_status   TEXT,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  auth_scheme   TEXT NOT NULL DEFAULT 'bearer'
                CHECK (auth_scheme IN ('bearer', 'basic', 'oauth'))
);

-- الأعمدة تُسمّى ولا تُترك لترتيبها: `SELECT *` يربط بالموضع، وموضعٌ يتبدّل
-- يملأ عموداً بقيمة جاره صامتاً. وتراث مربوطٌ وعاملٌ الآن، فضياعُ إعداده
-- يقطع ما يعمل.
INSERT INTO external_sources_new
  (id, label, kind, endpoint, role, enabled, search_tool, args_json, query_field,
   limit_field, max_results, timeout_ms, token_key, last_checked, last_status,
   last_error, created_at, updated_at, auth_scheme)
SELECT
   id, label, kind, endpoint, role, enabled, search_tool, args_json, query_field,
   limit_field, max_results, timeout_ms, token_key, last_checked, last_status,
   last_error, created_at, updated_at, auth_scheme
FROM external_sources;

DROP TABLE external_sources;
ALTER TABLE external_sources_new RENAME TO external_sources;

CREATE INDEX IF NOT EXISTS idx_external_sources_enabled ON external_sources(enabled, role);

-- والشاملة تُنقل إلى التفويض — مثبَتاً من بياناتها لا مُخمَّناً:
--   issuer: https://shamela.link/api/auth · S256 · تسجيلٌ ديناميّ · منحةُ آلة.
-- ومصدرٌ على التفويض بلا اعتمادٍ مختوم يردّ «المصدر يطلب تفويضاً» في الشاشة،
-- لا نتائجَ صامتةً — فالنقلُ قبل الضغط على «بدء التفويض» لا يُخفي شيئاً.
-- و`token_key` يُفرَّغ: هو اسمُ مفتاحٍ في `MCP_TOKENS`، ولا معنى له هنا.
UPDATE external_sources
   SET auth_scheme = 'oauth', token_key = NULL, updated_at = unixepoch() * 1000
 WHERE id = 'shamela';
