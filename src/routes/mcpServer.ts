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
import { fiqhTools } from '../mcp/fiqh';
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
    serverInfo: {
      name: 'naf-legal',
      title: c.env.APP_NAME || 'مستشار ناف',
      version: '1.0.0',
      /* شعارُ ناف — أيقوناتُ التطبيق نفسها المبنيّة من العلامة المسجّلة
         (`npm run icons`)، من الأصل نفسه وخارج الدخول (`/icons/`). PNG لا SVG:
         الأدوات كلُّها تعرض PNG، وبعضُها لا يعرض SVG. */
      icons: [
        { src: `${origin}/icons/icon-512.png`, mimeType: 'image/png', sizes: ['512x512'] },
        { src: `${origin}/icons/icon-192.png`, mimeType: 'image/png', sizes: ['192x192'] },
      ],
      websiteUrl: origin,
    },
    instructions: MCP_INSTRUCTIONS,
    tools: [...readTools(c.env), ...fiqhTools(c.env), ...conversationTools(c.env)],
    authenticate: (req) => authenticateMcp(c.env, req),
    resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
    /* سجلُّ الاستخدام: من استعمل أيَّ أداةٍ ومتى — للمعرفة لا للمنع (لا سقف).
       سطرٌ واحد في سجلّ العامل يُقرأ في لوحة Cloudflare (`observability` مفعَّل
       في `wrangler.toml`)، فلا جدولَ يُكتب ولا يُقرأ. ويحمل معرّفَ الربط —
       منه يُعرف صاحبه في لوحة الإدارة — لا البريد ولا الاسم. */
    onToolCall: (p, tool, ok) =>
      console.log(JSON.stringify({ event: 'mcp_tool_call', connection: p.tokenId, subject: p.kind, tool, ok })),
  });
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
});

export default app;
