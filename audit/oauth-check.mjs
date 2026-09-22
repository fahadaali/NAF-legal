/**
 * فحصُ مسبار التفويض — سلوكاً لا نصّاً.
 *
 * يُشغّل `discoverAuth` على خوادمَ صوريّة تُقدَّم عبر `fetch` مُبدَّل. و**لا
 * خادمَ حقيقيّ هنا** خلافاً لفحص عميل MCP: المسبار يرفض ما ليس `https`،
 * وخادمُ `node:http` محليٌّ على `http` — فالتبديلُ هو ما يُبقي ذلك الشرط
 * مُختبَراً بدل أن يُخفَّف لأجل الفحص.
 *
 *   node audit/oauth-check.mjs     (أو: npm run check:oauth)
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* شفرةُ العامل تستورد بلا لاحقة (`./sealed`) — وهو الصواب فيها. ومحلّلُ Node
   لا يعرف ذلك، فيُلحق هنا لا هناك: الفحصُ يتكيّف مع الشفرة، ولا تُغيَّر
   الشفرة ليمرّ فحص. ونسخةٌ من الحلّال في `audit/external-adapters-check.mjs`. */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      if (existsSync(`${base}.ts`)) {
        return { url: pathToFileURL(`${base}.ts`).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { discoverAuth } = await import('../src/lib/discover.ts');
const { seal, unseal } = await import('../src/lib/sealed.ts');
const { accessTokenFor, authorizeMachine, forget, pkcePair, scopeFor, startAuthorization, completeAuthorization, refreshWith } =
  await import('../src/lib/oauth.ts');
const { createHash } = await import('node:crypto');

const asked = [];
/** خريطةُ عنوانٍ → ردّ. وما ليس فيها يعود ٤٠٤. */
let routes = new Map();

globalThis.fetch = async (url, init) => {
  const href = typeof url === 'string' ? url : url.toString();
  asked.push(href);
  const hit = routes.get(href);
  if (!hit) return new Response('{}', { status: 404 });
  if (typeof hit === 'function') return hit(init, href);
  return new Response(typeof hit === 'string' ? hit : JSON.stringify(hit), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

const PRM = 'https://res.test/.well-known/oauth-protected-resource/mcp';
const setup = (map) => { routes = new Map(Object.entries(map)); asked.length = 0; };

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

console.log('مسبار التفويض — خوادمُ صوريّة:');

// ── الطريق السعيد: وثيقةُ موارد ثم بياناتٌ على مسار RFC 8414 ──
setup({
  [PRM]: {
    resource: 'https://res.test/mcp',
    authorization_servers: ['https://as.test/tenant1'],
    scopes_supported: ['books.read', 'search'],
  },
  'https://as.test/.well-known/oauth-authorization-server/tenant1': {
    issuer: 'https://as.test/tenant1',
    authorization_endpoint: 'https://as.test/tenant1/authorize',
    token_endpoint: 'https://as.test/tenant1/token',
    registration_endpoint: 'https://as.test/tenant1/register',
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  },
});
let d = await discoverAuth(PRM, 2000);
check('وثيقةُ الموارد تُقرأ', d?.resource === 'https://res.test/mcp' && d.scopesSupported?.length === 2, JSON.stringify(d));
check('★ مسارُ RFC 8414 يُدخل .well-known بين المضيف والمسار',
  d?.metadataUrl === 'https://as.test/.well-known/oauth-authorization-server/tenant1', d?.metadataUrl);
check('نقطتا التفويض والرمز تُقرآن',
  d?.authorizationEndpoint === 'https://as.test/tenant1/authorize' && d?.tokenEndpoint === 'https://as.test/tenant1/token');
check('التسجيلُ الديناميّ يُقرأ ولا يُنبَّه عليه', d?.registrationEndpoint === 'https://as.test/tenant1/register' && d.notes.length === 0, JSON.stringify(d?.notes));

// ── التراجعُ إلى موضع OpenID الأقدم ──
setup({
  [PRM]: { authorization_servers: ['https://as.test/tenant1'] },
  'https://as.test/tenant1/.well-known/openid-configuration': {
    issuer: 'https://as.test/tenant1',
    authorization_endpoint: 'https://as.test/a',
    token_endpoint: 'https://as.test/t',
    code_challenge_methods_supported: ['S256'],
    registration_endpoint: 'https://as.test/r',
  },
});
d = await discoverAuth(PRM, 2000);
check('★ حين يغيب موضعُ 8414 يُجرَّب موضعُ OpenID الملحَق بالمسار',
  d?.metadataUrl === 'https://as.test/tenant1/.well-known/openid-configuration', d?.metadataUrl);
check('والمواضعُ الثلاثة جُرّبت بالترتيب', asked.length === 4, `asked=${asked.length}`);

// ── مُصدِرٌ بلا مسار: الموضعان يتطابقان ولا يُكرَّران ──
setup({
  [PRM]: { authorization_servers: ['https://flat.test'] },
  'https://flat.test/.well-known/oauth-authorization-server': {
    issuer: 'https://flat.test', authorization_endpoint: 'https://flat.test/a',
    token_endpoint: 'https://flat.test/t', code_challenge_methods_supported: ['S256'],
    registration_endpoint: 'https://flat.test/r',
  },
});
d = await discoverAuth(PRM, 2000);
check('مُصدِرٌ بلا مسار يُقرأ من الموضع الجذر', d?.metadataUrl === 'https://flat.test/.well-known/oauth-authorization-server');

// ── التنبيهات: لا تسجيل · لا S256 · مُصدِرٌ مخالف ──
setup({
  [PRM]: { authorization_servers: ['https://as.test/t2'] },
  'https://as.test/.well-known/oauth-authorization-server/t2': {
    issuer: 'https://other.test/t2',
    authorization_endpoint: 'https://as.test/a', token_endpoint: 'https://as.test/t',
    code_challenge_methods_supported: ['plain'],
  },
});
d = await discoverAuth(PRM, 2000);
check('★ غيابُ التسجيل الديناميّ يُقال صراحةً',
  d?.registrationEndpoint === null && d.notes.some((n) => n.includes('لا تسجيل ديناميّ')), JSON.stringify(d?.notes));
check('★ وغيابُ S256 يُقال', d?.notes.some((n) => n.includes('S256')), JSON.stringify(d?.notes));
check('★ ومُصدِرٌ يخالف ما سمّته الوثيقة يُقال', d?.notes.some((n) => n.includes('يخالف')), JSON.stringify(d?.notes));

// ── خوادمُ متعدّدة ──
setup({
  [PRM]: { authorization_servers: ['https://a1.test', 'https://a2.test'] },
  'https://a1.test/.well-known/oauth-authorization-server': {
    issuer: 'https://a1.test', token_endpoint: 'https://a1.test/t',
    registration_endpoint: 'https://a1.test/r', code_challenge_methods_supported: ['S256'],
  },
});
d = await discoverAuth(PRM, 2000);
check('خوادمُ متعدّدة: يُقرأ الأول ويُقال إنها متعدّدة',
  d?.issuer === 'https://a1.test' && d.notes.some((n) => n.includes('متعدّدة')), JSON.stringify(d?.notes));

// ── حالاتُ التعذّر — ولا واحدةَ منها ترمي ──
setup({ [PRM]: { resource: 'https://res.test/mcp' } });
d = await discoverAuth(PRM, 2000);
check('وثيقةٌ بلا خادم تفويض: تُردّ مع تنبيه ولا تُجلَب بيانات',
  d !== null && d.authorizationServers.length === 0 && d.notes.some((n) => n.includes('لا تسمّي')) && asked.length === 1, JSON.stringify(d));

setup({ [PRM]: { authorization_servers: ['https://gone.test'] } });
d = await discoverAuth(PRM, 2000);
check('بياناتٌ متعذّرة: تُعرض الوثيقة ويُقيَّد ما جُرّب',
  d?.authorizationServers.length === 1 && d.notes.some((n) => n.includes('تعذّرت بيانات')), JSON.stringify(d?.notes));

setup({});
d = await discoverAuth(PRM, 2000);
check('وثيقةٌ غائبة → null', d === null, JSON.stringify(d));

setup({ [PRM]: '{ليست JSON' });
d = await discoverAuth(PRM, 2000);
check('وثيقةٌ ليست JSON → null ولا ترمي', d === null, JSON.stringify(d));

setup({ [PRM]: { authorization_servers: 'https://single.test' } });
check('حقلٌ مفردٌ مكان مصفوفة يُقبل', (await discoverAuth(PRM, 2000))?.authorizationServers[0] === 'https://single.test');

setup({ [PRM]: { resource: 42, authorization_servers: [7, null], scopes_supported: 'read' } });
d = await discoverAuth(PRM, 2000);
check('★ حقولٌ مشوَّهة الأنواع لا ترمي', d !== null && d.resource === undefined && d.authorizationServers.length === 0, JSON.stringify(d));

setup({ [PRM]: { x: 'y' } });
check('★ عنوانٌ على http يُرفض قبل الجلب', (await discoverAuth('http://res.test/prm', 2000)) === null && asked.length === 0, `asked=${asked.length}`);

setup({ [PRM]: JSON.stringify({ resource: 'x'.repeat(300 * 1024) }) });
check('★ وثيقةٌ أكبر من الحدّ تُرفض', (await discoverAuth(PRM, 2000)) === null);

setup({ [PRM]: () => { throw new Error('انقطع'); } });
check('انقطاعُ الشبكة لا يرمي', (await discoverAuth(PRM, 2000)) === null);

// ── الأصل: الوثيقة تُتبَع على أصل المصدر وحده ──
setup({ [PRM]: { authorization_servers: ['https://as.test'] } });
check('★ وثيقةٌ على أصل المصدر تُتبَع',
  (await discoverAuth(PRM, 2000, 'https://res.test/mcp')) !== null && asked.length > 0);

setup({ [PRM]: { authorization_servers: ['https://as.test'] } });
check('★ ووثيقةٌ على أصلٍ آخر لا تُتبَع أصلاً — ولا طلبَ يُرسَل',
  (await discoverAuth(PRM, 2000, 'https://other.test/mcp')) === null && asked.length === 0,
  `asked=${asked.length}`);

// تحويلةٌ إلى أصلٍ آخر: المنعُ لا يُلتفّ عليه بـ٣٠٢
setup({
  [PRM]: () => {
    const r = new Response(JSON.stringify({ authorization_servers: ['https://as.test'] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    Object.defineProperty(r, 'url', { value: 'https://evil.test/prm' });
    return r;
  },
});
check('★ وتحويلةٌ إلى أصلٍ آخر تُرفض بعد اتّباعها',
  (await discoverAuth(PRM, 2000, 'https://res.test/mcp')) === null);

// وخادمُ التفويض أصلُه غيرُ أصل المورد بطبيعته — فلا يُقيَّد
setup({
  [PRM]: { authorization_servers: ['https://as.test'] },
  'https://as.test/.well-known/oauth-authorization-server': {
    issuer: 'https://as.test', token_endpoint: 'https://as.test/t',
    registration_endpoint: 'https://as.test/r', code_challenge_methods_supported: ['S256'],
    response_types_supported: ['code'], authorization_response_iss_parameter_supported: true,
  },
});
d = await discoverAuth(PRM, 2000, 'https://res.test/mcp');
check('★ وخادمُ التفويض على أصلٍ آخر يُقرأ — القيدُ على الوثيقة وحدها',
  d?.issuer === 'https://as.test', JSON.stringify(d?.notes));
check('RFC 9207 و response_types يُقرآن',
  d?.authorizationResponseIssParameterSupported === true && d?.responseTypesSupported?.[0] === 'code');


// ═══ الختم ═══
console.log('\nختمُ الاعتمادات:');
const store = new Map();
const KV = {
  async get(k) { return store.get(k) ?? null; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
};
const env = { KV, AUTH_CLIENT_SECRET: 'سرُّ-المنصة-لدى-المركز' };

const sealed = await seal(env, 'mcpoauth:cli:shamela', { clientId: 'abc', clientSecret: 's3cr3t' });
check('مختومٌ يُفكّ إلى ما خُتم', (await unseal(env, 'mcpoauth:cli:shamela', sealed))?.clientSecret === 's3cr3t');
check('★ والمختومُ لا يحوي السرَّ نصّاً', !sealed.includes('s3cr3t') && !sealed.includes('abc'), sealed.slice(0, 60));
check('★ ومختومٌ نُقل إلى مفتاحٍ آخر لا يُفكّ', (await unseal(env, 'mcpoauth:cli:turath', sealed)) === null);
check('ومختومٌ تلف لا يرمي', (await unseal(env, 'mcpoauth:cli:shamela', sealed.replace(/.$/, 'X}'))) === null);
check('★ وسرٌّ دُوّر يُبطل المفكّ ولا يرمي',
  (await unseal({ ...env, AUTH_CLIENT_SECRET: 'سرٌّ-آخر' }, 'mcpoauth:cli:shamela', sealed)) === null);
check('وبلا سرٍّ لا ختمَ ولا رمي', (await seal({ KV }, 'x', { a: 1 })) === null);
check('ومختومان لنفس القيمة يختلفان (متّجهٌ جديد لكل ختم)',
  (await seal(env, 'k', { a: 1 })) !== (await seal(env, 'k', { a: 1 })));

// ═══ منحةُ الآلة ═══
console.log('\nمنحةُ الآلة:');
const AS = {
  resourceMetadata: PRM,
  resource: 'https://res.test/mcp',
  authorizationServers: ['https://as.test'],
  issuer: 'https://as.test',
  tokenEndpoint: 'https://as.test/token',
  registrationEndpoint: 'https://as.test/register',
  grantTypesSupported: ['authorization_code', 'client_credentials', 'refresh_token'],
  codeChallengeMethodsSupported: ['S256'],
  tokenEndpointAuthMethodsSupported: ['none', 'client_secret_basic', 'client_secret_post'],
  notes: [],
};
const src = {
  id: 'shamela', label: 'الشاملة', kind: 'mcp', endpoint: 'https://res.test/mcp',
  role: 'fiqh', enabled: true, searchTool: 'shamela_search_phrase', args: { mode: 'near' },
  queryField: 'query', limitField: 'limit', maxResults: 8, timeoutMs: 3000,
  tokenKey: null, authScheme: 'oauth',
};

let seenReg = null, seenTok = null, mcpAuth = [];
const mcpServer = (init) => {
  mcpAuth.push(init.headers?.authorization ?? null);
  const msg = JSON.parse(init.body);
  if (msg.method === 'initialize') {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: {} } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { structuredContent: { results: [{ book_name: 'المغني' }] }, content: [] } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};
const asRoutes = (over = {}) => ({
  'https://as.test/register': (init) => {
    seenReg = JSON.parse(init.body);
    return new Response(JSON.stringify({ client_id: 'cid-1', client_secret: 'csec-1', token_endpoint_auth_method: over.echo ?? 'client_secret_post' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  },
  'https://as.test/token': (init) => {
    seenTok = { body: init.body, headers: init.headers, type: init.headers?.['content-type'] };
    return new Response(JSON.stringify({ access_token: over.token ?? 'AT-1', token_type: over.tokenType ?? 'Bearer', expires_in: over.expiresIn ?? 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  },
  'https://res.test/mcp': mcpServer,
});

setup(asRoutes()); store.clear();
let r = await authorizeMachine(env, src, AS);
check('★ التفويض لا يُقال «مربوط» إلا بعد نداءٍ حقيقيّ على الأداة', r.ok === true && r.hits === 1, JSON.stringify(r));
check('طلبُ التسجيل يحمل منحة الآلة ولا عناوينَ تحويل',
  seenReg?.grant_types?.[0] === 'client_credentials' && !seenReg.redirect_uris, JSON.stringify(seenReg));
check('★ طلبُ الرمز مرمَّزٌ بـform لا JSON', seenTok?.type === 'application/x-www-form-urlencoded', String(seenTok?.type));
const form = new URLSearchParams(seenTok.body);
check('★ ويحمل resource (RFC 8707) ومنحةَ الآلة',
  form.get('grant_type') === 'client_credentials' && form.get('resource') === 'https://res.test/mcp', seenTok.body);
check('★ و«client_secret_post» تضع السرَّ في الجسم لا في ترويسة',
  form.get('client_secret') === 'csec-1' && !seenTok.headers?.authorization);
check('والرمز يصل إلى المورد حاملاً', mcpAuth.some((a) => a === 'Bearer AT-1'), JSON.stringify(mcpAuth));
check('★ ولا يُخزَّن السرُّ ولا الرمزُ خاماً في المساحة',
  ![...store.values()].some((v) => v.includes('csec-1') || v.includes('AT-1')), [...store.keys()].join(','));

// الرمزُ المخزَّن يُستعمل ولا يُسَكّ ثانيةً
seenTok = null;
check('★ رمزٌ صالحٌ في المخزن يُستعمل بلا سكٍّ جديد',
  (await accessTokenFor(env, src)) === 'AT-1' && seenTok === null);

// رمزٌ منتهٍ → يُعاد سكُّه من العميل المخزَّن
setup(asRoutes({ token: 'AT-2' }));
const tokSlot = 'mcpoauth:tok:shamela';
store.set(tokSlot, await seal(env, tokSlot, { accessToken: 'OLD', expiresAt: Date.now() - 1000, scope: null }));
check('★ ورمزٌ منتهٍ يُسَكّ بدلُه من العميل المسجَّل', (await accessTokenFor(env, src)) === 'AT-2');

// طريقةُ المصادقة تُؤخذ من ردّ الخادم لا من طلبنا
setup(asRoutes({ echo: 'client_secret_basic' })); store.clear();
r = await authorizeMachine(env, src, AS);
check('★ وطريقةُ المصادقة تُؤخذ مما ردّه الخادم لا مما طلبناه',
  r.authMethod === 'client_secret_basic' && !!seenTok.headers?.authorization, JSON.stringify(r.authMethod));
check('و«basic» ترمّز المعرّف والسرّ بترميز النسبة قبل base64',
  seenTok.headers.authorization === 'Basic ' + Buffer.from('cid-1:csec-1', 'utf8').toString('base64'),
  seenTok.headers.authorization);

// المورد يرفض الرمز → لا «مربوط»
setup({ ...asRoutes(), 'https://res.test/mcp': () => new Response('{}', { status: 401 }) }); store.clear();
r = await authorizeMachine(env, src, AS);
check('★ ومورِدٌ يرفض رمزَ الآلة لا يُقال فيه «مربوط»', r.ok === false && r.error?.includes('المورد'), JSON.stringify(r.error));

// نوعُ رمزٍ لا يُدعم
setup(asRoutes({ tokenType: 'DPoP' })); store.clear();
r = await authorizeMachine(env, src, AS);
check('ونوعُ رمزٍ لا نعرف إرساله يُرفض صراحةً', r.ok === false && r.error?.includes('DPoP'), JSON.stringify(r.error));

// لا تسجيلَ ديناميّاً
setup(asRoutes()); store.clear();
r = await authorizeMachine(env, src, { ...AS, registrationEndpoint: null });
check('وبلا تسجيلٍ ديناميّ يُقال ما ينقص', r.ok === false && r.error?.includes('تسجيلاً'), JSON.stringify(r.error));

// لا منحةَ آلة أصلاً
r = await authorizeMachine(env, src, { ...AS, grantTypesSupported: ['authorization_code'] });
check('★ وخادمٌ بلا منحة آلة يُرَدّ قبل أيّ طلب', r.ok === false && r.error?.includes('client_credentials'), JSON.stringify(r.error));

// السحب
setup(asRoutes()); store.clear();
await authorizeMachine(env, src, AS);
await forget(env, 'shamela');
check('★ وسحبُ التفويض يمحو العميل والرمز معاً',
  ![...store.keys()].some((k) => k.startsWith('mcpoauth:cli') || k.startsWith('mcpoauth:tok')), [...store.keys()].join(','));
check('وبعد السحب لا رمزَ يُعطى', (await accessTokenFor(env, src)) === null);


// ═══ منحةُ الإذن في المتصفّح ═══
console.log('\nمنحةُ الإذن:');

const { verifier, challenge } = await pkcePair();
const independent = createHash('sha256').update(verifier).digest('base64url');
check('★ PKCE: التحدّي = base64url(SHA-256(المُثبِت)) — محسوبٌ باستقلال',
  challenge === independent, `${challenge} ≠ ${independent}`);
check('والمُثبِت داخل مجال المواصفة (٤٣–١٢٨) ومن المجموعة غير المحجوزة',
  verifier.length >= 43 && verifier.length <= 128 && /^[A-Za-z0-9\-._~]+$/.test(verifier), verifier);
check('وزوجان متتاليان يختلفان', (await pkcePair()).verifier !== verifier);

// ترتيبُ اختيار النطاق
check('★ نطاقُ التحدّي يُقدَّم على ما تُعلنه الوثيقة',
  scopeFor({ ...AS, scopesSupported: ['a', 'b'] }, 'books:read') === 'books:read');
check('وبلا تحدٍّ تُستعمل scopes_supported كاملةً',
  scopeFor({ ...AS, scopesSupported: ['a', 'b'] }, null) === 'a b');
check('وبلا الاثنين لا يُرسَل نطاقٌ أصلاً', scopeFor({ ...AS }, null) === null);

const AS_CODE = { ...AS, authorizationEndpoint: 'https://as.test/authorize', authorizationResponseIssParameterSupported: true };
const REDIRECT = 'https://advisor.test/auth/mcp/callback';

setup(asRoutes()); store.clear();
let started = await startAuthorization(env, src, AS_CODE, REDIRECT, 'books:read');
const au = new URL(started.url);
check('★ عنوانُ التفويض يحمل ما تُلزم به المواصفة',
  au.searchParams.get('response_type') === 'code' &&
  au.searchParams.get('code_challenge_method') === 'S256' &&
  !!au.searchParams.get('code_challenge') &&
  au.searchParams.get('redirect_uri') === REDIRECT &&
  au.searchParams.get('resource') === 'https://res.test/mcp' &&
  au.searchParams.get('scope') === 'books:read' &&
  !!au.searchParams.get('state'),
  started.url);
check('وتسجيلُ عميل المتصفّح يطلب منحة الإذن والتجديد وعنوانَ الردّ',
  seenReg.grant_types.includes('authorization_code') && seenReg.grant_types.includes('refresh_token') &&
  seenReg.redirect_uris?.[0] === REDIRECT && seenReg.response_types?.[0] === 'code', JSON.stringify(seenReg));

const rawState = au.searchParams.get('state');
check('★ ومفتاحُ الحالة بصمتُها لا هي — فمسحُ المساحة لا يُسلّم قدرةً حيّة',
  [...store.keys()].some((k) => k === 'mcpoauth:st:' + createHash('sha256').update(rawState).digest('hex')) &&
  ![...store.keys()].some((k) => k.includes(rawState)), [...store.keys()].join(','));

// كوكي ربطٍ خاطئ ثم غائب
check('★ وردٌّ بكوكي ربطٍ خاطئ يُرفض',
  (await completeAuthorization(env, rawState, 'CODE', 'bogus', 'https://as.test')).ok === false);
started = await startAuthorization(env, src, AS_CODE, REDIRECT, null);
let st = new URL(started.url).searchParams.get('state');
check('وبلا كوكي ربطٍ أصلاً يُرفض',
  (await completeAuthorization(env, st, 'CODE', null, 'https://as.test')).ok === false);

// iss مخالف
started = await startAuthorization(env, src, AS_CODE, REDIRECT, null);
st = new URL(started.url).searchParams.get('state');
let done = await completeAuthorization(env, st, 'CODE', started.bindSecret, 'https://evil.test');
check('★ و RFC 9207: مُصدِرٌ مخالفٌ في الردّ يُرفض', done.ok === false && done.error?.includes('المُصدِر'), JSON.stringify(done));

// الطريق السعيد
seenTok = null;
started = await startAuthorization(env, src, AS_CODE, REDIRECT, null);
st = new URL(started.url).searchParams.get('state');
routes.set('https://as.test/token', (init) => {
  seenTok = { body: init.body, type: init.headers?.['content-type'] };
  return new Response(JSON.stringify({ access_token: 'AC-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT-1' }),
    { status: 200, headers: { 'content-type': 'application/json' } });
});
done = await completeAuthorization(env, st, 'CODE-XYZ', started.bindSecret, 'https://as.test');
check('★ مبادلةٌ ناجحة تُنتج رمزاً مخزَّناً', done.ok === true && (await accessTokenFor(env, src)) === 'AC-1', JSON.stringify(done));
const tf = new URLSearchParams(seenTok.body);
check('★ وطلبُ المبادلة يحمل code_verifier وresource ومنحةَ الإذن',
  seenTok.type === 'application/x-www-form-urlencoded' &&
  tf.get('grant_type') === 'authorization_code' && !!tf.get('code_verifier') &&
  tf.get('resource') === 'https://res.test/mcp' && tf.get('redirect_uri') === REDIRECT, seenTok.body);
check('★ والمُثبِت المُرسَل يطابق تحدّي عنوان التفويض',
  createHash('sha256').update(tf.get('code_verifier')).digest('base64url') ===
  new URL(started.url).searchParams.get('code_challenge'));

// إعادةُ استعمال الحالة
check('★ وحالةٌ استُعملت مرّةً لا تُقبل ثانية',
  (await completeAuthorization(env, st, 'CODE-XYZ', started.bindSecret, 'https://as.test')).ok === false);

// التجديد: الجديد يحلّ، والساكت يُبقي القديم
routes.set('https://as.test/token', () => new Response(JSON.stringify({ access_token: 'AC-2', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT-2' }),
  { status: 200, headers: { 'content-type': 'application/json' } }));
let next = await refreshWith(env, src, { accessToken: 'AC-1', expiresAt: 0, scope: null, refreshToken: 'RT-1' });
check('★ ورمزُ تجديدٍ جديد يحلّ محلّ القديم', next?.accessToken === 'AC-2' && next?.refreshToken === 'RT-2');
routes.set('https://as.test/token', () => new Response(JSON.stringify({ access_token: 'AC-3', token_type: 'Bearer', expires_in: 3600 }),
  { status: 200, headers: { 'content-type': 'application/json' } }));
next = await refreshWith(env, src, { accessToken: 'AC-2', expiresAt: 0, scope: null, refreshToken: 'RT-2' });
check('★ وردٌّ ساكتٌ عن التجديد يُبقي القديم — لا خروجَ صامتٌ بعد أسبوع',
  next?.accessToken === 'AC-3' && next?.refreshToken === 'RT-2', JSON.stringify(next));

// لا نزولَ إلى plain
const noS256 = await startAuthorization(env, src, { ...AS_CODE, codeChallengeMethodsSupported: ['plain'] }, REDIRECT, null);
check('★ وخادمٌ بلا S256 يُرَدّ ولا يُنزَل إلى plain',
  noS256.ok === false && noS256.message?.includes('S256'), JSON.stringify(noS256));

console.log(`\n${pass} نجحت · ${fail} أخفقت`);
process.exit(fail ? 1 : 0);
