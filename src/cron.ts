// تتبّع الأنظمة عبر Cron — §7
// يفحص المصادر الرسمية بحثًا عن تعديلات/أنظمة جديدة ويضع علامة «يحتاج مراجعة».
import { callClaude, webSearchTool, TRACKING_DOMAINS } from './lib/claude';
import type { Env } from './types';

export interface ScanResult {
  checked: number;
  flagged: number;
  new_suggested: number;
}

export async function runTrackingScan(env: Env): Promise<ScanResult> {
  const docs = await env.DB.prepare(
    "SELECT id, title, category FROM kb_documents WHERE status != 'repealed' ORDER BY last_verified ASC LIMIT 10"
  ).all<{ id: string; title: string; category: string | null }>();

  let flagged = 0;
  const now = Date.now();

  for (const doc of docs.results ?? []) {
    try {
      const finding = await checkRegulation(env, doc.title);
      const trackId = crypto.randomUUID();

      if (finding.changed) {
        await env.DB.prepare('UPDATE kb_documents SET needs_update = 1 WHERE id = ?').bind(doc.id).run();
        await env.DB.prepare(
          `INSERT INTO regulation_tracking (id, kb_document_id, last_checked, change_detected, change_summary, status, created_at)
           VALUES (?, ?, ?, 1, ?, 'needs_review', ?)`
        )
          .bind(trackId, doc.id, now, finding.summary, now)
          .run();
        flagged++;
      } else {
        await env.DB.prepare(
          `INSERT INTO regulation_tracking (id, kb_document_id, last_checked, change_detected, change_summary, status, created_at)
           VALUES (?, ?, ?, 0, ?, 'ok', ?)`
        )
          .bind(trackId, doc.id, now, finding.summary, now)
          .run();
        await env.DB.prepare('UPDATE kb_documents SET last_verified = ? WHERE id = ?').bind(now, doc.id).run();
      }
    } catch (e) {
      console.error('فشل فحص التتبّع:', doc.title, e);
    }
  }

  return { checked: docs.results?.length ?? 0, flagged, new_suggested: 0 };
}

// ── خلاصة أخبار جريدة أم القرى عبر خلاصة RSS الرسمية (§5) ──
const UQN_RSS_URL = 'https://www.uqn.gov.sa/rssFeed/21';

export async function runNewsDigest(env: Env): Promise<{ found: number }> {
  let found = 0;
  // (1) جريدة أم القرى — عبر خلاصة RSS الرسمية (لا تحتاج مفتاح Claude)
  try {
    const res = await fetch(UQN_RSS_URL, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; NafAdvisorBot/1.0)', accept: 'application/rss+xml, application/xml, text/xml' },
    });
    if (res.ok) {
      const items = parseRss(await res.text());
      for (const it of items.slice(0, 25)) {
        if (it.title && (await addNewsItem(env, it.title, it.summary ?? null, it.url ?? null, it.published ?? null))) found++;
      }
    } else {
      console.error('فشل جلب خلاصة أم القرى:', res.status);
    }
  } catch (e) {
    console.error('فشل خلاصة أم القرى:', e);
  }

  // (2) هيئة الخبراء بمجلس الوزراء + المركز الوطني للوثائق — عبر بحث Claude المقيّد
  if (env.ANTHROPIC_API_KEY) {
    found += await scanOfficialNewRegulations(env);
  }

  return { found };
}

