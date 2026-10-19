-- فهرسٌ لفظيٌّ ثانٍ على الجذوع الخفيفة (`lightStem` في `src/lib/arabic.ts`).
--
-- الفهرس الأول على النصّ المطبَّع لا يطابق «العامل» بـ«للعامل» ولا «والعامل»:
-- السابقة المتصلة تجعل الكلمة غيرها. وهذا الفهرس على الجذوع فيطابقها، ونتائجه
-- تُلحق بنتائج الأول بعدها فلا يتغيّر ترتيبه.
--
-- `text_stem` يُملأ بمهمّة Cron (`runStemBackfill`) لا في الاستيراد: الحساب في
-- الشيفرة لا في SQL. ونصٌّ تغيّر يُفرَّغ جذعُه ليُعاد حسابه.
ALTER TABLE legal_chunks ADD COLUMN text_stem TEXT;
CREATE INDEX IF NOT EXISTS idx_chunks_stem_pending ON legal_chunks(seq) WHERE text_stem IS NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS legal_fts_stem USING fts5(
  text_stem,
  content='legal_chunks',
  content_rowid='seq'
);

CREATE TRIGGER IF NOT EXISTS legal_chunks_stem_ad AFTER DELETE ON legal_chunks
WHEN old.text_stem IS NOT NULL BEGIN
  INSERT INTO legal_fts_stem(legal_fts_stem, rowid, text_stem) VALUES ('delete', old.seq, old.text_stem);
END;

CREATE TRIGGER IF NOT EXISTS legal_chunks_stem_au AFTER UPDATE OF text_stem ON legal_chunks BEGIN
  INSERT INTO legal_fts_stem(legal_fts_stem, rowid, text_stem)
    SELECT 'delete', old.seq, old.text_stem WHERE old.text_stem IS NOT NULL;
  INSERT INTO legal_fts_stem(rowid, text_stem)
    SELECT new.seq, new.text_stem WHERE new.text_stem IS NOT NULL;
END;

-- النصّ تغيّر: الجذع القديم لا يصفه، فيُفرَّغ (ويخرج من الفهرس بالمحفّز أعلاه).
CREATE TRIGGER IF NOT EXISTS legal_chunks_stem_reset AFTER UPDATE OF text_norm ON legal_chunks
WHEN old.text_norm IS NOT new.text_norm AND new.text_stem IS NOT NULL BEGIN
  UPDATE legal_chunks SET text_stem = NULL WHERE seq = new.seq;
END;
