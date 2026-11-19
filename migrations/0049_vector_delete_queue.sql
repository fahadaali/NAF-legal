-- حذفُ المتجهات: ما فشل يُحفظ ليُعاد، وما بقي بلا سجلّ يُكنس.
--
-- كان كلُّ حذفٍ من الفهرس المتجهي يبتلع خطأه (`.catch(() => {})`): سجلٌّ حُذف أو
-- أُلغي، وفشل حذفُ متجهه مرّةً، فبقي المتجه بلا سجلّ ولا يعلم به أحد. والفحص الليلي
-- يعدّها ولا يملك إصلاحها: عُدّ منها 178 قبل 19 نوفمبر 2026. والمتجه اليتيم لا يُفسد
-- نتيجة — الاسترجاع يقرأ الصفّ من SQL بعد المطابقة — لكنه يشغل خانةً من `topK`.
--
-- legal_vector_deletes: معرّفٌ فشل حذفه، يُعاد في كل نبضة حتى يُحذف.
--
-- legal_vector_sweep: كنسُ الفهرس بـ`seq` حين يجد الفحص الليلي يتيماً. صفٌّ واحد:
--   cursor   آخرُ `seq` كُنس — NULL: لا كنس جارياً.
--   until    أعلى `seq` يبلغه الكنس، يُثبَّت عند بدئه: ما يُكتب بعده ليس يتيماً.
--   sent     كم معرّفاً أُرسل حذفُه في هذا الكنس — يُقال في السجلّ عند ختامه.
CREATE TABLE IF NOT EXISTS legal_vector_deletes (
  vector_id TEXT PRIMARY KEY,
  reason    TEXT,
  tries     INTEGER NOT NULL DEFAULT 1,
  first_at  INTEGER NOT NULL,
  last_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS legal_vector_sweep (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  cursor     INTEGER,
  until      INTEGER,
  sent       INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  updated_at INTEGER NOT NULL
);
