// نقطة دخول Worker — التوجيه، المصادقة، الأمان، Cron، Queue
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import authRoutes from './routes/auth';
import ssoRoutes from './routes/ssoCallback';
import memberRoutes from './routes/members';
import conversationRoutes from './routes/conversations';
import chatRoutes from './routes/chat';
import fileRoutes from './routes/files';
import kbRoutes from './routes/kb';
import adminRoutes from './routes/admin';
import toolsRoutes from './routes/tools';
import feedbackRoutes from './routes/feedback';
import highlightRoutes from './routes/highlights';
import foldersRoutes from './routes/folders';
import sharesRoutes from './routes/shares';
import searchRoutes from './routes/search';
import consultationRoutes from './routes/consultations';
import draftRoutes from './routes/drafts';
import deadlineRoutes from './routes/deadlines';
import notificationRoutes from './routes/notifications';
import clauseRoutes from './routes/clauses';
import caseRoutes from './routes/cases';
import regulationRequestRoutes from './routes/regulationRequests';
import legalRoutes from './routes/legal';
import { runTrackingScan, runNewsDigest, runDeadlineReminders, runLegalEmbedding } from './cron';
import { ssoMiddleware } from './lib/sso';
import { requireWriter } from './lib/auth';
import type { Env, Variables } from './types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * سياسة المحتوى — الطبقة الثانية تحت تهريب `renderMarkdown`.
 *
 * `secureHeaders()` بلا خيارات **لا تكتب `Content-Security-Policy` إطلاقاً**؛
 * تكتب إحدى عشرة ترويسة أخرى ولا تكتبها. فبقيت المنصة بلا سياسة، وحين ظهر
 * حقنُ سمةٍ في عارض Markdown لم يكن دونه شيء. والتهريب أُصلح في موضعه، وهذه
 * تقول: ولو عاد، فلا ينفَّذ.
 *
 * وكلُّ مصدرٍ أدناه مقيسٌ على ما تحتاجه المنصة فعلاً، لا منقولٌ من قالب:
 *
 *   `'wasm-unsafe-eval'`  MuPDF تُنشأ من WebAssembly في المتصفّح
 *                         (`web/src/lib/extractText.ts`). وبدونه يسقط
 *                         استخراج نصّ PDF ويعود كلُّ ملفٍّ إلى نداء النموذج.
 *   `style-src` مضمَّن    الواجهة تكتب `style={{…}}` في عشرات المواضع،
 *                         ومستند الطباعة كتلةُ `<style>` واحدة. ولا سبيل
 *                         إلى تجزئةٍ (`hash`) مع أنماطٍ تُبنى في التشغيل.
 *   `img-src data: blob:` رأسيةُ الطباعة تُقرأ `data:` (`lib/print.ts`)،
 *                         و`rasterizeSvg` تُنشئ `blob:` لترسم المتجهة.
 *   `frame-src 'self'`    النافذة العائمة تعرض المرفق في إطارٍ من `/api/`.
 *   `form-action 'self'`  زرّ الخروج نموذجٌ يُرسَل إلى `/auth/logout`.
 *
 * ولا `'unsafe-inline'` في `script-src`: النصّان المضمَّنان اللذان كانا
 * يمنعانه أُخرجا — نصُّ المظهر إلى `web/public/theme-init.js`، ونصُّ
 * الطباعة إلى `printDocument` نفسها. **فمن أضاف `<script>` مضمَّناً بعد
 * اليوم يجده لا يعمل، وذلك هو المقصود.**
 *
 * ونافذة الطباعة تُفتح على `about:blank` فترث هذه السياسة عن فاتحها — وهو
 * سببُ إخراج نصّها، ولزومِ `style-src` و`font-src` و`img-src` لها.
 */
app.use('*', (c, next) =>
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      /* `data:` لازمة لا تساهُل: حزمة `@fontsource` تُضمّن الملفّات الصغيرة
         من الخطّ العربي في CSS المبني بصيغة `data:`. وبدونها يرفض المتصفّح
         كلَّ وجهٍ من أوجه الخطّ ويعود النصّ إلى خطّ النظام — قِيس بتشغيل
         البناء تحت هذه السياسة نفسها. */
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameSrc: ["'self'"],
      workerSrc: ["'self'", 'blob:'],
      manifestSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      /* نموذج الخروج يُرسَل إلى `/auth/logout` ثم يُحوَّل إلى المركز.
         و`form-action` تُفحص على التحويلة أيضاً في المتصفّحات الحديثة، فلو
         اقتُصر على `'self'` لسقط الخروج صامتاً — يضغط المستخدم فلا يقع شيء.
         والمركز يُقرأ من الإعداد ولا يُكتب هنا: منصةٌ بمركزٍ آخر تأخذ مركزها. */
      formAction: ["'self'", c.env.AUTH_ISSUER].filter(Boolean),
      frameAncestors: ["'none'"],
    },
  })(c, next)
);

