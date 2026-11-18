-- الفحص الشهري لمصادر الأنظمة المستوردة.
--
-- مشروع الاستيراد (nezam) يفحص كل شهر صفحاتِ الأنظمة في مصادرها الرسمية
-- (`src/check-updates.js`) ويكتب تقريراً: تعديلٌ صدر ولم يُستورد، ونظامٌ صار
-- لاغياً، ونظامٌ جديد، ولائحةٌ نشرت جهتها نسخةً أخرى. وكانت المنصة لا تعلم
-- بشيءٍ منه حتى يُعاد السحب والاستيراد — فتعرض نصّاً عُدِّل في مصدره على أنه
-- النافذ. وأوّل ما رُصد: المادة ٣٥ من نظام القضاء، عُدِّلت بالمرسوم م/100
-- وتاريخ 1448/4/3هـ والمنصة تعرضها بصيغتها بعد م/141 لعام 1441.
--
-- ثلاثة جداول:
--   legal_update_checks    التقارير كما رُفعت — مرّةً لكل ملف (بصمته)
--   legal_update_findings  البنود: ما رُصد لنظام، مفتوحاً حتى يُستورد أو يُستبعد
--   legal_pending_updates  ما يُنبَّه به القارئ: سطرٌ لكل مادة (أو للنظام كلّه)
--                          ما دام بندُه مفتوحاً — يقرؤه `HIT_COLUMNS` في كل استرجاع
--
-- الهجرات للأمام فقط: ملفٌّ جديد، ولم تُعدَّل هجرةٌ سابقة.

CREATE TABLE IF NOT EXISTS legal_update_checks (
  id            TEXT PRIMARY KEY,
  run           TEXT NOT NULL,                 -- يوم الفحص YYYY-MM-DD
  mode          TEXT NOT NULL CHECK (mode IN ('full', 'quick')),
  version       INTEGER NOT NULL,
  filename      TEXT,
  file_sha256   TEXT NOT NULL,
  summary_json  TEXT NOT NULL,
  report_json   TEXT NOT NULL,                 -- التقرير كاملاً كما رُفع
  added         INTEGER NOT NULL DEFAULT 0,
  updated       INTEGER NOT NULL DEFAULT 0,
  resolved      INTEGER NOT NULL DEFAULT 0,    -- ما أُغلق لأنه لم يعد يُرصد
  actor_id      TEXT,
  created_at    INTEGER NOT NULL
);
-- الملف نفسه يُرفع مرّتين فيُقال إنه رُفع، ولا يُكتب مرّتين.
CREATE UNIQUE INDEX IF NOT EXISTS idx_update_checks_sha ON legal_update_checks(file_sha256);
CREATE INDEX IF NOT EXISTS idx_update_checks_run ON legal_update_checks(run DESC);

CREATE TABLE IF NOT EXISTS legal_update_findings (
  id             TEXT PRIMARY KEY,
  law_id         TEXT NOT NULL,                -- معرّف النظام في القاعدة؛ ونظامٌ ليس فيها `boe:<GUID>`
  law_title      TEXT,
  kind           TEXT NOT NULL,                -- amendment · status · instrument · dates · count · text · brief ·
                                               -- missing · new_law · version · replacement · external
  level          INTEGER NOT NULL CHECK (level IN (1, 2, 3)),
  detail         TEXT NOT NULL,
  signature      TEXT NOT NULL,                -- بصمة ما رُصد: يُعرف بها البند المستبعَد إن عاد
  data_json      TEXT,                         -- مقتطفات · نوافذ · طرفا الحالة · التنبيهات
  state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved', 'dismissed')),
  first_check_id TEXT NOT NULL,
  last_check_id  TEXT NOT NULL,
  first_run      TEXT NOT NULL,
  last_run       TEXT NOT NULL,
  resolved_how   TEXT CHECK (resolved_how IS NULL OR resolved_how IN ('imported', 'gone')),
  resolved_batch TEXT,                         -- الدفعة التي أغلقته — ويُعاد فتحه إن رُدّت
  resolved_by    TEXT,
  resolved_at    INTEGER,
  dismiss_note   TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
-- بندٌ مفتوح واحد لكل نظامٍ ونوع: التقرير التالي يحدّثه ولا يضاعفه.
CREATE UNIQUE INDEX IF NOT EXISTS idx_update_findings_open
  ON legal_update_findings(law_id, kind) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS idx_update_findings_law ON legal_update_findings(law_id, state);
CREATE INDEX IF NOT EXISTS idx_update_findings_batch ON legal_update_findings(resolved_batch);

CREATE TABLE IF NOT EXISTS legal_pending_updates (
  finding_id      TEXT NOT NULL,
  law_id          TEXT NOT NULL,
  -- رقم المادة مطبَّعاً كـ`legal_chunks.article_no_norm`، و'' للنظام كلّه.
  -- لا NULL: المفتاح المركّب يقبل NULL مكرَّراً فيتضاعف السطر.
  article_no_norm TEXT NOT NULL DEFAULT '',
  notice          TEXT NOT NULL,
  detected_run    TEXT NOT NULL,
  PRIMARY KEY (finding_id, article_no_norm)
);
CREATE INDEX IF NOT EXISTS idx_pending_updates_law ON legal_pending_updates(law_id, article_no_norm);
