// إعداد نماذج الاستشارات للمستخدم (الحقول وطلب الملف، دون البرومبت)
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { getAllEffectiveConfigs, getEffectiveConfig, publicView } from '../lib/consultationConfig';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth);

app.get('/configs', async (c) => {
  const configs = await getAllEffectiveConfigs(c.env);
  return c.json({ configs: configs.map(publicView) });
});

app.get('/configs/:key', async (c) => {
  const cfg = await getEffectiveConfig(c.env, c.req.param('key'));
  return c.json({ config: publicView(cfg) });
});

export default app;
