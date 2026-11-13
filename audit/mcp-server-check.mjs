/**
 * فحصُ خادم MCP — سلوكاً لا نصّاً.
 *
 * مقابلُ `audit/mcp-client-check.mjs`: ذاك يشغّل العميل على خادمٍ صوريّ، وهذا
 * يشغّل الخادم (`src/mcp/protocol.ts`) بأدواتٍ ومصادقةٍ صورية. وما يُخشى هنا
 * ليس غياب سطر بل سلوكٌ: أداةٌ يراها الضيف وهي للأعضاء، أو طلبٌ بلا رمز يصل
 * إلى أداة، أو استثناءٌ في أداةٍ يُسقط الاتصال بدل أن يُقال.
 *
 * وفحوصٌ ثابتة بعدها على التركيب: النقطة قبل وسيط الدخول، وأدوات القراءة لا
 * تنادي نموذجاً ولا تكتب.
 *
 * لا شبكة ولا قاعدة ولا مفتاح.
 *
 *   node audit/mcp-server-check.mjs     (أو: npm run check:mcp-server)
 */
import { readFileSync } from 'node:fs';
import { handleMcpRequest, SUPPORTED_PROTOCOL_VERSIONS } from '../src/mcp/protocol.ts';

let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const MEMBER = { kind: 'member', userId: 'u1', memberId: 'sub1', role: 'editor', name: 'م', clientName: 'Claude', tokenId: 't1' };
const GUEST = { kind: 'guest', guestId: 'g1', email: 'g@x.test', clientName: 'ChatGPT', tokenId: 't2' };

const calls = [];
const deps = {
  serverInfo: { name: 'naf-legal', title: 'مستشار ناف', version: '1.0.0' },
  instructions: 'تعليمات',
  resourceMetadataUrl: 'https://advisor.test/.well-known/oauth-protected-resource/mcp',
  authenticate: async (req) => {
    const a = req.headers.get('authorization');
    if (a === 'Bearer member') return MEMBER;
    if (a === 'Bearer guest') return GUEST;
    return null;
  },
  onToolCall: (p, tool, ok) => calls.push({ kind: p.kind, tool, ok }),
  tools: [
    { name: 'read_x', title: 'ق', description: 'd', inputSchema: { type: 'object' }, readOnly: true,
      run: async (args) => ({ text: `قرأت ${args.q ?? ''}` }) },
    { name: 'save_x', title: 'ح', description: 'd', inputSchema: { type: 'object' }, readOnly: false,
      visibleTo: (p) => p.kind === 'member', run: async () => ({ text: 'حُفظ' }) },
    { name: 'boom', title: 'ع', description: 'd', inputSchema: { type: 'object' }, readOnly: true,
      run: async () => { throw new Error('db down'); } },
    { name: 'refuse_x', title: 'ر', description: 'd', inputSchema: { type: 'object' }, readOnly: true,
      run: async () => ({ text: 'مرفوض', isError: true }) },
  ],
};

