// أنواع البيئة (bindings) والسياق المشترك

export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  // اختياريّ: يعمل عند توفّر Vectorize (يتطلّب صلاحية الرمز). بدونه يتعطّل
  // الاسترجاع الدلالي (RAG) بسلاسة ويُستخدم البحث النصّي كبديل.
  //
  // وكان معه `CONV_VECTORIZE` لفهرس المحادثات، وأُسقط: كان يُكتب في كل دور
  // ولا يقرؤه أحد — التفصيل في `lib/rag.ts`.
  VECTORIZE?: VectorizeIndex;
  AI: Ai;
  KV: KVNamespace;
  // مساحة الدخول الموحّد — مستقلّة عن `KV` أعلاه. تكتب فيها الحزمة
  // `sess:` و `jwks:` وحدها، فلا تزاحم مفاتيح حدّ المعدّل (`rl:`).
  AUTH_KV: KVNamespace;
  ASSETS: Fetcher;
  // vars
  APP_NAME: string;
  PLANNER_MODEL: string;
  GENERATION_MODEL: string;
  EMBEDDING_MODEL: string;
  DATA_REGION: string;
  // ── الدخول الموحّد ──
  // وهذان وحدهما ما يتغيّر بين منصة وأخرى. `PLATFORM_ID` هو `aud` في الرمز
  // والمقارنة حرفية ولا تُطبَّع، و`AUTH_ISSUER` هو `iss` وكذلك — فحرف واحد
  // بحالة أخرى أو شرطة أخيرة زائدة تجعل كل رمز صحيح يُرفض، والرفض صامت.
  PLATFORM_ID: string;
  AUTH_ISSUER: string;
  // secrets
  ANTHROPIC_API_KEY: string;
  JWT_SECRET: string;
  // سرّ المنصة لدى المركز — عبر `wrangler secret` حصراً
  AUTH_CLIENT_SECRET: string;
  // اختيارية: لتفعيل إشعارات البريد
  RESEND_API_KEY?: string;
  NOTIFY_FROM?: string;
}

// أدوار هذه المنصة. المصادقة مركزية والصلاحيات موزّعة، فمفردات الأدوار
// تُقرأ من `members` وتُدار من إعدادات المنصة ولا شأن للمركز بها.
export type PlatformRole = 'admin' | 'editor' | 'viewer';

export interface AuthUser {
  id: string;
  email: string;
  role: PlatformRole;
  name?: string;
  // المعرّف المركزي (`sub`). يبقى منفصلاً عن `id` لأن الأول مفتاح `members`
  // والثاني مفتاح كل جداول المنصة القائمة — ودمجهما يقطع المستخدم عن بياناته.
  memberId?: string;
  perms?: Record<string, unknown> | null;
}

export type Variables = {
  user: AuthUser;
};

// أنواع الاستشارات (§4)
export type ConsultationType =
  | 'litigation.statement_of_claim'
  | 'litigation.reply_memo'
  | 'litigation.objection'
  | 'litigation.judgment_analysis'
  | 'contract'
  | 'policy'
  | 'consultation'
  | 'document_review';

export interface PlannerOutput {
  consultation_type: ConsultationType;
  needs_knowledge_base: boolean;
  kb_queries: string[];
  needs_internet_search: boolean;
  internet_queries: string[];
  needs_uploaded_files: boolean;
  target_regulations: string[];
  clarifying_questions: string[];
  output_format: 'text' | 'docx';
}
