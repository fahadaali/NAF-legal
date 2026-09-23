-- الدفعة تُكتب كاملةً أو لا تُكتب (§4-٦ و§8 من وثيقة الاستيراد).
--
-- كان الملف يُرفع أجزاءً من خمسمئة سطر، وكلُّ جزءٍ يُكتب في القاعدة حين يصل.
-- فانقطاعٌ في منتصف الملف يترك نظاماً نصفُه جديد ونصفُه قديم، والبحث يقرؤه كذلك
-- طوال الرفع. والآن: الأجزاء تُجمع هنا جانباً حتى يكتمل الملف، ثم يُكتب نظاماً
-- نظاماً — وكلُّ نظامٍ يغيب عن البحث وهو يُكتب ويعود كاملاً — ويُردّ ما كُتب إن
-- تعذّر الإتمام.

-- ── الدفعة ──
-- حالُها سلسلةٌ في اتجاهٍ واحد: تُجمع، ثم تُكتب، ثم تُعتمد أو تُردّ. و`import_id`
-- يُولَّد عند بدء الكتابة، وبه يُوسَم ما تؤرشفه في سجلّ التحديث — فيُمحى إن رُدّت،
-- إذ لم يقع ما يُؤرَّخ له.
CREATE TABLE IF NOT EXISTS legal_batches (
  batch_id     TEXT PRIMARY KEY,
  import_id    TEXT,
  filename     TEXT,
  file_sha256  TEXT,
  actor_id     TEXT,
  kind         TEXT NOT NULL DEFAULT 'import' CHECK (kind IN ('import', 'correction')),
  partial      INTEGER NOT NULL DEFAULT 0 CHECK (partial IN (0, 1)),
  state        TEXT NOT NULL DEFAULT 'staging'
               CHECK (state IN ('staging', 'committing', 'committed', 'rolled_back', 'abandoned')),
  -- حذفُ ما غاب عن الملف: يُسأل عنه قبل الكتابة، ويقع مع كل نظامٍ وهو مجمَّد.
  prune        INTEGER NOT NULL DEFAULT 0 CHECK (prune IN (0, 1)),
  lines        INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,
  inserted     INTEGER NOT NULL DEFAULT 0,
  updated      INTEGER NOT NULL DEFAULT 0,
  archived     INTEGER NOT NULL DEFAULT 0,
  superseded   INTEGER NOT NULL DEFAULT 0,
  deleted      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  -- نبضُ الدفعة: يتقدّم مع كل خطوة، ودفعةٌ سكتت طويلاً وهي تُكتب متروكةٌ تُردّ.
  updated_at   INTEGER NOT NULL,
  -- بدءُ الكتابة: ما أُدرج بعده من معرّفات الملف أدرجته هذه الدفعة (`imported_at`
  -- لا يتغيّر بإعادة الكتابة)، فيُعرف عند الردّ ولو فاته قيدُه في `legal_batch_ids`.
  commit_started_at INTEGER,
  committed_at INTEGER,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_legal_batches_state ON legal_batches(state, updated_at);

-- ── ما جُمع ولم يُكتب ──
-- السطرُ مُعدّاً كما يُكتب (`PreparedChunk`) نصّاً واحداً: فحصُه وقع عند الرفع،
-- والكتابةُ عند الإتمام لا تُعيده. و`seq` ترتيبُه في الملف، فتُكتب الأنظمة بترتيب
-- ورودها. ويُحذف السطر حين يُكتب — فما بقي هنا هو ما لم يُكتب بعد، وما كُتب
-- قيدُه في `legal_batch_ids`.
CREATE TABLE IF NOT EXISTS legal_staging (
  batch_id TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  id       TEXT NOT NULL,
  law_id   TEXT,
  row_json TEXT NOT NULL,
  PRIMARY KEY (batch_id, id)
);
CREATE INDEX IF NOT EXISTS idx_legal_staging_seq ON legal_staging(batch_id, seq);
CREATE INDEX IF NOT EXISTS idx_legal_staging_law ON legal_staging(batch_id, law_id);

-- ── الأنظمة المجمَّدة ──
-- نظامٌ هنا لا يراه الاسترجاع حتى يُكتب كاملاً: شرطٌ واحد في طبقة الاسترجاع
-- (`buildFilters`) يسري على البحث والمساعد واستدعاء المادة وصفحة النظام معاً.
-- والجدول فارغٌ في غير وقت الكتابة، فالشرط لا يكلّف البحث شيئاً.
CREATE TABLE IF NOT EXISTS legal_law_locks (
  law_id   TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  since    INTEGER NOT NULL
);
