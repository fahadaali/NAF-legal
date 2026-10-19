-- خريطة الإسناد: لكل مجالٍ الأنظمةُ التي تقوم عليها قضاياه في كل طبقة.
--
-- القضية الموضوعية تستند إلى أكثر من نظام: الموضوعيّ الخاص، والإجرائيّ، والإثبات،
-- والأحكام العامة، واللائحة. والبحث بالتشابه لا يجد الإجرائيّ والعامّ لأنهما لا
-- يشبهان السؤال. فتُسمّى هنا، ويبحث فيها المحرّك الطبقي (`lib/research/layered.ts`)
-- بحثاً محصوراً في كل نظام، ويستكمل كل طبقةٍ «مطلوبة» لم يرجع منها شيء.
--
-- **البذور أدناه مسودّة `draft` لم يراجعها محامٍ**، كتبها المساعد البرمجي ليُراجعها
-- محامو ناف. والمحرّك لا يقرأ إلا `approved`: لا يدخل الاسترجاعَ شيءٌ منها قبل اعتماده.
CREATE TABLE IF NOT EXISTS grounding_map (
  id          TEXT PRIMARY KEY,
  domain      TEXT NOT NULL,
  layer       TEXT NOT NULL CHECK (layer IN ('substantive','procedural','evidence','general','regulation')),
  -- العنوان الرسمي كما في القاعدة — يُحلّ إلى `law_id` عند الاسترجاع.
  law_title   TEXT NOT NULL,
  -- مطلوبة: إن لم يرجع منها شيء بحث المحرّك فيها بسؤال المحامي نفسه.
  required    INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  note        TEXT,
  reviewed_by TEXT,
  reviewed_at INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grounding_domain ON grounding_map(domain, status);

INSERT OR IGNORE INTO grounding_map (id, domain, layer, law_title, required, status, created_at) VALUES
  ('gm-01', 'عمالي', 'substantive', 'نظام العمل', 1, 'draft', 1),
  ('gm-02', 'عمالي', 'regulation', 'اللائحة التنفيذية لنظام العمل', 0, 'draft', 1),
  ('gm-03', 'عمالي', 'procedural', 'نظام المرافعات الشرعية', 1, 'draft', 1),
  ('gm-04', 'عمالي', 'evidence', 'نظام الإثبات', 0, 'draft', 1),
  ('gm-05', 'عمالي', 'general', 'نظام المعاملات المدنية', 0, 'draft', 1),
  ('gm-06', 'تجاري', 'procedural', 'نظام المحاكم التجارية', 1, 'draft', 1),
  ('gm-07', 'تجاري', 'regulation', 'اللائحة التنفيذية لنظام المحاكم التجارية', 0, 'draft', 1),
  ('gm-08', 'تجاري', 'evidence', 'نظام الإثبات', 1, 'draft', 1),
  ('gm-09', 'تجاري', 'general', 'نظام المعاملات المدنية', 1, 'draft', 1),
  ('gm-10', 'شركات', 'substantive', 'نظام الشركات', 1, 'draft', 1),
  ('gm-11', 'شركات', 'procedural', 'نظام المحاكم التجارية', 1, 'draft', 1),
  ('gm-12', 'شركات', 'general', 'نظام المعاملات المدنية', 0, 'draft', 1),
  ('gm-13', 'مدني', 'substantive', 'نظام المعاملات المدنية', 1, 'draft', 1),
  ('gm-14', 'مدني', 'procedural', 'نظام المرافعات الشرعية', 1, 'draft', 1),
  ('gm-15', 'مدني', 'evidence', 'نظام الإثبات', 1, 'draft', 1),
  ('gm-16', 'أحوال شخصية', 'substantive', 'نظام الأحوال الشخصية', 1, 'draft', 1),
  ('gm-17', 'أحوال شخصية', 'procedural', 'نظام المرافعات الشرعية', 1, 'draft', 1),
  ('gm-18', 'أحوال شخصية', 'evidence', 'نظام الإثبات', 0, 'draft', 1),
  ('gm-19', 'تنفيذ', 'procedural', 'نظام التنفيذ', 1, 'draft', 1),
  ('gm-20', 'تنفيذ', 'regulation', 'اللائحة التنفيذية لنظام التنفيذ', 0, 'draft', 1),
  ('gm-21', 'جزائي', 'procedural', 'نظام الإجراءات الجزائية', 1, 'draft', 1),
  ('gm-22', 'إداري', 'procedural', 'نظام المرافعات أمام ديوان المظالم', 1, 'draft', 1),
  ('gm-23', 'تحكيم', 'substantive', 'نظام التحكيم', 1, 'draft', 1),
  ('gm-24', 'حماية البيانات', 'substantive', 'نظام حماية البيانات الشخصية', 1, 'draft', 1),
  ('gm-25', 'حماية البيانات', 'regulation', 'اللائحة التنفيذية لنظام حماية البيانات الشخصية', 0, 'draft', 1);
