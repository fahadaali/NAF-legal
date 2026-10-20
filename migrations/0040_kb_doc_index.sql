-- فهرسُ الوثائق المرفوعة: مقاطعُها في D1 بنصّها كاملاً، وفهرسٌ لفظيّ عليها، ومتجهاتُها
-- في مساحة `documents` من Vectorize.
--
-- كانت مقاطع الوثائق لا تُحفظ إلا في بيانات المتجه الوصفية (أربعة آلاف حرفٍ سقفاً)،
-- بلا فهرسٍ لفظيّ، وفي الفهرس المتجهي نفسه مع موادّ الأنظمة — فتزاحمها الموادّ على
-- الخانات الستّ وتسقط بعد الاسترجاع، ولا يبلغ المساعدَ منها شيء. ولم يكن المحرّك
-- الطبقيّ يبحث فيها أصلاً.
CREATE TABLE IF NOT EXISTS kb_doc_chunks (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- `doc:<document_id>:<ord>` — معرّف المتجه نفسه.
  id          TEXT NOT NULL UNIQUE,
  document_id TEXT NOT NULL,
  ord         INTEGER NOT NULL,
  text        TEXT NOT NULL,
  text_norm   TEXT NOT NULL,
  text_stem   TEXT NOT NULL,
  article_ref TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES kb_documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_document ON kb_doc_chunks(document_id, ord);

CREATE VIRTUAL TABLE IF NOT EXISTS kb_doc_fts USING fts5(
  text_norm,
  text_stem,
  content='kb_doc_chunks',
  content_rowid='seq'
);

CREATE TRIGGER IF NOT EXISTS kb_doc_chunks_ai AFTER INSERT ON kb_doc_chunks BEGIN
  INSERT INTO kb_doc_fts(rowid, text_norm, text_stem) VALUES (new.seq, new.text_norm, new.text_stem);
END;
CREATE TRIGGER IF NOT EXISTS kb_doc_chunks_ad AFTER DELETE ON kb_doc_chunks BEGIN
  INSERT INTO kb_doc_fts(kb_doc_fts, rowid, text_norm, text_stem) VALUES ('delete', old.seq, old.text_norm, old.text_stem);
END;

-- 2 = مقاطعُ في D1 ومتجهاتٌ في مساحة `documents`. وما دونه يُعاد فهرستُه في الخلفية،
-- ويبقى يُسترجَع من مساره القديم حتى ذلك.
ALTER TABLE kb_documents ADD COLUMN index_version INTEGER NOT NULL DEFAULT 1;
