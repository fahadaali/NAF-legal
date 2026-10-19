-- الإحالات بين المواد — تُستخرج من النصوص بقواعد حتمية (`src/lib/research/links.ts`).
--
-- المادة تحيل إلى مادةٍ في نظامها أو في نظامٍ آخر أو في لائحتها، والبحث بالتشابه
-- لا يجد المحال إليه. فتُحفظ الإحالات هنا، ويتبعها الاسترجاع قفزةً واحدة.
CREATE TABLE IF NOT EXISTS legal_article_links (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- المقطع المحيل.
  from_seq      INTEGER NOT NULL,
  -- النظام المحال إليه إن عُرف، وإلا عنوانُه كما كُتب ليُراجَع.
  to_law_id     TEXT,
  to_law_title  TEXT,
  -- رقم المادة مطبَّعاً — فارغٌ لإحالةٍ إلى نظامٍ بلا مادة.
  to_article_no TEXT,
  -- أوّل أجزاء المادة المحال إليها حين تُوجد في القاعدة.
  to_seq        INTEGER,
  -- self · named · regulation · parent · previous
  scope         TEXT NOT NULL,
  excerpt       TEXT,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_links_unique
  ON legal_article_links(from_seq, IFNULL(to_law_id, ''), IFNULL(to_law_title, ''), IFNULL(to_article_no, ''));
CREATE INDEX IF NOT EXISTS idx_links_from ON legal_article_links(from_seq);
CREATE INDEX IF NOT EXISTS idx_links_to ON legal_article_links(to_seq);
CREATE INDEX IF NOT EXISTS idx_links_unresolved ON legal_article_links(to_law_id, to_article_no) WHERE to_seq IS NULL;

-- متى استُخرجت إحالاتُ المقطع. فارغٌ = ينتظر.
ALTER TABLE legal_chunks ADD COLUMN links_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_chunks_links_pending ON legal_chunks(seq) WHERE links_at IS NULL;

-- نصٌّ تغيّر يُعاد استخراج إحالاته.
CREATE TRIGGER IF NOT EXISTS legal_chunks_links_reset AFTER UPDATE OF text_norm ON legal_chunks
WHEN old.text_norm IS NOT new.text_norm BEGIN
  UPDATE legal_chunks SET links_at = NULL WHERE seq = new.seq;
END;

-- مقطعٌ حُذف: إحالاتُه تُحذف، والإحالاتُ إليه تعود معلّقةً حتى تُحلّ إلى خلفه.
CREATE TRIGGER IF NOT EXISTS legal_chunks_links_delete AFTER DELETE ON legal_chunks BEGIN
  DELETE FROM legal_article_links WHERE from_seq = old.seq;
  UPDATE legal_article_links SET to_seq = NULL WHERE to_seq = old.seq;
END;
