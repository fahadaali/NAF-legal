-- سجلّ تحديث المواد النظامية.
--
-- الاستيراد استبدالٌ على `id`، فإعادة رفع نظامٍ عُدِّل تكتب فوق نصّ المادة
-- القديم ولا يبقى منه شيء. وهذا يكفي للاسترجاع ولا يكفي للعمل القانوني:
-- المحامي يحتاج أن يعرف **ماذا كان النصّ قبل التعديل ومتى تغيّر** — وقضيةٌ
-- وقعت وقت سريان النصّ القديم تُحاكَم به لا بالجديد.
--
-- فما يُزاح يُؤرشَف هنا قبل أن يُكتب فوقه، ويبقى النصّ الجاري في
-- `legal_chunks` وحده هو المعتمد الذي يُستشهد به.

CREATE TABLE IF NOT EXISTS legal_chunk_versions (
  id             TEXT PRIMARY KEY,
  -- المادة التي أُزيح نصُّها — مفتاح العقد نفسه، لا مفتاحٌ داخلي.
  chunk_id       TEXT NOT NULL,
  law_id         TEXT,

  -- ما كان قبل الإزاحة، كما كان.
  article_no     TEXT,
  status         TEXT,
  is_repealed    INTEGER NOT NULL DEFAULT 0,
  instrument_no  TEXT,
  issue_date     TEXT,
  issue_date_hijri TEXT,
  text           TEXT NOT NULL,

  -- ما تغيّر: `text` أو `article_no` أو `status` أو أكثر، مفصولةً بفاصلة.
  changed_fields TEXT NOT NULL,
  -- دفعة الاستيراد التي أزاحته — به يُربط التغيير بمصدره ووقته.
  import_id      TEXT,
  archived_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_legal_versions_chunk ON legal_chunk_versions(chunk_id, archived_at DESC);
CREATE INDEX IF NOT EXISTS idx_legal_versions_law   ON legal_chunk_versions(law_id, archived_at DESC);
CREATE INDEX IF NOT EXISTS idx_legal_versions_import ON legal_chunk_versions(import_id);
