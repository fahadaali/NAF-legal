-- فهارسُ لمساراتٍ يمرّ بها القارئ كلَّ يوم وكانت تمسح جداولها كاملة.
--
-- كلُّها `IF NOT EXISTS` ولا تغيّر صفّاً: فهرسٌ يُبنى من البيانات القائمة.
--
-- ١. محادثاتُ المستخدم في قضية. الفهرس القائم `(user_id, updated_at)` يقف عند
--    المستخدم، ثم يُقرأ كلُّ صفٍّ من محادثاته ليُعرف مجلّده. ويمرّ بذلك: عدُّ
--    محادثات كل قضية في قائمة القضايا (عند فتح كل محادثة وعودة التركيز)،
--    وترشيحُ الشريط بقضية، وملفُّ القضية، والبحثُ داخل قضية.
CREATE INDEX IF NOT EXISTS idx_conversations_user_folder
  ON conversations(user_id, folder_id, updated_at DESC);

-- ٢. فتحُ استشهادٍ قديم حُفظ باسم النظام وحده (`resolveLawByTitle`): لا فهرس على
--    `law_title`، و`DISTINCT … LIMIT 2` لا يقف مبكراً حين يطابق نظامٌ واحد —
--    فكان كلُّ نقرٍ عليه مسحاً للقاعدة القانونية كلِّها.
CREATE INDEX IF NOT EXISTS idx_legal_law_title ON legal_chunks(law_title, law_id);

-- ٣. عددُ تعليقات كل مشاركة في شاشة الأدوات — عدٌّ مرتبط لكل مشاركة، وكلُّ عدٍّ
--    مسحٌ لجدول التعليقات كلِّه بلا هذا الفهرس.
CREATE INDEX IF NOT EXISTS idx_share_comments_share ON share_comments(share_id);

-- ٤. حذفُ المحادثة يحذف صادراتها ومشاركاتها برسائلها، و`ON DELETE CASCADE` من
--    `messages` يبحث عنها برسالتها — وجدول الصادرات يزيد مع كل تنزيل.
CREATE INDEX IF NOT EXISTS idx_exports_message ON exports(message_id);
CREATE INDEX IF NOT EXISTS idx_shares_message  ON shares(message_id);