const post = (body, token = 'member', extra = {}) =>
  handleMcpRequest(
    new Request('https://advisor.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    deps
  );
const rpc = (method, params, token) => post({ jsonrpc: '2.0', id: 1, method, params }, token);

console.log('المصادقة');
{
  const r = await rpc('tools/list', {}, null);
  const wa = r.headers.get('www-authenticate') ?? '';
  check('بلا رمز ← ٤٠١', r.status === 401);
  check('والتحدّي يدلّ على وثيقة الموارد', wa.includes(`resource_metadata="${deps.resourceMetadataUrl}"`), wa);
  check('ولا يقول invalid_token لمن لم يرسل رمزاً', !wa.includes('invalid_token'));
  const bad = await rpc('tools/list', {}, 'forged');
  check('رمزٌ لا يصلح ← ٤٠١ مع invalid_token', bad.status === 401 && (bad.headers.get('www-authenticate') ?? '').includes('invalid_token'));
  const noAuthBody = await post('{not json', null);
  check('المصادقة قبل تحليل الجسم (جسمٌ فاسد بلا رمز ← ٤٠١ لا ٤٠٠)', noAuthBody.status === 401);
}

console.log('النقل');
{
  const g = await handleMcpRequest(new Request('https://advisor.test/mcp', { method: 'GET', headers: { authorization: 'Bearer member' } }), deps);
  check('GET ← ٤٠٥ (لا مجرى من الخادم)', g.status === 405 && g.headers.get('allow') === 'POST');
  const d = await handleMcpRequest(new Request('https://advisor.test/mcp', { method: 'DELETE', headers: { authorization: 'Bearer member' } }), deps);
  check('DELETE ← ٤٠٥ (لا جلسة تُنهى)', d.status === 405);
  const n = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  check('الإشعار ← ٢٠٢ بلا جسم', n.status === 202 && (await n.text()) === '');
  const p = await post('{not json');
  check('جسمٌ فاسد ← ٤٠٠ Parse error', p.status === 400 && (await p.json()).error?.code === -32700);
  const b = await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
  check('الدفعة ← ٤٠٠ (أُسقطت من المواصفة)', b.status === 400);
  const resp = await post({ jsonrpc: '2.0', id: 9, result: {} });
  check('ردُّ العميل على طلبٍ لم يُرسل ← ٢٠٢', resp.status === 202);
  const ct = (await rpc('ping', {})).headers.get('content-type') ?? '';
  check('الردّ JSON لا مجرى', ct.startsWith('application/json'));
}

console.log('المصافحة');
{
  const known = await (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } })).json();
  check('مراجعةٌ مدعومة تُعاد كما طُلبت', known.result?.protocolVersion === '2025-06-18');
  const unknown = await (await rpc('initialize', { protocolVersion: '1999-01-01' })).json();
  check('ومراجعةٌ لا تُعرف تُجاب بالأحدث', unknown.result?.protocolVersion === SUPPORTED_PROTOCOL_VERSIONS[0]);
  check('والتعليمات والأدوات في القدرات', unknown.result?.instructions === 'تعليمات' && !!unknown.result?.capabilities?.tools);
  const noInit = await (await rpc('tools/list', {})).json();
  check('ولا مصافحة لازمة قبل الأدوات (بلا جلسة)', Array.isArray(noInit.result?.tools));
}

console.log('الأدوات');
{
  const m = (await (await rpc('tools/list', {}, 'member')).json()).result.tools.map((t) => t.name);
  const g = (await (await rpc('tools/list', {}, 'guest')).json()).result.tools.map((t) => t.name);
  check('العضو يرى أداة الكتابة', m.includes('save_x'));
  check('والضيف لا يراها أصلاً', !g.includes('save_x') && g.includes('read_x'));
  const gs = await (await rpc('tools/call', { name: 'save_x', arguments: {} }, 'guest')).json();
  check('ونداؤها من الضيف ← «أداة غير معروفة» لا «ممنوع»', gs.error?.code === -32602 && /Unknown tool/.test(gs.error?.message));
  const listed = (await (await rpc('tools/list', {}, 'member')).json()).result.tools;
  const save = listed.find((t) => t.name === 'save_x');
  const read = listed.find((t) => t.name === 'read_x');
  check('تلميحات القراءة والكتابة', read.annotations.readOnlyHint === true && save.annotations.readOnlyHint === false && save.annotations.destructiveHint === false);
  const r = await (await rpc('tools/call', { name: 'read_x', arguments: { q: 'نص' } })).json();
  check('النداء يردّ كتلة نصّ', r.result?.content?.[0]?.text === 'قرأت نص' && r.result.isError === false);
  const boom = await (await rpc('tools/call', { name: 'boom', arguments: {} })).json();
  check('استثناءُ الأداة ← isError لا خطأ بروتوكول', boom.result?.isError === true && !boom.error);
  check('ولا يتسرّب نصُّ الاستثناء', !JSON.stringify(boom).includes('db down'));
  const ref = await (await rpc('tools/call', { name: 'refuse_x', arguments: {} })).json();
  check('رفضُ الأداة ← isError', ref.result?.isError === true);
  const nf = await (await rpc('tools/call', { name: 'nope', arguments: {} })).json();
  check('أداةٌ لا وجود لها ← -32602', nf.error?.code === -32602);
  const um = await (await rpc('sampling/createMessage', {})).json();
  check('طريقةٌ لا تُعرف ← -32601', um.error?.code === -32601);
  const empties = await Promise.all(['resources/list', 'prompts/list'].map(async (mth) => (await (await rpc(mth, {})).json()).result));
  check('قائمتا الموارد والأوامر فارغتان لا خطأ', Array.isArray(empties[0]?.resources) && Array.isArray(empties[1]?.prompts));
  check('كلُّ نداءٍ يُبلَّغ للسجلّ بنتيجته', calls.some((c) => c.tool === 'boom' && !c.ok) && calls.some((c) => c.tool === 'read_x' && c.ok));
}

