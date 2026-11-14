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
  check('أدوات المحادثات الأربع لمن يكتب وحده (لا الضيف ولا القارئ)', (conv.match(/visibleTo: canWrite/g) ?? []).length === 4 && /p\.kind === 'member' && p\.role !== 'viewer'/.test(conv));
  const reads = conv.match(/FROM conversations[^`'"]*/g) ?? [];
  check('كلُّ قراءةٍ للمحادثات مقيّدةٌ بصاحبها', reads.length > 0 && reads.every((q) => /user_id = \?/.test(q)), reads.join(' | '));
  check('ولا تُمحى رسالةٌ ولا تُعدَّل', !/DELETE FROM messages|UPDATE messages/.test(conv));
  const convReads = conv.match(/FROM conversations\s+WHERE[^`]*/g) ?? [];
  check('ومحادثاتُ القضايا خارج الأداة في كل قراءة', convReads.length >= 3 && convReads.every((q) => q.includes('${NOT_CASE}')), convReads.join(' | '));
  check('والردّ المحفوظ يدخل سجلّ النُّسخ', /INSERT INTO draft_versions/.test(conv));
  check('وسقفُ قراءة المحادثة دون حدّ الأدوات', /READ_CHARS_MAX = 50_000/.test(conv));

  check('سقفا الضيف على الضيف لا على الطلب', /mcp_guest_throttle/.test(oauth) && /GUEST_FAILS_PER_WINDOW/.test(oauth));
  check('ومحاولةُ الرمز تُعدّ ذرّياً قبل المقارنة', /attempts = attempts \+ 1 WHERE request_id = \? AND attempts < \? RETURNING/.test(oauth));
  check('وإعادةُ رمز التجديد في المهلة لا تُلغي الربط', /REFRESH_RETRY_GRACE/.test(oauth));
  check('والأدوات المهجورة تُكنس', /DELETE FROM mcp_clients WHERE created_at < \?/.test(oauth));

  const authSrv = readFileSync(new URL('../src/routes/mcpAuthServer.ts', import.meta.url), 'utf8');
  check('أبواب التفويض العامّة تحت حدّ معدّل', ['/oauth/register', '/oauth/authorize', '/oauth/connect/*'].every((r) => authSrv.includes(`app.use('${r}', limited)`)));
  const connRoutes = readFileSync(new URL('../src/routes/mcpConnections.ts', import.meta.url), 'utf8');
  check('«مربوط» ما دام رمز التجديد حيّاً', /LIVE_SQL/.test(connRoutes) && /t\.kind = 'refresh'/.test(connRoutes));
  check('وحذفُ الضيف دفعةٌ واحدة', !/for \(const r of conns/.test(connRoutes));

  const toolsSrc = readFileSync(new URL('../src/mcp/tools.ts', import.meta.url), 'utf8');
  const related = toolsSrc.slice(toolsSrc.indexOf("name: 'get_related_articles'"), toolsSrc.indexOf("name: 'get_definitions'"));
  check('إحالاتُ المادة المحجوبة لا تُكشف', /getChunkById\(env, base\)/.test(related));
  check('الملغاة تُعرف بحالها لا بـ`isRepealed` وحده', /function isRepealedHit[\s\S]{0,200}RETRIEVAL_REPEALED/.test(toolsSrc) && !/h\.isRepealed && 'ملغاة'/.test(toolsSrc));
  check('وكلُّ مادةٍ تصل بسطور حالها', /const status = statusLines\(h\)/.test(toolsSrc));
  check('والملغاة المحجوبة يُذكر عددُها في البحث والتصفّح والفهرس', (toolsSrc.match(/غير المعروضة هنا/g) ?? []).length === 3);
  check('وألفاظُ الحال المسجّلة (§٣)', ['نظام لاغٍ', 'لم يبدأ العمل به — من', 'تُلغى في', 'مستبقاة بعد إلغاء النظام', 'الرقم السابق'].every((t) => toolsSrc.includes(t)));
  const instr = readFileSync(new URL('../src/mcp/instructions.ts', import.meta.url), 'utf8');
  check('والتعليمات تشرح الأحوال وطريق النصوص السابقة', /include_repealed: true/.test(instr) && /get_article_amendment/.test(instr) && /لم يبدأ العمل به/.test(instr));
  const browse = toolsSrc.slice(toolsSrc.indexOf("name: 'browse_law_articles'"), toolsSrc.indexOf("name: 'get_article_amendment'"));
  check('التصفّح لا يُظهر ما ينتظر المراجعة', (browse.match(/includeDefective: false/g) ?? []).length === 2);
  check('وإحصاءُ النظام بالمادة لا بالمقطع', /lawArticleStats\(env, lawId\)/.test(toolsSrc) && !/الموادّ: \$\{l\.effective\}/.test(toolsSrc));
  const amend = toolsSrc.slice(toolsSrc.indexOf("name: 'get_article_amendment'"), toolsSrc.indexOf("name: 'get_law_changes'"));
  check('النصُّ السابق من مواضعه الثلاثة، والتصحيحُ ليس نصّاً سابقاً', /a\.events/.test(amend) && /legal_chunk_versions/.test(amend) && /change_kind <> 'correction'/.test(amend));
  check('ويُقال صراحةً حين لا يحفظ السجلّ نصّاً سابقاً', /لا يحفظ سجلُّ المنصة نصّاً سابقاً/.test(amend));
  const instr2 = readFileSync(new URL('../src/mcp/instructions.ts', import.meta.url), 'utf8');
  check('والصياغةُ النهائية نظيفة، والنافذُ بلا إشارة', /صياغةٍ نهائية/.test(instr2) && /النافذ لا يحتاج إشارةً/.test(instr2));
  const lawStateFn = toolsSrc.slice(toolsSrc.indexOf('function lawState'), toolsSrc.indexOf('function isRepealedHit'));
  check('حالُ النظام محسوبٌ لا منقول: لا يُعاد لفظُ البطاقة المحفوظ', !/law_status\b/.test(lawStateFn.replace(/\/\*[\s\S]*?\*\//g, '')) && /return 'نافذ'/.test(lawStateFn));
  check('ونظامٌ فيه موادُّ مستبقاة لاغٍ وإن لم يُرفع علمُ إلغائه', /if \(l\.kept_after_repeal\) return 'نظام لاغٍ/.test(lawStateFn));
  const legalSrc = readFileSync(new URL('../src/lib/legal.ts', import.meta.url), 'utf8');
  check('وعلمُ إلغاء النظام يُرفع بعد كل استيرادٍ فيه مستبقاة', /await markLawsWithKeptRepealed\(env, rows\.map/.test(legalSrc));
  check('وشرطُ السريان لا يقرأ علمَ إلغاء النظام — المستبقاة نافذة', !/law_repealed/.test(legalSrc.slice(legalSrc.indexOf('const EFFECTIVE_SQL'), legalSrc.indexOf('const EFFECTIVE_SQL') + 220)));
  const srv = readFileSync(new URL('../src/routes/mcpServer.ts', import.meta.url), 'utf8');
  check('شعارُ ناف في هويّة الخادم', /icons: \[/.test(srv) && /icon-512\.png/.test(srv) && /websiteUrl/.test(srv));
  const idx2 = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  check('وأيقونةُ الموقع قبل الوسيط', idx2.indexOf("'/favicon.ico'") > 0 && idx2.indexOf("'/favicon.ico'") < idx2.indexOf("app.use('*', ssoMiddleware)"));
  check('القوائم الطويلة صفحاتٌ لا كتلة', (toolsSrc.match(/= paginate\(/g) ?? []).length === 1);
  const searchTool = toolsSrc.slice(toolsSrc.indexOf("name: 'search_regulations'"), toolsSrc.indexOf("name: 'get_article'"));
  check('البحث صفحاتٌ بـoffset إلى عمق المحرّك', /offset: \{ type: 'integer'/.test(searchTool) && /limit: SEARCH_DEPTH,/.test(searchTool) && /ranked\.slice\(offset, offset \+ limit\)/.test(searchTool));
  check('وعمقُ المحرّك مئة — سقفُ Vectorize بلا بيانات وصفية', /export const SEARCH_DEPTH = 100;/.test(legalSrc) && /Math\.min\(Math\.max\(opts\.limit \?\? 10, 1\), SEARCH_DEPTH\)/.test(legalSrc) && /returnMetadata: 'none'/.test(legalSrc));
  check('ومرشّحو المنصة كما كانوا (حتى خمسين)', /Math\.max\(Math\.min\(limit \* 4, 50\), limit\)/.test(legalSrc));
  check('وعبارةُ IN للمتجهات على دفعات دون سقف المعاملات', /for \(let i = 0; i < seqs\.length; i \+= IN_CHUNK\)/.test(legalSrc));
  const clauseTool = strip(toolsSrc.slice(toolsSrc.indexOf("name: 'search_clauses'"), toolsSrc.indexOf('function globToRegex')));
  const clauseRoute = strip(readFileSync(new URL('../src/routes/clauses.ts', import.meta.url), 'utf8'));
  check('بحثُ البنود بلا نمط GLOB يرفضه D1 في الكلمة الطويلة — في الأداة والشاشة', !/GLOB/.test(clauseTool) && !/GLOB/.test(clauseRoute) && /arabicMatchSql\(\['title', 'body', 'category'\]/.test(clauseTool) && /arabicMatchSql\(\['title', 'body', 'category'\]/.test(clauseRoute));
  const { arabicMatchSql } = await import('../src/lib/arabic.ts');
  const m = arabicMatchSql(['body'], 'الالتزامات الاتفاقية');
  check('والكلمةُ الطويلة تُطوى كلُّ صورها إلى رؤوسها، مطبَّعة', !!m && ['أ', 'إ', 'آ', 'ٱ', 'ة', 'ى', 'ئ', 'ؤ'].every((ch) => m.sql.includes(`'${ch}'`)) && m.binds.join(' ') === 'الالتزامات الاتفاقيه' && !/GLOB/.test(m.sql), JSON.stringify(m?.binds));
  const short = arabicMatchSql(['body'], 'التعويض');
  check('والمعتادةُ على نمطها كما كانت — بكلفتها', short?.sql === '(body GLOB ?)' && short.binds[0].startsWith('*') && short.binds[0].endsWith('*'), JSON.stringify(short));
  const edge = arabicMatchSql(['b'], 'ب'.repeat(24) + ' ' + 'ب'.repeat(25));
  check('والحدُّ خمسون بايتاً بالضبط: ما بلغه نمط، وما زاد طيّ', /^\(b GLOB \?\) AND \(instr\(replace\(/.test(edge?.sql ?? ''), edge?.sql);
  for (const [name, path] of [['البحث العام', '../src/routes/search.ts'], ['محادثاتُ الأداة', '../src/mcp/conversations.ts']]) {
    const src = strip(readFileSync(new URL(path, import.meta.url), 'utf8'));
    check(`و${name} بالمطابقة نفسها، بلا نمطٍ يُبنى في موضعه`, /arabicMatchSql\(/.test(src) && !/GLOB/.test(src) && !/arabicGlobPatterns/.test(src));
  }
  check('ومكتبةُ البنود صفحاتٌ من القاعدة لا خمسمئةٌ مقصوصة', !/LIMIT 500/.test(toolsSrc) && /FROM clauses\$\{whereSql\} ORDER BY category, title, id LIMIT \? OFFSET \?/.test(toolsSrc));
  check('وأرشيفُ النصوص السابقة لا يقف عند عشرين', !/LIMIT 20`/.test(amend) && /ARCHIVE_MAX \+ 1/.test(amend));
  check('والمحادثةُ الطويلة تُقرأ كلُّها بـskip_latest', /skip_latest/.test(conv) && /const last = msgs\.length - 1 - skip/.test(conv));
  check('والردُّ المحفوظ يحمل مئتي مصدر، تُقرأ دفعاتٍ', /const CITES_MAX = 200;/.test(conv) && /getChunksByIds\(env, unique, true\)/.test(conv) && !/getChunkById\(/.test(conv));
  check('وما زاد على سقف المصادر يُقال لا يسقط صامتاً', /dropped/.test(conv) && /نصُّ الإجابة محفوظٌ كاملاً/.test(conv));
  check('ولا تنادي نموذج المنصة', !/callClaude|lib\/claude|logUsage/.test(conv));

  const fiqh = strip(readFileSync(new URL('../src/mcp/fiqh.ts', import.meta.url), 'utf8'));
  check('كتبُ الفقه للعضو وحده — المصدر مربوطٌ باسم المنصة', /visibleTo: isMember/.test(fiqh) && /const isMember = \(p: McpPrincipal\) => p\.kind === 'member'/.test(fiqh));
  check('وبالمصادر المفعّلة نفسها ومحوّلها — لا نداءٌ ثانٍ', /enabledSources\(env, 'fiqh'\)/.test(fiqh) && /searchSources\(env, sources, query\)/.test(fiqh) && !/callTool|fetch\(/.test(fiqh));
  check('ومصدرٌ لم يُجب يُقال بلفظه المسجّل، والحاشيةُ للمحقِّق', /تعذّر الوصول إلى المصدر/.test(fiqh) && /كلام المحقِّق لا المؤلِّف/.test(fiqh) && /«التأصيل الفقهي»/.test(fiqh));
  check('ولا تنادي نموذج المنصة، وللقراءة', !/callClaude|lib\/claude|logUsage/.test(fiqh) && /readOnly: true/.test(fiqh) && !/readOnly: false/.test(fiqh));
  check('ومركّبةٌ في الخادم', /\.\.\.fiqhTools\(c\.env\)/.test(srv));
  check('أدواتُ القراءة تذكّر العضو بالحفظ — لا أدوات المحادثات', /\.\.\.withSaveReminder\(\[\.\.\.readTools\(c\.env\), \.\.\.fiqhTools\(c\.env\)\]\), \.\.\.conversationTools\(c\.env\)/.test(srv));
  check('والتذكير لمن يكتب وحده، ولا في ردٍّ رافض', /canWrite\(p\) && !r\.isError \?/.test(conv) && /export const SAVE_REMINDER/.test(conv));
  const connect = readFileSync(new URL('../web/src/components/Connect.tsx', import.meta.url), 'utf8');
  check('وإذنُ العضو يذكرها بلفظ §١٥، والضيف على حاله', connect.includes('ومكتبة البنود وكتب الفقه في المصادر الخارجية، وتقرأ محادثاتك') && connect.includes("guestCan: 'ستبحث الأداة في الأنظمة واللوائح وتصنيفاتها ومكتبة البنود. لا يُحفظ شيءٌ في المنصة.'"));
  check('والتعليمات تفصل التأصيل عن السند', /التأصيل الفقهي — إن كانت أداة search_fiqh_sources/.test(instr2) && /قسمٍ ختاميّ وحده عنوانه «التأصيل الفقهي»/.test(instr2));
}

console.log(failed ? `\n${failed} فحصاً فشل` : '\nسليم');
process.exit(failed ? 1 : 0);
