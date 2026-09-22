/**
 * فحصُ عميل MCP — سلوكاً لا نصّاً.
 *
 * بقيّةُ فحوص `audit/` تقرأ الشيفرة وتؤكّد أنماطها. وهذا يشغّل العميل فعلاً
 * على خادمٍ صوريّ يحاكي مواصفة `2025-11-25`، لأن ما يُخشى هنا ليس غياب سطر
 * بل سلوكٌ في حالةٍ نادرة: مجرًى يسبق ردَّه إشعارُ تقدّم، وجلسةٌ تنتهي عند
 * الخادم، وأداةٌ ترفض بينما الاتصال سليم.
 *
 * ولا يمسّ شبكةً ولا مفتاحاً: الخادم داخل العملية على منفذٍ عابر.
 *
 *   node audit/mcp-client-check.mjs     (أو: npm run check:mcp)
 */
import http from 'node:http';
import { callTool } from '../src/lib/mcp.ts';

function makeServer() {
  const state = { sessions: new Set(), killNext404: false, seenHeaders: [], handshakes: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const scenario = new URL(req.url, 'http://x').pathname.slice(1) || 'json';
      let msg = {};
      try { msg = JSON.parse(raw); } catch {}
      state.seenHeaders.push({ method: msg.method, headers: { ...req.headers } });
      const sid = req.headers['mcp-session-id'];
      const send = (code, body, extra = {}) => {
        res.writeHead(code, { 'content-type': 'application/json', ...extra });
        res.end(body === undefined ? '' : JSON.stringify(body));
      };

      if (msg.method === 'initialize') {
        state.handshakes++;
        const id = 'sess-' + state.handshakes;
        state.sessions.add(id);
        return send(200, { jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'mock', version: '0' },
        }}, { 'mcp-session-id': id });
      }
      if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }

      if (msg.method === 'tools/call') {
        if (scenario === 'expire' && state.killNext404) { state.killNext404 = false; return send(404, { error: 'gone' }); }
        if (scenario === 'toolerr') return send(200, { jsonrpc: '2.0', id: msg.id, result: {
          content: [{ type: 'text', text: 'الكتاب غير منزَّل' }], isError: true } });
        if (scenario === 'protoerr') return send(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown tool' } });
        if (scenario === 'mangled') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{not json'); }
        if (scenario === 'hang') return; // لا ردّ أبداً — تُختبر المهلة
        if (scenario === 'unauth') return send(401, { error: 'no' });

        const payload = { count: 1, results: [{ book_id: 7, meta: { book_name: 'الملخص الفقهي', author_name: 'صالح الفوزان', vol: '2', page: 146 }, snip: 'شروط صحة الإجارة', link: 'https://app.turath.io/book/7?page=1' }] };
        if (scenario === 'sse') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          // إشعارُ تقدّمٍ أوّلاً — يُسقط القراءةَ الواحدة ولا يُسقط الحلقة
          res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`);
          res.write(': keep-alive\n\n');
          setTimeout(() => {
            res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { structuredContent: payload, content: [] } })}\n\n`);
            res.end();
          }, 30);
          return;
        }
        // الافتراضي: JSON، والجسم في كتلة نصٍّ لا مهيكلاً (يُختبر التحليل)
        if (scenario === 'textonly') return send(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '```json\n' + JSON.stringify(payload) + '\n```' }] } });
        return send(200, { jsonrpc: '2.0', id: msg.id, result: { structuredContent: payload, content: [{ type: 'text', text: JSON.stringify(payload) }] } });
      }
      send(400, { error: 'unexpected' });
    });
  });
  return { server, state };
}

const { server, state } = makeServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// KV صوريّ في الذاكرة — العميل يستعمل put/get/delete وحدها
const store = new Map();
const env = { KV: {
  async get(k) { return store.get(k) ?? null; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
}};

const src = (scenario, over = {}) => ({
  id: 'mock', label: 'صوري', kind: 'mcp',
  endpoint: `http://127.0.0.1:${port}/${scenario}`,
  role: 'fiqh', enabled: true, searchTool: 'search_turath',
  args: {}, queryField: 'q', maxResults: 5, timeoutMs: 2000, tokenKey: null, ...over,
});

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};
const call = (scenario, over) => callTool(env, src(scenario, over), null, 'search_turath', { q: 'الإجارة' });

