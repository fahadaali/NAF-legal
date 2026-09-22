-- سجلّ المصادر الخارجية — خوادم MCP تُقرأ منها الكتب
--
-- المنصة تسترجع اليوم من مصدرين محلّيين: مواد الأنظمة المستورَدة
-- (`legal_chunks`) والوثائق المرفوعة (`kb_documents`)، وكلاهما مكتوبٌ باليد
-- في `lib/rag.ts`. وهذا الجدول يجعل المصدر **صفّاً يُضاف** لا فرعاً يُكتب:
-- خادمٌ قانونيّ جديد بعد سنة يدخل من لوحة الإدارة، لا من محرِّر نصوص.
--
-- **والرمز لا يدخل هنا.** الصفّ يحمل `token_key` — اسمَ المفتاح داخل السرّ
-- `MCP_TOKENS` — لا القيمة. فمن قرأ نسخةً من القاعدة لم يقرأ رمز وصول، وتبديلُ
-- الرمز لا يمسّ صفّاً.

CREATE TABLE IF NOT EXISTS external_sources (
  id            TEXT PRIMARY KEY,          -- معرّف ثابت: turath · shamela · …
  label         TEXT NOT NULL,             -- اسم العرض، من naf-terms.md
  kind          TEXT NOT NULL DEFAULT 'mcp' CHECK (kind IN ('mcp')),
  endpoint      TEXT,                      -- عنوان MCP — فارغٌ حتى يُضبط
  -- الدور يحكم **أين يقع المقطع في البرومبت**، وهو أخطر حقلٍ هنا:
  --   fiqh  → كتلة <تدعيم_فقهي>: تأصيلٌ لا إسناد، في قسمٍ ختاميّ وحده
  --   legal → كتلة <سياق_نظامي>: يُستشهد به كما يُستشهد بمادة
  -- ومصدرٌ فقهيّ وُسم `legal` يُدخل كلام الفقهاء في متن مذكرةٍ تُرفع بوصفه
  -- سنداً نظامياً. فالافتراض `fiqh`، و`legal` قرارٌ يُتّخذ لا يُنسى.
  role          TEXT NOT NULL DEFAULT 'fiqh' CHECK (role IN ('fiqh', 'legal')),
  enabled       INTEGER NOT NULL DEFAULT 0,
  search_tool   TEXT NOT NULL,             -- اسم أداة MCP التي تُنادى للبحث
  -- معاملاتٌ ثابتة تُدمج مع الاستعلام عند كل نداء (JSON). بها يُضيَّق نطاق
  -- خادمٍ واسع — مذهبٌ بعينه، أو تصنيفٌ بعينه — بلا كود.
  args_json     TEXT NOT NULL DEFAULT '{}',
  -- اسم الحقل الذي يُوضع فيه نصُّ الاستعلام: `q` في تراث، `query` في الشاملة.
  query_field   TEXT NOT NULL DEFAULT 'q',
  -- واسمُ حقل السقف إن كان للأداة سقف. و**لا يُفترض**: `shamela_search_phrase`
  -- تقبل `limit`، و`search_turath` لا تعرفها أصلاً (معاملاتُها: q وpage
  -- وbook_id وauthor_id وcat_id). ومعاملٌ لا تعرفه الأداة يُتجاهل في خادمٍ
  -- متساهل ويُرفض الطلبُ كلُّه في خادمٍ يضبط `additionalProperties: false`.
  -- فالفارغ يعني: لا تُرسل سقفاً، وحُدّ النتائج عندنا بعد وصولها.
  limit_field   TEXT,
  max_results   INTEGER NOT NULL DEFAULT 8,
  timeout_ms    INTEGER NOT NULL DEFAULT 12000,
  -- المفتاح في MCP_TOKENS، لا الرمز. وفارغٌ بالافتراض: الخادم العامّ لا يطلب
  -- رمزاً، ومفتاحٌ مضبوطٌ بلا سرٍّ يقابله يردّ «رمز المصدر غير مضبوط» —
  -- فيُمنع مصدرٌ سليم لأجل إعدادٍ لم يُطلب.
  token_key     TEXT,
  -- آخر فحصٍ ونتيجته — يملؤهما زرُّ الفحص في لوحة الإدارة، فيُقرأ سببُ
  -- التعذّر في الشاشة بدل أن يُبحث عنه في السجلّات.
  last_checked  INTEGER,
  last_status   TEXT,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_external_sources_enabled ON external_sources(enabled, role);

-- الصفّان مبدئيّان: معطَّلان وبلا عنوان. الشكل مأخوذ من فحصِ الخادمين حيّين،
-- فأسماء الأدوات وحقولها صحيحة لا مُخمَّنة — ويبقى العنوان وحده، ويُضبط من
-- لوحة الإدارة لا من هنا: الجدول بابُه الشاشة.
INSERT OR IGNORE INTO external_sources
  (id, label, kind, endpoint, role, enabled, search_tool, args_json, query_field, limit_field, max_results, timeout_ms, token_key, created_at, updated_at)
VALUES
  ('turath',  'تراث',            'mcp', NULL, 'fiqh', 0, 'search_turath',
   '{}', 'q', NULL, 8, 12000, NULL, unixepoch() * 1000, unixepoch() * 1000),
  ('shamela', 'المكتبة الشاملة', 'mcp', NULL, 'fiqh', 0, 'shamela_search_phrase',
   '{"mode":"near","distance":5,"response_format":"json"}', 'query', 'limit', 8, 15000, NULL, unixepoch() * 1000, unixepoch() * 1000);