// مسار الاستقبال والخروج قبل الوسيط: الأول عام بطبيعته — إليه يعود القادم
// من المركز بلا جلسة بعد — والثاني لا معنى لحمايته بجلسةٍ هو يُسقطها.
app.route('/auth', ssoRoutes);

// الدخول الموحّد — يحمي كل ما بعده. وأي مسار جديد محمي افتراضياً ما لم
// يُضَف صراحةً إلى القائمة العامة في `lib/sso.ts`.
app.use('*', ssoMiddleware);

// القارئ يقرأ ولا يكتب — بعد الوسيط لأنه يقرأ الدور الذي يحقنه، وقبل كل
// مسار لأن الحكم بالطريقة لا بالمسار. تفصيله في `lib/auth.ts`.
app.use('*', requireWriter);

// حدّ معدّل بسيط عبر KV على مسارات الـ API (§12)
app.use('/api/*', async (c, next) => {
  // المفتاح يأتي من المستخدم الذي حقنه وسيط الدخول الموحّد. وبقاؤه على
  // الكوكي المحلي بعد الربط كان يهبط بكل مستخدم إلى حدّ العنوان المشترك.
  const user = c.get('user');
  const key = user ? `rl:${user.id}` : `rl:ip:${c.req.header('cf-connecting-ip') ?? 'x'}`;
  const WINDOW = 60; // ثانية
  const LIMIT = 60; // 60 طلب/دقيقة
  try {
    // نافذة ثابتة بوقت انتهاء مخزَّن داخل القيمة: تجديد TTL على كل طلب كان
    // يمنع العدّاد من الصفر فيُحجب المستخدم النشِط بلا مبرّر.
    const now = Date.now();
    const raw = await c.env.KV.get(key);
    let count = 0;
    let resetAt = now + WINDOW * 1000;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { c: number; r: number };
        if (parsed.r > now) {
          count = parsed.c;
          resetAt = parsed.r;
        }
      } catch {
        // قيمة قديمة بصيغة رقم — تُعامَل كنافذة جديدة
      }
    }
    if (count >= LIMIT) {
      return c.json({ error: 'تجاوزت حد الطلبات، حاول بعد قليل' }, 429);
    }
    const ttl = Math.max(60, Math.ceil((resetAt - now) / 1000));
    await c.env.KV.put(key, JSON.stringify({ c: count + 1, r: resetAt }), { expirationTtl: ttl });
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
app.route('/api/highlights', highlightRoutes);
app.route('/api/folders', foldersRoutes);
app.route('/api/shares', sharesRoutes);
app.route('/api/search', searchRoutes);
app.route('/api/consultations', consultationRoutes);
app.route('/api/drafts', draftRoutes);
app.route('/api/deadlines', deadlineRoutes);
app.route('/api/notifications', notificationRoutes);
app.route('/api/clauses', clauseRoutes);
app.route('/api/cases', caseRoutes);
app.route('/api/regulation-requests', regulationRequestRoutes);
app.route('/api/legal', legalRoutes);
app.route('/api/members', memberRoutes);

// أي مسار /api غير معروف
app.all('/api/*', (c) => c.json({ error: 'مسار غير موجود' }, 404));

// كل ما تبقّى → أصول الواجهة (SPA)
//
// الاستجابة تُنسخ ولا تُعاد كما هي: `ASSETS.fetch` يعيد ترويسات غير قابلة
// للتعديل، و`secureHeaders` أعلاه يكتب فيها فيرمي «Can't modify immutable
// headers» وتسقط كل أصول الواجهة بـ 500. ولم يظهر هذا قبل `run_worker_first`
// لأن الأصول كانت تُقدَّم دون أن يعمل Worker أصلاً.
app.get('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  return new Response(res.body, res);
});

export default {
  fetch: app.fetch,

  /**
   * Cron لتتبّع الأنظمة — §7.
   *
   * `allSettled` لا `all`: المهامّ الأربع مستقلّة، ورميةٌ من واحدة كانت
   * تُسقط الوعدَ المجمَّع فيقطع وقتُ التشغيل ما بقي — فجدولٌ لم تُطبَّق
   * هجرته يوقف تنبيهات المواعيد وتتبّع الأنظمة والتضمين معاً.
   *
   * وكلُّ واحدةٍ تبتلع خطأها في موضعها أيضاً؛ وهذا حارسٌ ثانٍ على ما قد
   * يُكتب غداً: مهمّةٌ خامسة تُضاف بلا `try` لا تُسقط من قبلها.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      Promise.allSettled([
        runTrackingScan(env),
        runNewsDigest(env),
        runDeadlineReminders(env),
        runLegalEmbedding(env),
      ]).then((results) => {
        for (const r of results) {
          if (r.status === 'rejected') console.error('scheduled task failed:', r.reason);
        }
      })
    );
  },
};