console.log('التركيب');
{
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const mount = index.indexOf("app.route('/', mcpServerRoutes)");
  const sso = index.indexOf("app.use('*', ssoMiddleware)");
  const rate = index.indexOf("app.use('/api/*'");
  check('النقطة مُركَّبة', mount > 0);
  check('وقبل وسيط الدخول الموحّد', mount > 0 && sso > 0 && mount < sso);
  check('وخارج حدّ المعدّل (السقف مفتوح)', mount < rate);
  const ssoSrc = readFileSync(new URL('../src/lib/sso.ts', import.meta.url), 'utf8');
  check('و`/mcp` في المسارات العامة للوسيط', /PUBLIC_PATHS = \[[^\]]*'\/mcp'/.test(ssoSrc));

  const tools = readFileSync(new URL('../src/mcp/tools.ts', import.meta.url), 'utf8');
  check('أدوات القراءة لا تنادي نموذج المنصة', !/callClaude|lib\/claude|logUsage/.test(tools));
  check('ولا تكتب في القاعدة', !/\b(INSERT|UPDATE|DELETE)\b/.test(tools.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
  check('وكلُّها للقراءة', !/readOnly:\s*false/.test(tools));
  check('ولا تقرأ الجداول السرّية', !/\b(conversations|messages|case_folders|attachments|kb_documents)\b/.test(tools.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
}

console.log('التفويض والمحادثات');
{
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const authMount = index.indexOf("app.route('/', mcpAuthServerRoutes)");
  check('خادم التفويض قبل وسيط الدخول', authMount > 0 && authMount < index.indexOf("app.use('*', ssoMiddleware)"));
  check('وسماحُ العضو خلفه (`/api/mcp`)', /app\.route\('\/api\/mcp', mcpConnectionRoutes\)/.test(index));
  check('وكنسُ المنتهي في نبضة المؤقّت', /purgeMcpExpired\(env\)/.test(index));
  const authLib = readFileSync(new URL('../src/lib/auth.ts', import.meta.url), 'utf8');
  check('القارئ يسمح ويُلغي — مطابقةً تامّة', authLib.includes("'/api/mcp/connect/approve'") && authLib.includes("'/api/mcp/connections/revoke'"));

  const oauth = strip(readFileSync(new URL('../src/mcp/oauth.ts', import.meta.url), 'utf8'));
  check('PKCE بـS256 وحده', oauth.includes("'S256'") && !/'plain'/.test(oauth));
  check('رمز التفويض يُمحى في قراءته', /DELETE FROM mcp_auth_codes WHERE code_hash = \? RETURNING/.test(oauth));
  check('عودة رمز التجديد تُلغي الربط', /refresh_reuse/.test(oauth));
  check('العضو يُفحص بـis_active في كل طلب', /FROM members WHERE user_id = \? AND is_active = 1/.test(oauth));
  check('لا رمز يُخزَّن خاماً', !/INSERT INTO mcp_tokens[^;]*\b(access|refresh)\b,\s*connectionId/.test(oauth) && /await sha256\(access\)/.test(oauth));

  const conv = strip(readFileSync(new URL('../src/mcp/conversations.ts', import.meta.url), 'utf8'));
  check('أداتا الحفظ لمن يكتب وحده', (conv.match(/visibleTo: canWrite/g) ?? []).length === 2 && /p\.role !== 'viewer'/.test(conv));
  check('وأدوات المحادثات للعضو لا الضيف', (conv.match(/visibleTo: (canWrite|isMember)/g) ?? []).length === 4);
  const reads = conv.match(/FROM conversations[^`'"]*/g) ?? [];
  check('كلُّ قراءةٍ للمحادثات مقيّدةٌ بصاحبها', reads.length > 0 && reads.every((q) => /user_id = \?/.test(q)), reads.join(' | '));
  check('ولا تُمحى رسالةٌ ولا تُعدَّل', !/DELETE FROM messages|UPDATE messages/.test(conv));
  check('ولا تنادي نموذج المنصة', !/callClaude|lib\/claude|logUsage/.test(conv));
}

console.log(failed ? `\n${failed} فحصاً فشل` : '\nسليم');
process.exit(failed ? 1 : 0);
