// فحوص سلوك المنصة على شيفرتها الفعلية — مسارات Hono ووحدات `src/lib` فوق قاعدةٍ
// بهجرات المستودع. كل فحصٍ هنا يقابل خطأً وُجد فعلاً، فيبقى شاهداً عليه لا يعود.
//
//   npm run check:platform
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, bundle, makeDb, makeKv, suite } from './harness.mjs';

const t = suite('فحوص المنصة');

/** مستخدمٌ ثابت تحقنه بدائلُ المصادقة — المسارات تُفحص بلا مركز الهوية. */
const AUTH_STUB = `
export async function requireAuth(c: any, next: any) {
  c.set('user', (globalThis as any).__naf_user ?? { id: 'u1', email: 'a@x', role: 'admin' });
  await next();
}
export const requireAdmin = requireAuth;
export const requireWriter = requireAuth;
export async function audit() {}
`;

const routes = await bundle(
  'platform-routes',
  `export { default as search } from './search';`,
  { resolveDir: path.join(ROOT, 'src', 'routes'), stubs: { '../lib/auth': AUTH_STUB } }
);

async function seedConversation(db, { user = 'u1', convId = 'c1', content, folder = null }) {
  db.q('INSERT OR IGNORE INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)', user, `${user}@x`, '-', 1);
  db.sqlite
    .prepare('INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(convId, user, 'عنوان', 1, 1);
  if (folder) db.sqlite.prepare('UPDATE conversations SET folder_id = ? WHERE id = ?').run(folder, convId);
  db.sqlite
    .prepare('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(`${convId}-m`, convId, 'user', content, 2);
}

console.log('\nالبحث في المحادثات والمخرجات');

await t.check('بحثٌ عن كلمةٍ في رسالة المستخدم نفسه يجدها', async () => {
  const db = await makeDb();
  await seedConversation(db, { content: 'نزاع عمالي حول مكافأة نهاية الخدمة' });
  const res = await routes.search.request('/?q=مكافأة&scope=chats', {}, { DB: db.DB, KV: makeKv() });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.chats.length, 1, `المتوقع نتيجة واحدة، والواقع ${body.chats.length}`);
  assert.match(body.chats[0].snippet, /مكافأة/);
});

await t.check('لا يجد ما في محادثات مستخدمٍ آخر', async () => {
  const db = await makeDb();
  await seedConversation(db, { user: 'u2', convId: 'c2', content: 'نزاع عمالي حول مكافأة نهاية الخدمة' });
  const res = await routes.search.request('/?q=مكافأة&scope=chats', {}, { DB: db.DB, KV: makeKv() });
  assert.equal((await res.json()).chats.length, 0);
});

await t.check('بحث المخرجات يجد نسخة المسودّة', async () => {
  const db = await makeDb();
  await seedConversation(db, { content: 'سؤال' });
  db.sqlite
    .prepare('INSERT INTO draft_versions (id, message_id, version, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('d1', 'c1-m', 1, 'صحيفة دعوى بطلب التعويض عن الضرر', 3);
  const res = await routes.search.request('/?q=التعويض&scope=outputs', {}, { DB: db.DB, KV: makeKv() });
  assert.equal((await res.json()).outputs.length, 1);
});

t.done();
