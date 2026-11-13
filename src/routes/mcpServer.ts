/**
 * نقطة خادم MCP — `/mcp`.
 *
 * مُركَّبةٌ في `src/index.ts` **قبل** وسيط الدخول الموحّد، كـ`/auth/mcp`: من
 * يطلبها أداةٌ على خادم صاحبها لا متصفّحٌ بكوكي جلسة، فلو مرّت بالوسيط لحُوِّلت
 * إلى صفحة الدخول. وحارسُها رمزُ `Bearer` يقرؤه `mcp/auth.ts`، وبلا رمزٍ صالح
 * تُردّ ٤٠١ بتحدّيها ولا يُقرأ شيء.
 *
 * ولا يمرّ بها حدُّ المعدّل على `/api/*`: قرارُ صاحب المنصة أن السقف مفتوح —
 * لا كلفة نماذج على المنصة، ومن يربط معروفٌ لها.
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { handleMcpRequest } from '../mcp/protocol';
import { readTools } from '../mcp/tools';
import { authenticateMcp } from '../mcp/auth';
import { MCP_INSTRUCTIONS } from '../mcp/instructions';

const app = new Hono<{ Bindings: Env }>();

app.all('/mcp', (c) => {
  const origin = new URL(c.req.url).origin;
  return handleMcpRequest(c.req.raw, {
    serverInfo: { name: 'naf-legal', title: c.env.APP_NAME || 'مستشار ناف', version: '1.0.0' },
    instructions: MCP_INSTRUCTIONS,
    tools: readTools(c.env),
    authenticate: (req) => authenticateMcp(c.env, req),
    resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
  });
});

export default app;
