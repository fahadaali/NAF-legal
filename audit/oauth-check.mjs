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
import { discoverAuth } from '../src/lib/discover.ts';

const asked = [];
/** خريطةُ عنوانٍ → ردّ. وما ليس فيها يعود ٤٠٤. */
let routes = new Map();

globalThis.fetch = async (url, init) => {
  const href = typeof url === 'string' ? url : url.toString();
  asked.push(href);
  const hit = routes.get(href);
  if (!hit) return new Response('{}', { status: 404 });
  if (typeof hit === 'function') return hit(init);
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

console.log(`\n${pass} نجحت · ${fail} أخفقت`);
process.exit(fail ? 1 : 0);
