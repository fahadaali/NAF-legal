// إعداد نماذج الاستشارات: الحقول، طلب الملف، والبرومبت — قابلة للتحكّم من الإدارة
import {
  systemPromptFor,
  CONSULTATION_LABELS,
  DEFAULT_OUTPUT_STYLE,
  outputStyleInstruction,
} from './prompts';
import { loadFirmName } from './docTemplate';
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
  legal_basis: {
    file: { enabled: true, label: 'نصّ المذكرة أو اللائحة أو العقد', required: true, allow_text: true },
    fields: [
      { key: 'doc_type', label: 'نوع المستند (مذكرة/لائحة/عقد)', type: 'text' },
      { key: 'focus', label: 'مواضع التركيز (اختياري)', type: 'textarea' },
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

/* ══ برومبتٌ محفوظ ليس بالضرورة برومبتاً مخصَّصاً ══
 *
 * شاشة الإدارة تحفظ الإعداد كاملاً: من غيّر حقلاً أو علّم «إلزامي» حفظ معه
 * نصَّ البرومبت كما عُرض عليه — أي الافتراضيَّ يومها. فتجمّد ذلك النصّ في
 * القاعدة، ولم يبلغ النوعَ بعدها أيُّ تحسينٍ على الافتراضي، ولا ظهر في الشاشة.
 *
 * فما طابق افتراضياً سابقاً بحرفه يُقرأ افتراضياً: لم يكتبه أحد، وإنما حُفظ
 * مروراً. والقائمة بصمات SHA-256 (للمفتاح والنصّ معاً) لكل افتراضيٍّ شُحن منذ أوّل إيداع في
 * المستودع، لكل نوع، مأخوذةً من تاريخ `prompts.ts`. وما خالفها بحرفٍ واحد
 * تعديلٌ مقصود يبقى كما هو.
 *
 * ومن الآن لا يُجمَّد شيء: الحفظ لا يكتب البرومبت إن طابق الافتراضي
 * (`storedConfig`)، فالقائمة لا تحتاج أن تطول مع كل تعديلٍ للافتراضي. */
const LEGACY_DEFAULT_PROMPTS = new Set<string>([
  '046ffaf6ae014b359a00aa9e73dfde4871f5de5b1ee196a8bb78d077658f7a67',
  '0950127ca4d384f670bed635b0ea8ec1830f7b81e8cd694b31e4848703dec261',
  '1249a111386a508bdae3a5c5d180c5916befd72f84d92083bba56ea5986b1fa3',
  '215417cd0ae5044d4a4c7f7633ca777b7c1fdd408367667a34b21515ce1bd785',
  '2387a5d7da1f26720a87a0f86568b504461adcf942ccf26ce291b707221e002f',
  '23ad58e9d2d8c80748332016a4636dfe5feacfbee52443b31f3e3ad40498812d',
  '36bf2e9e2d9b10aabae756414f1065460fcf204090e9e98a929e913cfbdc6199',
  '3b317b49f038898908dc356fcdbf849792dc0a0171f43bd7868cacc606dfbe1c',
  '60b1cc0044f037215f606600767357d48f59661279ce31b90af20aebdcb018c6',
  '67467b66f4bb0c74e2f3245515b5b0b303f3fbc64564201afc459a0bd2c5e4d6',
  '67702865778c56a2be5838fe9620dbc4d15d1cd052d2f34d6d1ae22005cad7e8',
  '69dab52ee656bc42349961cf1c01b5a81493b2507b5a59b9e4c4652fff6eabc3',
  '705c17b4939ac9746839cd0916f62ba3978c1a0e50f914b35be0aa2b46368b2a',
  '725ddd6ce7d60dd1bb21c5610b68c75fef94262288722ae7be86340582340bc3',
  '749f7e2e63d172e72b1bc0e844acbcf9aee5cfed3c763c843ff8afa21efc921a',
  '7e51733f781dc1f9d53225d247b5a64a3e677c88ed9f10108c8b9335cd159b8a',
  '8c22e3a6d3c93bca79481d1c7ef04cb032c7808677a6ccd97198786a0ff08ca3',
  '91a56c552602207e8b887f58dc7c458e72a072c9347f2acc4bbeb171fc372dd7',
  '928d9e414e33546675c02006656f9aab8099e87d722d0a450114a08a32117be8',
  '94fd699fa2ef59c282875bccd961d5baba6050fa44a8a81fcee765575696fad4',
  '9a152e4a826e4d2919392e312baf8f761c1b48ae4858b20a9c1879a752dadd6b',
  '9b8c24a3bb2d0deb44ae436ee143f9e26649338ffa9982027a4d808ffb8cdc87',
  'a006dd34f448d06b93471f7aea535c1d985dc7a1a43b11f5b2032846a5bc3e4d',
  'a8dc65ca782eda1e05bf225f00d1b46af2abd03024a1590c991ba326b7ac4171',
  'b5f9a3127a4dd2426e6727d55f5feeda90b0403b0d8aab03309cde927fff8620',
  'c94e388654cdce414722392a63ea1aa80d1968ec03667690c6ac74e7516a9b84',
  'cdeb1db9977289fee1ce8cb50e25cd20bb5b9bcfff12b52499705a6d15ba7705',
  'cdeb55257b0d8fa1892edc52925fd1d4cd8039bb641d3ca2a116b009e25f7403',
  'cf3cecf1524514b3387818fa7a7819bb3f1ed611fffb0fdbeac6571b0d42137c',
  'd18c429107283849cd694647838efde33309c2923b2630772cfbfb179440c357',
  'd701240627426484d07c05b1970c47a733737b39cf098d23d96b413056f76c28',
  'dd995ccfc08c9ff428ef39faaba45d558e15c5401764b2d120a2abc2f13f9a1c',
  'e451b3fb639848c61ba2224fe1c4fa5638714400eec90e31dd3a8a9e1bc66801',
  'f56e14bd886372f92f2bab793ba36e936eabd2b509e778e3d37b0b38d8a0ad84',
]);

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** هل النصّ افتراضيُّ هذا النوع اليوم، أو افتراضيٌّ سابقٌ حُفظ مروراً؟ */
export async function isDefaultPrompt(key: string, prompt: string | null | undefined): Promise<boolean> {
  const text = prompt?.trim();
  if (!text) return true;
  if (text === systemPromptFor(key).trim()) return true;
  // البصمة على النوع والنصّ معاً: افتراضيُّ نوعٍ لا يُعدّ افتراضياً لنوعٍ آخر.
  return LEGACY_DEFAULT_PROMPTS.has(await sha256Hex(`${key}\n${text}`));
}

/** الإعداد كما يُحفظ: بلا برومبت إن كان افتراضياً، فيتبع الافتراضيَّ إن تغيّر. */
export async function storedConfig(key: string, config: ConsultConfig): Promise<Omit<ConsultConfig, 'system_prompt'> & { system_prompt?: string }> {
  if (!(await isDefaultPrompt(key, config.system_prompt))) return config;
  const { system_prompt: _omit, ...rest } = config;
  return rest;
}

// الإعداد الفعّال: تجاوز الإدارة إن وُجد، وإلا الافتراضي
export async function getEffectiveConfig(env: Env, key: string): Promise<ConsultConfig> {
  const row = await env.DB.prepare('SELECT config_json FROM consultation_configs WHERE key = ?')
    .bind(key)
    .first<{ config_json: string }>();
  if (row?.config_json) {
    try {
      const parsed = JSON.parse(row.config_json);
      const merged = { ...defaultConfig(key), ...parsed, key };
      /* تجاوزٌ بلا برومبت لا يعني «بلا برومبت».

         البرومبت الافتراضي يحمل قيود الإسناد وسطر إخلاء المسؤولية (§٤).
         ومحوُه من شاشة الإدارة — أو حفظُ إعدادٍ يحمل `null` مكانه — كان
         يُخرج مسوّدات قانونية بلا هذه القيود، ويُرسل `system` فارغاً
         يردّه الـAPI بـ400. فالفارغ يعود إلى الافتراضي. */
      if (await isDefaultPrompt(key, merged.system_prompt)) merged.system_prompt = systemPromptFor(key);
      return merged;
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

// ── أسلوب المخرَج وتنسيقه: تعليمةٌ واحدة تُلحق بتوجيه كل الأنواع ──

export const OUTPUT_STYLE_KEY = 'output_style_prompt';

/** ما حفظته الإدارة، أو `null` حين يسري الافتراضي. */
export async function loadOutputStyleTemplate(env: Env): Promise<string | null> {
  try {
    const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?')
      .bind(OUTPUT_STYLE_KEY)
      .first<{ value: string }>();
    const text = row?.value?.trim();
    return text && text !== DEFAULT_OUTPUT_STYLE.trim() ? text : null;
  } catch (e: any) {
    console.error('output style load failed:', e?.message ?? e);
    return null;
  }
}

/** التعليمة كما تُلحق بالتوجيه — باسم الشركة من الإعدادات. */
export async function getOutputStyle(env: Env): Promise<string> {
  const [firm, template] = await Promise.all([loadFirmName(env), loadOutputStyleTemplate(env)]);
  return outputStyleInstruction(firm, template);
}
