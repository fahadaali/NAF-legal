-- نوعُ مصادقة المصدر الخارجيّ
--
-- كان العميل يعرف `Bearer` وحده، فردّ خادم المكتبة الشاملة ٤٠١ على المصافحة:
-- هو على مصادقةٍ أساسية (مستخدم وكلمة مرور). وليست حالةً نادرة — خوادمُ MCP
-- المنشورة خلف وكيلٍ عكسيّ تُحمى بالأساسية أكثر مما تُحمى برمزٍ حامل.
--
-- والقيمةُ تبقى في السرّ `MCP_TOKENS` كما كانت؛ ما يتغيّر تفسيرُها:
--   bearer → القيمة رمزٌ يُرسَل كما هو
--   basic  → القيمة «مستخدم:كلمة مرور» تُرمَّز بـbase64
-- فلا حقلَ اسمِ مستخدمٍ في شاشة، ولا كلمةَ مرورٍ تُقرأ فوق كتف.

ALTER TABLE external_sources
  ADD COLUMN auth_scheme TEXT NOT NULL DEFAULT 'bearer'
  CHECK (auth_scheme IN ('bearer', 'basic'));

-- الشاملة على الأساسية — مثبَتاً من ردّها لا مُخمَّناً.
UPDATE external_sources SET auth_scheme = 'basic', updated_at = unixepoch() * 1000
WHERE id = 'shamela';
