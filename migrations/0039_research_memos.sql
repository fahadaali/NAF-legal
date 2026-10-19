-- مذكرة البحث: ما بُني عليه الدور — المسائل وموادّها، وما لا سند له.
--
-- كانت المواد المسترجعة تدخل البرومبت ثم تُنسى: الرسالة تُحفظ بنصّها وحده، فسؤالُ
-- المتابعة («عدّل الفقرة الثانية») يُصاغ بلا النصوص التي بُنيت عليها المسودّة.
-- والمذكرة تُحفظ لكل دورٍ ويُعاد ما فيها في الدور التالي، وتُعرض على المحامي
-- ليعدّل أسانيدها أو يعتمدها قبل الصياغة.
CREATE TABLE IF NOT EXISTS research_memos (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  -- رسالة المستخدم التي بُنيت لها.
  message_id      TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  -- [{kind, title, layer, items: [{key, seq, title, ref}]}]
  groups_json     TEXT NOT NULL,
  -- [{kind, title, layer, reason}] — مسائل وطبقاتٌ لم يُوجد لها سند.
  gaps_json       TEXT NOT NULL DEFAULT '[]',
  -- auto: بُنيت وصيغ منها مباشرة · draft: تنتظر المحامي · approved: اعتمدها.
  status          TEXT NOT NULL DEFAULT 'auto' CHECK (status IN ('auto', 'draft', 'approved')),
  approved_by     TEXT,
  approved_at     INTEGER,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memos_conversation ON research_memos(conversation_id, created_at DESC);
