// نقطة دخول Worker — التوجيه، المصادقة، الأمان، Cron، Queue
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { getCookie } from 'hono/cookie';
import authRoutes from './routes/auth';
import conversationRoutes from './routes/conversations';
import chatRoutes from './routes/chat';
import fileRoutes from './routes/files';
import kbRoutes from './routes/kb';
import adminRoutes from './routes/admin';
import toolsRoutes from './routes/tools';
import feedbackRoutes from './routes/feedback';
import foldersRoutes from './routes/folders';
import sharesRoutes from './routes/shares';
import searchRoutes from './routes/search';
import consultationRoutes from './routes/consultations';
import { runTrackingScan, runNewsDigest } from './cron';
import { verifyJwt } from './lib/crypto';
import { SESSION_COOKIE } from './lib/auth';
import type { Env, Variables } from './types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', secureHeaders());

// حدّ معدّل بسيط عبر KV على مسارات الـ API (§12)
app.use('/api/*', async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const key = token ? `rl:${(await verifyJwt(token, c.env.JWT_SECRET))?.sub ?? 'anon'}` : `rl:ip:${c.req.header('cf-connecting-ip') ?? 'x'}`;
  const WINDOW = 60;
  const LIMIT = 60; // 60 طلب/دقيقة
  try {
    const current = parseInt((await c.env.KV.get(key)) ?? '0', 10);
    if (current >= LIMIT) return c.json({ error: 'تجاوزت حد الطلبات، حاول بعد قليل' }, 429);
    await c.env.KV.put(key, String(current + 1), { expirationTtl: WINDOW });
  } catch {
    // في التطوير قد لا يتوفر KV — نتجاوز بصمت
  }
  await next();
});

app.get('/api/health', (c) => c.json({ ok: true, app: c.env.APP_NAME }));

app.route('/api/auth', authRoutes);
app.route('/api/conversations', conversationRoutes);
app.route('/api/chat', chatRoutes);
app.route('/api/files', fileRoutes);
app.route('/api/kb', kbRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/tools', toolsRoutes);
app.route('/api/feedback', feedbackRoutes);
app.route('/api/folders', foldersRoutes);
app.route('/api/shares', sharesRoutes);
app.route('/api/search', searchRoutes);
app.route('/api/consultations', consultationRoutes);

// أي مسار /api غير معروف
app.all('/api/*', (c) => c.json({ error: 'مسار غير موجود' }, 404));

// كل ما تبقّى → أصول الواجهة (SPA)
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,

  // Cron لتتبّع الأنظمة — §7
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.all([runTrackingScan(env), runNewsDigest(env)]).then(() => {}));
  },
};
