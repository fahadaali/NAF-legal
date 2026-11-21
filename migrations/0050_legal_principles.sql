-- طبقة المبادئ القضائية — جدولٌ مستقلّ عن `legal_chunks`.
--
-- المبدأ القضائي سابقةٌ لا نصٌّ ملزم: يُعرض في قسمٍ وحده بعد الموادّ، ولا يدخل
-- ترتيبها ولا عدّها ولا تصفيتها (IMPORT-RUNBOOK §3-١٤ و§5-٩). ولو سكن جدول
-- الموادّ لمرّ بكل استعلامٍ فيه — وهي أكثر من مئة موضع — ولزم كلَّ موضعٍ شرطٌ
-- يُخرجه، وأوّلُ موضعٍ يُغفله يعرض مبدأً بين الموادّ. فالفصل في الجدول لا في الشرط.
--
-- والحال بأربع قيم كما يكتبها المصدر، لا بقيم الموادّ الثلاث: «أساسه معدَّل»
-- و«أساسه ملغى» لا تحجبان المبدأ — هو تاريخٌ قضائيّ يحتاجه الباحث — وإنما
-- تُوجبان تحذيره.

CREATE TABLE IF NOT EXISTS legal_principles (
  -- مفتاحٌ عدديّ لربط الفهرس اللفظي (FTS5 يفهرس على rowid عدديّ) — صريحٌ لا ضمنيّ
  -- لأن الضمنيّ يتغيّر مع VACUUM فينقطع الفهرس عن صاحبه بلا صوت.
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL UNIQUE,           -- «مدونة-المبادئ-العمالية-1431/art-0012»

  -- ── المدوّنة ──
  collection_id     TEXT NOT NULL,                  -- law_id في الملف: المدوّنة بإصدارها
  collection_title  TEXT NOT NULL,                  -- law_name: «مدونة المبادئ العمالية لعام 1431هـ»
  edition           TEXT,                           -- source_version: «1431»
  authority         TEXT,
  parent_law_id     TEXT,                           -- النظام الذي تتبعه المدوّنة: «نظام-العمل»

  -- ── المبدأ ──
  principle_no      INTEGER NOT NULL,               -- article_no: تسلسليٌّ ثابت
  principle_label   TEXT NOT NULL,                  -- article_label: «المبدأ 12»
  book              TEXT,
  chapter           TEXT,
  section           TEXT,
  text              TEXT NOT NULL,                  -- يُعرض ويُستشهد به

  -- ── القرار ──
  decision_no       TEXT,                           -- كما طُبع: «431/2/104»
  decision_date_h   TEXT,                           -- «1431/2/23»
  ref_json          TEXT,                           -- موضعه في مجلدات القرارات {volume, page}
  similar_json      TEXT,                           -- القرارات المشابهة
  related_json      TEXT,                           -- الموادّ التي بُني عليها، بحالها

  -- ── الحال ──
  retrieval_status  TEXT NOT NULL CHECK (retrieval_status IN ('نافذ','نافذ_بتحذير','أساسه معدَّل','أساسه ملغى')),
  retrieval_warning TEXT,

  -- ── المصدر ──
  source_url        TEXT,
  source_pages      TEXT,                           -- «85» أو «85-86»
  source_sha256     TEXT,
  review            TEXT,                           -- «معتمد» — لا يُرفع إصدارٌ لم يُعتمد

  -- مشتقّان للبحث اللفظي — تطبيعٌ عربيّ لا يُعرض.
  text_norm         TEXT NOT NULL,
  handle_norm       TEXT,                           -- المدوّنة ورقم المبدأ ورقم القرار

  import_id         TEXT NOT NULL,
  imported_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_principles_collection ON legal_principles(collection_id, principle_no);
CREATE INDEX IF NOT EXISTS idx_principles_parent     ON legal_principles(parent_law_id);
CREATE INDEX IF NOT EXISTS idx_principles_decision   ON legal_principles(decision_no);

-- ── الفهرس اللفظي ──
-- محتواه خارجيّ (`content=`) فلا يُخزَّن النصّ مرّتين، والمحفّزات تُبقيه مطابقاً.
CREATE VIRTUAL TABLE IF NOT EXISTS legal_principles_fts USING fts5(
  text_norm,
  handle_norm,
  content='legal_principles',
  content_rowid='seq'
);

CREATE TRIGGER IF NOT EXISTS legal_principles_ai AFTER INSERT ON legal_principles BEGIN
  INSERT INTO legal_principles_fts(rowid, text_norm, handle_norm) VALUES (new.seq, new.text_norm, new.handle_norm);
END;

CREATE TRIGGER IF NOT EXISTS legal_principles_ad AFTER DELETE ON legal_principles BEGIN
  INSERT INTO legal_principles_fts(legal_principles_fts, rowid, text_norm, handle_norm)
    VALUES ('delete', old.seq, old.text_norm, old.handle_norm);
END;

CREATE TRIGGER IF NOT EXISTS legal_principles_au AFTER UPDATE ON legal_principles BEGIN
  INSERT INTO legal_principles_fts(legal_principles_fts, rowid, text_norm, handle_norm)
    VALUES ('delete', old.seq, old.text_norm, old.handle_norm);
  INSERT INTO legal_principles_fts(rowid, text_norm, handle_norm) VALUES (new.seq, new.text_norm, new.handle_norm);
END;

-- ── الجمع قبل الكتابة ──
-- الملف يُكتب كاملاً أو لا يُكتب (عقد الاستيراد §١): تُجمع أجزاؤه هنا، ثم يُستبدل
-- ما للمدوّنات نفسها في عبارةٍ واحدة. فانقطاعٌ في منتصف الرفع لا يترك مدوّنةً
-- نصفُها جديد ونصفُها قديم.
CREATE TABLE IF NOT EXISTS legal_principles_staging (
  import_id   TEXT NOT NULL,
  line_no     INTEGER NOT NULL,
  row_json    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (import_id, line_no)
);
