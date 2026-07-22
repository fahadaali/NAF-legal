-- نموذج الحسابات المُدارة: المسؤول يضيف المستخدمين، وكلمة المرور الافتراضية 1234،
-- ويُطلب من المستخدم تغييرها عند أول دخول.
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
