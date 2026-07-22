// إعداد نماذج الاستشارات: الحقول، طلب الملف، والبرومبت — قابلة للتحكّم من الإدارة
import { systemPromptFor, CONSULTATION_LABELS } from './prompts';
import type { Env } from '../types';

export type FieldType = 'text' | 'number' | 'textarea';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
}

export interface FileRequest {
  enabled: boolean;
  label: string;
  required: boolean;
  allow_text: boolean; // السماح بلصق النص بدل رفع ملف
}

export interface ConsultConfig {
  key: string;
  label: string;
  system_prompt: string;
  file: FileRequest;
  fields: FieldDef[];
}

const noFile: FileRequest = { enabled: false, label: '', required: false, allow_text: false };

// تعريفات الحقول وطلب الملف الافتراضية لكل نوع (§4)
const DEFAULTS: Record<string, { file: FileRequest; fields: FieldDef[] }> = {
  'litigation.statement_of_claim': {
    file: { enabled: true, label: 'المستندات المؤيِّدة (اختياري)', required: false, allow_text: false },
    fields: [
      { key: 'plaintiff', label: 'المدّعي وبياناته وصفته', type: 'textarea', required: true },
      { key: 'defendant', label: 'المدّعى عليه وبياناته وصفته', type: 'textarea', required: true },
      { key: 'court', label: 'الجهة القضائية المختصّة', type: 'text' },
      { key: 'facts', label: 'الوقائع مرتّبة زمنيًا', type: 'textarea', required: true },
      { key: 'claims', label: 'الطلبات', type: 'textarea', required: true },
      { key: 'evidence', label: 'الأدلة والمستندات', type: 'textarea' },
    ],
  },
  'litigation.reply_memo': {
    file: { enabled: true, label: 'صحيفة الدعوى / مذكرة الخصم', required: true, allow_text: true },
    fields: [
      { key: 'client_position', label: 'موقف الموكِّل', type: 'textarea', required: true },
      { key: 'defense_evidence', label: 'أدلّة الدفاع', type: 'textarea' },
    ],
  },
  'litigation.objection': {
    file: { enabled: true, label: 'صك الحكم المُعترَض عليه', required: true, allow_text: true },
    fields: [
      { key: 'notify_date', label: 'تاريخ التبليغ بالحكم', type: 'text', required: true, placeholder: 'مثال: 1447/01/15هـ' },
      { key: 'reasons', label: 'أسباب الاعتراض (إن وُجدت)', type: 'textarea' },
    ],
  },
  'litigation.judgment_analysis': {
    file: { enabled: true, label: 'نص الحكم القضائي', required: true, allow_text: true },
    fields: [{ key: 'focus', label: 'نقاط التركيز في التحليل (اختياري)', type: 'textarea' }],
  },
  contract: {
    file: noFile,
    fields: [
      { key: 'contract_type', label: 'نوع العقد', type: 'text', required: true },
      { key: 'parties', label: 'الأطراف', type: 'textarea', required: true },
      { key: 'core_terms', label: 'البنود الجوهرية', type: 'textarea', required: true },
      { key: 'special_terms', label: 'الشروط الخاصة', type: 'textarea' },
      { key: 'sector', label: 'القطاع', type: 'text' },
    ],
  },
  policy: {
    file: noFile,
    fields: [
      { key: 'entity_type', label: 'نوع الجهة (شركة/جمعية)', type: 'text', required: true },
      { key: 'purpose', label: 'الغرض', type: 'textarea', required: true },
      { key: 'scope', label: 'النطاق', type: 'textarea' },
      { key: 'reference', label: 'المرجعية النظامية', type: 'text' },
    ],
  },
  consultation: {
    file: { enabled: true, label: 'مستندات داعمة (اختياري)', required: false, allow_text: false },
    fields: [
      { key: 'question', label: 'السؤال', type: 'textarea', required: true },
      { key: 'context', label: 'الوقائع والسياق', type: 'textarea' },
    ],
  },
  document_review: {
    file: { enabled: true, label: 'المستند المراد مراجعته وتدقيقه', required: true, allow_text: true },
    fields: [
      { key: 'doc_type', label: 'نوع المستند (عقد/مذكرة/لائحة)', type: 'text' },
      { key: 'focus', label: 'نقاط التركيز (اختياري)', type: 'textarea' },
    ],
  },
};

export function defaultConfig(key: string): ConsultConfig {
  const d = DEFAULTS[key] ?? { file: noFile, fields: [] };
  return {
    key,
    label: CONSULTATION_LABELS[key] ?? 'استشارة',
    system_prompt: systemPromptFor(key),
    file: d.file,
    fields: d.fields,
  };
}

export function allKeys(): string[] {
  return Object.keys(CONSULTATION_LABELS);
}

// الإعداد الفعّال: تجاوز الإدارة إن وُجد، وإلا الافتراضي
export async function getEffectiveConfig(env: Env, key: string): Promise<ConsultConfig> {
  const row = await env.DB.prepare('SELECT config_json FROM consultation_configs WHERE key = ?')
    .bind(key)
    .first<{ config_json: string }>();
  if (row?.config_json) {
    try {
      const parsed = JSON.parse(row.config_json);
      return { ...defaultConfig(key), ...parsed, key };
    } catch {}
  }
  return defaultConfig(key);
}

export async function getAllEffectiveConfigs(env: Env): Promise<ConsultConfig[]> {
  return Promise.all(allKeys().map((k) => getEffectiveConfig(env, k)));
}

// النسخة العامة (بلا البرومبت) لمستخدمي الواجهة
export function publicView(c: ConsultConfig) {
  return { key: c.key, label: c.label, file: c.file, fields: c.fields };
}
