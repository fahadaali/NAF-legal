-- الدخول الموحّد — جدول الأعضاء المحلي
--
-- المصادقة مركزية والصلاحيات موزّعة: المركز يقرّر الدخول، وهذا الجدول يقرّر
-- ما بعد الباب. مخطّطه هو مخطّط `naf-auth/migrations/members.sql` حرفياً،
-- وزيادةَ عمود واحد تفرضه هذه المنصة وحدها — `local_user_id`.
--
-- لماذا لا يُستبدل المعرّف المحلي بـ `sub`:
-- لهذه المنصة نظام مستخدمين قائم، و`users(id)` مرجعٌ لثمانية جداول أربعةٌ
-- منها بـ ON DELETE CASCADE. فالقرار المعتمد ربطٌ بالبريد لا استبدال:
-- يبقى `users` مصدرَ الهوية الداخلية وتبقى كل المفاتيح الأجنبية سليمة،
-- ويُمسك `members` طرفَي الحبل — `user_id` من المركز و`local_user_id` محلياً.
--
-- الهجرات للأمام فقط: هذا ملف جديد، ولم تُعدَّل هجرة سابقة ولم يُحذف شيء.

CREATE TABLE IF NOT EXISTS members (
  user_id      TEXT PRIMARY KEY,   -- sub القادم من المركز
  display_name TEXT,
  email        TEXT,
  role         TEXT NOT NULL DEFAULT 'viewer',   -- admin | editor | viewer
  perms        TEXT,               -- JSON للصلاحيات الدقيقة
  is_active    INTEGER NOT NULL DEFAULT 1,
  last_seen_at INTEGER,
  created_at   INTEGER NOT NULL,

  -- الربط بالسجلّ المحلي القائم. يبقى فارغاً لعضوٍ لا مقابل له في `users`،
  -- وهو الوضع الطبيعي لكل من يدخل هذه المنصة أول مرة بعد الربط.
  local_user_id TEXT REFERENCES users(id)
);

-- البحث بالبريد عند مطابقة عضو قادم بسجلّ قائم (§٣ من README الحزمة).
CREATE INDEX IF NOT EXISTS idx_members_email ON members(email);

-- سجلّ محلي واحد لا يُربط بهويتين مركزيتين. الفريد يقبل تكرار NULL في
-- SQLite، فالأعضاء بلا مقابل محلي لا يتزاحمون على هذا القيد.
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_local_user ON members(local_user_id);

-- ملاحظتان على القيم:
--
-- ١) لا قيد CHECK على `role` — عمداً، وهو قرار الحزمة نفسها: مفردات الأدوار
--    تخصّ كل منصة، وقيدٌ هنا يمنع منصة من استعمال أدوارها هي.
--
-- ٢) أعمدة الوقت هنا بالثواني لا بالملّي ثانية، خلافاً لبقية جداول المنصة.
--    الحزمة هي التي تكتب `created_at` و `last_seen_at` عبر `upsertMember`،
--    وصيغتها `epoch` بالثواني. وتغييرها ليس خياراً: `MEMBERS_TIME_FORMAT`
--    يقبل `epoch` أو `iso` ولا ثالث لهما. فكل قراءة لهذين العمودين تضرب
--    في ألف قبل التنسيق — وهذا موضعه الوحيد `membersRoute`.