// يُدرج عنصر خلاصة إن لم يكن مكرَّرًا؛ يعيد true عند الإضافة
async function addNewsItem(env: Env, title: string, summary: string | null, url: string | null, published: string | null): Promise<boolean> {
  const exists = await env.DB.prepare('SELECT id FROM news_digest WHERE title = ?').bind(title).first();
  if (exists) return false;
  await env.DB.prepare(
    'INSERT INTO news_digest (id, title, summary, url, published, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(crypto.randomUUID(), title, summary, url, published, classifyKind(title + ' ' + (summary ?? '')), Date.now())
    .run();
  return true;
}

// يسأل Claude عن أحدث الأنظمة/اللوائح من هيئة الخبراء والمركز الوطني (بحث مقيّد بنطاقاتهما)
async function scanOfficialNewRegulations(env: Env): Promise<number> {
  const system = `أنت راصد تشريعي. ابحث في المصدرين الرسميين حصريًا:
هيئة الخبراء بمجلس الوزراء (boe.gov.sa) والمركز الوطني للوثائق والمحفوظات (ncar.gov.sa)،
عن أحدث ما صدر من أنظمة أو لوائح **جديدة أو محدَّثة** خلال الفترة الأخيرة.
أعِد JSON فقط: {"items":[{"title":"...","summary":"رقم المرسوم/القرار وتاريخه","url":"...","published":"..."}]} بحدّ أقصى 10 عناصر.`;
  try {
    const { text } = await callClaude(env, {
      model: env.PLANNER_MODEL,
      system,
      messages: [{ role: 'user', content: 'ما أحدث الأنظمة واللوائح الجديدة أو المحدَّثة من هيئة الخبراء والمركز الوطني للوثائق؟' }],
      tools: [webSearchTool(['boe.gov.sa', 'laws.boe.gov.sa', 'ncar.gov.sa'])],
      max_tokens: 2000,
      temperature: 0,
    });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return 0;
    const items: any[] = JSON.parse(m[0]).items ?? [];
    let n = 0;
    for (const it of items.slice(0, 10)) {
      if (it.title && (await addNewsItem(env, it.title, it.summary ?? null, it.url ?? null, it.published ?? null))) n++;
    }
    return n;
  } catch (e) {
    console.error('فشل رصد هيئة الخبراء/المركز الوطني:', e);
    return 0;
  }
}

interface RssItem {
  title: string;
  url?: string;
  summary?: string;
  published?: string;
}

// محلّل RSS مبسّط (بلا اعتماديات): يستخرج عناصر <item>
function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  for (const b of blocks) {
    items.push({
      title: clean(pick(b, 'title')),
      url: clean(pick(b, 'link')),
      summary: clean(pick(b, 'description')),
      published: clean(pick(b, 'pubDate')),
    });
  }
  return items;
}

function pick(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

function clean(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyKind(text: string): string {
  if (/نظام جديد|إصدار نظام|الموافقة على نظام/.test(text)) return 'new_regulation';
  if (/تعديل|تعدیل|استبدال المادة|إلغاء المادة/.test(text)) return 'amendment';
  return 'other';
}

// يسأل Claude مع بحث مقيّد بالمصادر الرسمية
async function checkRegulation(env: Env, title: string): Promise<{ changed: boolean; summary: string }> {
  const system = `أنت مراقب تشريعات سعودي. باستخدام البحث في المصادر الرسمية الثلاثة حصريًا:
جريدة أم القرى (uqn.gov.sa) · المركز الوطني للوثائق والمحفوظات (ncar.gov.sa) · هيئة الخبراء بمجلس الوزراء (boe.gov.sa)،
تحقّق مما إذا صدر تعديل أو تحديث حديث على النظام/اللائحة المذكورة.
أعِد JSON فقط: {"changed": true|false, "summary": "ملخّص التغيير مع رقم المرسوم/القرار وتاريخه ورابط المصدر إن وُجد، أو 'لا تغييرات مرصودة'"}`;

  const { text } = await callClaude(env, {
    model: env.PLANNER_MODEL,
    system,
    messages: [{ role: 'user', content: `النظام: ${title}\nهل صدر تعديل أو تحديث رسمي حديث عليه؟` }],
    tools: [webSearchTool(TRACKING_DOMAINS)],
    max_tokens: 1024,
    temperature: 0,
  });

  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]);
      return { changed: !!parsed.changed, summary: parsed.summary ?? '' };
    } catch {}
  }
  return { changed: false, summary: 'تعذّر تحليل نتيجة الفحص' };
}
