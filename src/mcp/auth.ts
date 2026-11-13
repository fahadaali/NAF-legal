/**
 * من يطلب من خادم MCP — رمزُ `Authorization: Bearer`.
 *
 * **المرحلة الأولى: لا رمز يصلح بعد.** الرموز تصدر عن خادم التفويض (OAuth 2.1)
 * في المرحلة الثانية، بعد دخول العضو من المركز أو الضيف برمز التحقق، وتُخزَّن
 * مجزّأةً في D1. وإلى أن يُبنى ذلك يُرفض كلُّ طلبٍ بـ٤٠١ وتحدّيه — فالنقطة
 * منشورةٌ ولا تعطي أحداً شيئاً، ولا تُفتح الأنظمة لمن لا هوية له ولو يوماً.
 */
import type { Env } from '../types';
import type { McpPrincipal } from './protocol';

export async function authenticateMcp(_env: Env, _req: Request): Promise<McpPrincipal | null> {
  return null;
}
