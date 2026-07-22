// أنواع البيئة (bindings) والسياق المشترك

export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  // اختياريان: يعملان عند توفّر Vectorize (يتطلّب صلاحية الرمز). بدونهما
  // يتعطّل الاسترجاع الدلالي (RAG) بسلاسة ويُستخدم البحث النصّي كبديل.
  VECTORIZE?: VectorizeIndex;
  CONV_VECTORIZE?: VectorizeIndex;
  AI: Ai;
  KV: KVNamespace;
  ASSETS: Fetcher;
  // vars
  APP_NAME: string;
  PLANNER_MODEL: string;
  GENERATION_MODEL: string;
  EMBEDDING_MODEL: string;
  DATA_REGION: string;
  // secrets
  ANTHROPIC_API_KEY: string;
  JWT_SECRET: string;
}

export interface AuthUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
  name?: string;
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
