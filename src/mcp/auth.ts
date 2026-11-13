/**
 * من يطلب من خادم MCP — رمزُ `Authorization: Bearer`.
 *
 * الرمز يصدر عن خادم التفويض في `mcp/oauth.ts` بعد دخول العضو من المركز أو
 * الضيف برمز التحقق، ويُقرأ هنا مجزّأً. وصاحبُه يُفحص في كل طلب — العضو
 * بـ`members.is_active`، والضيف ببقاء بريده — فلا يكفي أن يكون الرمز سارياً.
 */
import type { Env } from '../types';
import type { McpPrincipal } from './protocol';
import { principalFromToken } from './oauth';

export async function authenticateMcp(env: Env, req: Request): Promise<McpPrincipal | null> {
  const header = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/i.exec(header.trim());
  if (!m) return null;
  return principalFromToken(env, m[1]);
}