console.log('عميل MCP — الخادم الصوريّ:');

let r = await call('json');
check('ردٌّ JSON مهيكل', r.ok && r.data?.results?.[0]?.meta?.book_name === 'الملخص الفقهي', JSON.stringify(r).slice(0,120));

store.clear();
r = await call('sse');
check('مجرى SSE يتخطّى إشعار التقدّم والتعليق', r.ok && r.data?.results?.length === 1, JSON.stringify(r).slice(0,120));

store.clear();
r = await call('textonly');
check('كتلة نصٍّ داخل سياج ```json``` تُحلَّل', r.ok && r.data?.count === 1, JSON.stringify(r).slice(0,120));

// إعادة استعمال الجلسة: نداءان، مصافحةٌ واحدة
store.clear(); state.handshakes = 0;
await call('json'); await call('json');
check('الجلسة تُعاد لا تُصافَح مرّتين', state.handshakes === 1, `handshakes=${state.handshakes}`);

// انتهاء الجلسة: ٤٠٤ مرّةً ثم نجاح، بمصافحةٍ ثانية لا حلقة
store.clear(); state.handshakes = 0;
await call('expire');                    // تُنشئ جلسة
state.killNext404 = true;
r = await call('expire');
check('٤٠٤ على جلسةٍ منتهية → مصافحةٌ واحدة ثم نجاح', r.ok && state.handshakes === 2, `ok=${r.ok} handshakes=${state.handshakes}`);

store.clear(); r = await call('toolerr');
check('رفضُ الأداة يُصنَّف tool لا transport', !r.ok && r.kind === 'tool' && r.message.includes('غير منزَّل'), JSON.stringify(r));

store.clear(); r = await call('protoerr');
check('خطأ البروتوكول يُصنَّف protocol', !r.ok && r.kind === 'protocol', JSON.stringify(r));

store.clear(); r = await call('unauth');
check('٤٠١ يُصنَّف config لا transport', !r.ok && r.kind === 'config', JSON.stringify(r));

store.clear(); r = await call('mangled');
check('جسمٌ مشوَّه لا يرمي', !r.ok && r.kind === 'protocol', JSON.stringify(r));

store.clear(); r = await call('hang', { timeoutMs: 300 });
check('انقضاء المهلة يُردّ ولا يُرمى', !r.ok && r.kind === 'transport' && r.message.includes('المهلة'), JSON.stringify(r));

r = await callTool(env, { ...src('json'), endpoint: null }, null, 't', {});
check('مصدرٌ بلا عنوان → config', !r.ok && r.kind === 'config', JSON.stringify(r));

r = await callTool(env, src('json', { tokenKey: 'x' }), null, 't', {});
check('مصدرٌ يطلب رمزاً بلا رمز → config', !r.ok && r.kind === 'config', JSON.stringify(r));

// الترويسات اللازمة
const init = state.seenHeaders.find((h) => h.method === 'initialize');
const tc = state.seenHeaders.find((h) => h.method === 'tools/call');
check('Accept يحمل النوعين', init.headers.accept === 'application/json, text/event-stream', init.headers.accept);
check('MCP-Protocol-Version على tools/call', tc.headers['mcp-protocol-version'] === '2025-11-25', tc.headers['mcp-protocol-version']);
check('Mcp-Method و Mcp-Name (تأمينُ الحقبة الحديثة)', tc.headers['mcp-method'] === 'tools/call' && tc.headers['mcp-name'] === 'search_turath', JSON.stringify({m:tc.headers['mcp-method'],n:tc.headers['mcp-name']}));

// الرمز على كل طلب لا على المصافحة وحدها
store.clear();
await callTool(env, src('json', { tokenKey: 'k' }), 'TOK', 'search_turath', { q: 'x' });
const withTok = state.seenHeaders.filter((h) => h.headers.authorization === 'Bearer TOK');
check('الرمز على المصافحة والنداء معاً', withTok.length >= 2, `count=${withTok.length}`);

server.close();
console.log(`\n${pass} نجحت · ${fail} أخفقت`);
process.exit(fail ? 1 : 0);
