/**
 * سجلّ المصادر الخارجية — قراءةُ الصفوف وحلُّ رموزها.
 *
 * الفصل مقصود: هذا الملف يعرف **ما المصادر**، و`lib/mcp.ts` يعرف **كيف تُنادى**،
 * و`lib/external.ts` يعرف **كيف يُقرأ ردُّها**. فخادمٌ جديد لا يمسّ إلا صفّاً،
 * وبروتوكولٌ يتغيّر لا يمسّ إلا ملفاً.
 */
import type { Env } from '../types';

export type SourceRole = 'fiqh' | 'legal';

export interface ExternalSource {
  id: string;
  label: string;
  kind: 'mcp';
  endpoint: string | null;
  role: SourceRole;
  enabled: boolean;
  searchTool: string;
  /** معاملاتٌ ثابتة تُدمج مع الاستعلام — تُضيّق نطاق خادمٍ واسع بلا كود. */
  args: Record<string, unknown>;
  /** اسم الحقل الذي يُوضع فيه نصُّ الاستعلام: `q` في تراث، `query` في الشاملة. */
  queryField: string;
  /** اسم حقل السقف إن كان للأداة سقف — و`null` يعني: لا تُرسل سقفاً. */
  limitField: string | null;
  maxResults: number;
  timeoutMs: number;
  tokenKey: string | null;
  lastChecked?: number | null;
  lastStatus?: string | null;
  lastError?: string | null;
}

interface Row {
  id: string;
  label: string;
  kind: string;
  endpoint: string | null;
  role: string;
  enabled: number;
  search_tool: string;
  args_json: string;
  query_field: string;
  limit_field: string | null;
  max_results: number;
  timeout_ms: number;
  token_key: string | null;
  last_checked: number | null;
  last_status: string | null;
  last_error: string | null;
}

function toSource(r: Row): ExternalSource {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(r.args_json || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
  } catch {
    // معاملاتٌ مشوَّهة لا تُعطِّل المصدر: يُنادى بلا تضييق، والاستعلام وحده
    // يحمل المعنى. وإسقاطُ المصدر لفاصلةٍ ناقصة أسوأ من نتائجَ أوسع.
  }
  return {
    id: r.id,
    label: r.label,
    kind: 'mcp',
    endpoint: r.endpoint,
    role: r.role === 'legal' ? 'legal' : 'fiqh',
    enabled: r.enabled === 1,
    searchTool: r.search_tool,
    args,
    queryField: r.query_field || 'q',
    limitField: r.limit_field || null,
    maxResults: r.max_results,
    timeoutMs: r.timeout_ms,
    tokenKey: r.token_key,
    lastChecked: r.last_checked,
    lastStatus: r.last_status,
    lastError: r.last_error,
  };
}

const SELECT = `SELECT id, label, kind, endpoint, role, enabled, search_tool, args_json,
                       query_field, limit_field, max_results, timeout_ms, token_key,
                       last_checked, last_status, last_error
                FROM external_sources`;

/** كلُّ المصادر — للوحة الإدارة. */
export async function listSources(env: Env): Promise<ExternalSource[]> {
  const rs = await env.DB.prepare(`${SELECT} ORDER BY role, id`).all<Row>();
  return (rs.results ?? []).map(toSource);
}

export async function getSource(env: Env, id: string): Promise<ExternalSource | null> {
  const row = await env.DB.prepare(`${SELECT} WHERE id = ?`).bind(id).first<Row>();
  return row ? toSource(row) : null;
}

/**
 * المصادر الصالحة للنداء الآن.
 *
 * ومعطَّلٌ أو بلا عنوان لا يُنادى: الجدول يولد بصفّين بلا عنوان عمداً، فلو لم
 * يُرشَّح هنا لبدأ كلُّ استعلامٍ بمحاولتي اتصالٍ فاشلتين.
 */
export async function enabledSources(env: Env, role?: SourceRole): Promise<ExternalSource[]> {
  const sql = role
    ? `${SELECT} WHERE enabled = 1 AND endpoint IS NOT NULL AND endpoint != '' AND role = ? ORDER BY id`
    : `${SELECT} WHERE enabled = 1 AND endpoint IS NOT NULL AND endpoint != '' ORDER BY id`;
  const stmt = role ? env.DB.prepare(sql).bind(role) : env.DB.prepare(sql);
  const rs = await stmt.all<Row>();
  return (rs.results ?? []).map(toSource);
}

/**
 * رمزُ المصدر من السرّ `MCP_TOKENS` — أو `null` لخادمٍ لا يطلب رمزاً.
 *
 * سرٌّ واحد بخريطة JSON لا سرٌّ لكل مصدر: `Env` نوعٌ مكتوب، فمصدرٌ جديد كان
 * سيقتضي حقلاً جديداً فيه ونشراً جديداً — وهو عكس المقصود من الجدول.
 *
 * وتشوّهُ السرّ يُسجَّل: مصدرٌ يطلب رمزاً فلا يجده يعود ٤٠١، وسببُها في
 * الخريطة لا في المصدر.
 */
export function tokenFor(env: Env, source: ExternalSource): string | null {
  if (!source.tokenKey) return null;
  if (!env.MCP_TOKENS) return null;
  try {
    const map = JSON.parse(env.MCP_TOKENS);
    const token = map?.[source.tokenKey];
    return typeof token === 'string' && token ? token : null;
  } catch (e) {
    console.error('MCP_TOKENS is not valid JSON:', e instanceof Error ? e.message : e);
    return null;
  }
}

/** يُقيّد نتيجة الفحص في الصفّ — فيُقرأ سببُ التعذّر في الشاشة لا في السجلّات. */
export async function recordCheck(
  env: Env,
  id: string,
  status: string,
  error?: string | null
): Promise<void> {
  await env.DB.prepare(
    'UPDATE external_sources SET last_checked = ?, last_status = ?, last_error = ?, updated_at = ? WHERE id = ?'
  )
    .bind(Date.now(), status, error ?? null, Date.now(), id)
    .run();
}
