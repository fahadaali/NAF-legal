-- عقد استيراد المحتوى النظامي — سطر واحد = مقطع واحد.
--
-- هذا الجدول مستقلّ عن `kb_documents`: تلك وثائق تُرفَع فيُقطّعها المُستوعِب
-- بنفسه (`chunkText`)، وهذه **مقاطع مقطوعة سلفاً** يستوردها من أعدّها بحدودها
-- الصحيحة. ولا يمسّها مُقطِّع النصّ أبداً: إعادة تقطيعها تقصّ في منتصف المواد
-- بلا وعي بحدودها، فيضيع ما بُني.
--
-- ملاحظة تشغيلية: وجود جدول افتراضي (FTS5) في القاعدة يمنع
-- `wrangler d1 export`. النسخ الاحتياطي عندئذٍ عبر Time Travel لا عبر التصدير.

CREATE TABLE IF NOT EXISTS legal_chunks (
  -- مفتاح داخليّ عدديّ، وظيفته الوحيدة ربط الفهرس اللفظي: FTS5 يفهرس على
  -- rowid عدديّ لا على نصّ. وهو صريح لا ضمنيّ لأن rowid الضمنيّ يتغيّر مع
  -- VACUUM فينقطع الفهرس عن صاحبه بلا صوت.
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,

  -- ── مفتاح العقد ──
  -- المفتاح الأساسي الفريد في العقد: عليه يقع `upsert` فتُستبدل المادة عند
  -- إعادة رفع النظام ولا تتضاعف. بلا هذا، أوّل تحديث يخلق نسخاً مكرّرة
  -- تتنافس في نتائج البحث.
  id               TEXT NOT NULL UNIQUE,

  -- ── بيانات وصفية: حصر البحث ──
  law_id           TEXT,           -- حصر البحث في نظام بعينه
  parent_law_id    TEXT,           -- للائحة: معرّف نظامها — لجلبها مع نظامه
  doc_type         TEXT,           -- حصر البحث في نوع: law | regulation | decision | circular
  article_no       TEXT,           -- كما ورد، للعرض
  article_no_norm  TEXT,           -- مطبَّع للاستدعاء والمطابقة

  -- ── بيانات وصفية: التصفية الإلزامية على السريان ──
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','amended','repealed')),
  is_repealed      INTEGER NOT NULL DEFAULT 0 CHECK (is_repealed IN (0,1)),

  -- ── بيانات وصفية: العرض والاستشهاد ──
  law_title        TEXT,
  instrument_no    TEXT,           -- رقم الأداة النظامية (مرسوم/قرار)
  issue_date       TEXT,           -- ميلادي YYYY-MM-DD
  issue_date_hijri TEXT,           -- هجري كما ورد
  effective_from   TEXT,
  effective_to     TEXT,
  source_url       TEXT,

  -- ── الحقلان بدوريهما المختلفين ──
  -- `text` يُعرض ويُستشهد به ولا يُحوَّل إلى متجه.
  text             TEXT NOT NULL,
  -- `embed_text` يُحوَّل إلى متجه ولا يُعرض ولا يُستشهد به.
  embed_text       TEXT NOT NULL,

  -- مشتقّان للبحث اللفظي: تطبيع عربي لا يُعرض ولا يُستشهد به.
  text_norm        TEXT NOT NULL,
  handle_norm      TEXT,           -- اسم النظام ورقم المادة ورقم الأداة مطبَّعة

  meta_json        TEXT,           -- ما زاد عن حقول العقد من الملف المستورد
  embed_hash       TEXT,           -- بصمة embed_text: تمنع إعادة تضمين ما لم يتغيّر
  embedded_at      INTEGER,        -- NULL = ينتظر التضمين
  imported_at      INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_legal_law       ON legal_chunks(law_id, article_no_norm);
CREATE INDEX IF NOT EXISTS idx_legal_parent    ON legal_chunks(parent_law_id);
CREATE INDEX IF NOT EXISTS idx_legal_effective ON legal_chunks(is_repealed, status);
CREATE INDEX IF NOT EXISTS idx_legal_doc_type  ON legal_chunks(doc_type);
CREATE INDEX IF NOT EXISTS idx_legal_pending   ON legal_chunks(embedded_at);

-- ── الفهرس اللفظي ──
-- يفهرس النصّ المطبَّع وحده: الدلاليّ يخذل في رقم مادة أو مصطلح حرفي، وهناك
-- يعمل هذا. والمحتوى خارجيّ (`content=`) فلا يُخزَّن النصّ مرّتين، والمحفّزات
-- أدناه تُبقيه مطابقاً للجدول مهما كتب فيه.
CREATE VIRTUAL TABLE IF NOT EXISTS legal_fts USING fts5(
  text_norm,
  handle_norm,
  content='legal_chunks',
  content_rowid='seq'
);

CREATE TRIGGER IF NOT EXISTS legal_chunks_ai AFTER INSERT ON legal_chunks BEGIN
  INSERT INTO legal_fts(rowid, text_norm, handle_norm) VALUES (new.seq, new.text_norm, new.handle_norm);
END;

CREATE TRIGGER IF NOT EXISTS legal_chunks_ad AFTER DELETE ON legal_chunks BEGIN
  INSERT INTO legal_fts(legal_fts, rowid, text_norm, handle_norm) VALUES ('delete', old.seq, old.text_norm, old.handle_norm);
END;

-- `UPDATE OF` لا `UPDATE` المجرّد: تحديث `embedded_at` بعد التضمين يمسّ كل
-- مقطع مرّة، ولا شأن للفهرس اللفظي به. بدون التقييد يُعاد بناء مدخلة الفهرس
-- لكل مقطع في القاعدة بلا سبب.
CREATE TRIGGER IF NOT EXISTS legal_chunks_au AFTER UPDATE OF text_norm, handle_norm ON legal_chunks BEGIN
  INSERT INTO legal_fts(legal_fts, rowid, text_norm, handle_norm) VALUES ('delete', old.seq, old.text_norm, old.handle_norm);
  INSERT INTO legal_fts(rowid, text_norm, handle_norm) VALUES (new.seq, new.text_norm, new.handle_norm);
END;

-- ── سجل دفعات الاستيراد ──
-- تقرير كل دفعة يُحفَظ: كم سطراً وصل، وكم استُبدل، وكم رُفض ولماذا.
CREATE TABLE IF NOT EXISTS legal_imports (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT,
  filename    TEXT,
  lines       INTEGER NOT NULL DEFAULT 0,
  inserted    INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  report_json TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_legal_imports_created ON legal_imports(created_at DESC);
