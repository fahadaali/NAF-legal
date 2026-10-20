-- مهامّ البحث في الخلفية: مذكرةٌ تُبنى في `ResearchRunner` ولو أُغلق المتصفّح.
--
-- البحث المعمّق جولاتٌ من Claude وأدواته — دقائق لا ثوانٍ، وطلبُ HTTP مفتوحٌ طوالها
-- ينقطع بانقطاع الشبكة أو بإغلاق الصفحة فيضيع ما بُني. والمهمّة هنا تُحفظ أولاً،
-- ويبنيها Durable Object بمنبّهه، ويُتابَع تقدّمها بالاستطلاع.
CREATE TABLE IF NOT EXISTS research_jobs (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  message             TEXT NOT NULL,
  consultation_type   TEXT,
  attachment_ids_json TEXT NOT NULL DEFAULT '[]',
  deep                INTEGER NOT NULL DEFAULT 0,
  -- queued: حُفظت ولم تبدأ · running: تُبنى · done: مذكرتها في `memo_id` · failed: تعطّلت.
  status              TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  -- آخر مرحلة: planned · retrieved · round:N
  stage               TEXT,
  -- {steps, recent: [{stage, query, count}]} — ما يُعرض من التقدّم.
  progress_json       TEXT,
  memo_id             TEXT,
  error               TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_research_jobs_user ON research_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_jobs_conversation ON research_jobs(conversation_id, created_at DESC);
