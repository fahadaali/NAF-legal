// طلبات إضافة نظام غير موجود في قاعدة المعرفة — مسارات المستخدم
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { uuid } from '../lib/crypto';
import { notify } from '../lib/notify';
import { sameRegulationName } from '../lib/regulations';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

const NAME_MAX = 200;
const URL_MAX = 500;
const NOTE_MAX = 1000;

// رابط اختياري: نقبل http/https فقط، ونرفض ما عداه بدل تخزين نصّ لا يُفتح
function cleanUrl(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return s.slice(0, URL_MAX);
  } catch {
    return null;
  }
}

function cleanText(v: unknown, max: number): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, max) : null;
}

// قائمة طلبات المستخدم نفسه مع حالتها
app.get('/', async (c) => {
  const user = c.get('user');
  const rows = await c.env.DB.prepare(
    `SELECT id, name, url, has_bylaw, bylaw_url, note, source, status, admin_note, created_at, handled_at
     FROM regulation_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`
  )
    .bind(user.id)
    .all();
  return c.json({ requests: rows.results });
});

// رفع طلب جديد. اسم النظام وحده إلزامي، وما عداه اختياري بالكامل.
app.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({} as any));

  const name = cleanText(body.name, NAME_MAX);
  if (!name) return c.json({ error: 'هذا الحقل مطلوب' }, 400);

  const hasBylaw = body.has_bylaw === true || body.has_bylaw === 1;
  const source = body.source === 'chat' ? 'chat' : 'support';
  const conversationId = cleanText(body.conversation_id, 64);

  /* طلب معلّق يدلّ على النظام نفسه من المستخدم نفسه: يُعاد بدل تكرار السطر.

     والمقارنة مطبَّعة لا حرفية: `lower()` في SQLite لا يمسّ العربية، فكان
     «نظام الإثبات» و«نظام الاثبات» طلبين في لوحة المسؤول عن نظام واحد —
     وهو الصنف نفسه الذي جعل الكشف يطلب نظاماً موجوداً في القاعدة. */
  const pending = await c.env.DB.prepare(
    "SELECT id, name FROM regulation_requests WHERE user_id = ? AND status = 'pending' LIMIT 200"
  )
    .bind(user.id)
    .all<{ id: string; name: string }>();
  const existing = (pending.results ?? []).find((r) => sameRegulationName(r.name, name));
  if (existing) return c.json({ id: existing.id, duplicate: true });

  const id = uuid();
  await c.env.DB.prepare(
    `INSERT INTO regulation_requests
       (id, user_id, conversation_id, name, url, has_bylaw, bylaw_url, note, source, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  )
    .bind(
      id,
      user.id,
      conversationId,
      name,
      cleanUrl(body.url),
      hasBylaw ? 1 : 0,
      hasBylaw ? cleanUrl(body.bylaw_url) : null,
      cleanText(body.note, NOTE_MAX),
      source,
      Date.now()
    )
    .run();

  // إشعار مسؤولي النظام ليروا الطلب فور وصوله
  const admins = await c.env.DB.prepare("SELECT id, email FROM users WHERE role = 'admin'").all<{
    id: string;
    email: string;
  }>();
  for (const a of admins.results ?? []) {
    await notify(c.env, {
      userId: a.id,
      kind: 'system',
      title: 'طلب إضافة نظام إلى قاعدة المعرفة',
      body: `${user.name ?? user.email} يطلب إضافة: ${name}`,
      email: a.email,
    });
  }

  return c.json({ id, duplicate: false });
});

export default app;
