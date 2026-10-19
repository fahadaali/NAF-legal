-- أثرُ الاسترجاع لكل دور: الخطة، والاستعلامات، وما رجع من كل مسار، وما تعطّل.
--
-- كانت أعطال الاسترجاع تُبتلع بلا أثر، فيخرج ردٌّ بلا سندٍ نظاميّ يبدو عادياً ولا
-- يعرف أحدٌ أن البحث لم يعمل. وهذا الجدول هو ما يقول ذلك، ومنه يُقاس الاسترجاع.
CREATE TABLE IF NOT EXISTS retrieval_traces (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT,
  -- رسالة المستخدم التي جرى لها الاسترجاع.
  message_id        TEXT,
  user_id           TEXT,
  consultation_type TEXT,
  plan_json         TEXT,
  steps_json        TEXT NOT NULL,
  -- مفاتيح ما وصل إلى التوليد، بترتيبه.
  result_keys_json  TEXT NOT NULL,
  failed            INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_traces_created ON retrieval_traces(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_traces_failed ON retrieval_traces(failed, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_traces_conversation ON retrieval_traces(conversation_id);
