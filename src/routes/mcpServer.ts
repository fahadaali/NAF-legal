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
import { conversationTools } from '../mcp/conversations';
import { authenticateMcp } from '../mcp/auth';
import { MCP_INSTRUCTIONS } from '../mcp/instructions';

const app = new Hono<{ Bindings: Env }>();

/**
 * CORS مفتوح: الحارس رمز `Bearer` لا كوكي، فالطلب من متصفّحٍ أجنبيّ لا يحمل
 * ما لا يحمله طلبٌ مباشر. وهو ما يجعل مُفتّش MCP وأمثاله يعملون من المتصفّح،
 * ويقرؤون تحدّي ٤٠١ (`expose-headers`) فيبدؤون التفويض.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name, last-event-id',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id',
  'access-control-max-age': '86400',
};

app.options('/mcp', () => new Response(null, { status: 204, headers: CORS }));

app.all('/mcp', async (c) => {
  const origin = new URL(c.req.url).origin;
  const res = await handleMcpRequest(c.req.raw, {
    serverInfo: { name: 'naf-legal', title: c.env.APP_NAME || 'مستشار ناف', version: '1.0.0' },
    instructions: MCP_INSTRUCTIONS,
    tools: [...readTools(c.env), ...conversationTools(c.env)],
    authenticate: (req) => authenticateMcp(c.env, req),
    resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
  });
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
});

export default app;
