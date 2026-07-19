// بحث دلالي في سجل المحادثات مع رجوع نصّي — §3
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { searchConversations } from '../lib/rag';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

app.get('/', async (c) => {
  const user = c.get('user');
  const q = c.req.query('q')?.trim();
  if (!q) return c.json({ results: [], mode: 'empty' });

  // محاولة البحث الدلالي أولًا
  const semantic = await searchConversations(c.env, user.id, q, 10);
  if (semantic && semantic.length) {
    // أزِل التكرار على مستوى المحادثة
    const seen = new Set<string>();
    const results = [];
    for (const h of semantic) {
      if (seen.has(h.conversationId)) continue;
      seen.add(h.conversationId);
      results.push(h);
    }
    return c.json({ results, mode: 'semantic' });
  }

  // رجوع: بحث نصّي في الرسائل
  const rows = await c.env.DB.prepare(
    `SELECT DISTINCT c.id AS conversationId, c.title, substr(m.content, 1, 300) AS snippet
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.user_id = ? AND m.content LIKE ? ORDER BY c.updated_at DESC LIMIT 20`
  )
    .bind(user.id, `%${q}%`)
    .all();
  return c.json({ results: rows.results, mode: 'keyword' });
});

export default app;
