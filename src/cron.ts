// تتبّع الأنظمة عبر Cron — §7
// يفحص المصادر الرسمية بحثًا عن تعديلات/أنظمة جديدة ويضع علامة «يحتاج مراجعة».
import { callClaude, webSearchTool, OFFICIAL_DOMAINS } from './lib/claude';
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

// ── خلاصة أخبار جريدة أم القرى: أنظمة جديدة/تعديلات (§5) ──
export async function runNewsDigest(env: Env): Promise<{ found: number }> {
  const system = `أنت راصد تشريعي. ابحث في جريدة أم القرى الرسمية عن أحدث ما نُشر من أنظمة جديدة أو تعديلات نظامية.
أعِد JSON فقط: {"items":[{"title":"...","summary":"...","url":"...","published":"...","kind":"new_regulation|amendment|other"}]}
اقتصر على ما هو نظامي فعلًا، وبحدّ أقصى 10 عناصر.`;

  try {
    const { text } = await callClaude(env, {
      model: env.PLANNER_MODEL,
      system,
      messages: [{ role: 'user', content: 'ما أحدث الأنظمة والتعديلات المنشورة في جريدة أم القرى؟' }],
      tools: [webSearchTool(['uqn.gov.sa'])],
      max_tokens: 2000,
      temperature: 0,
    });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { found: 0 };
    const parsed = JSON.parse(m[0]);
    const items: any[] = Array.isArray(parsed.items) ? parsed.items : [];
    let found = 0;
    for (const it of items.slice(0, 10)) {
      if (!it.title) continue;
      // تجنّب التكرار حسب العنوان
      const exists = await env.DB.prepare('SELECT id FROM news_digest WHERE title = ?').bind(it.title).first();
      if (exists) continue;
      await env.DB.prepare(
        'INSERT INTO news_digest (id, title, summary, url, published, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
        .bind(crypto.randomUUID(), it.title, it.summary ?? null, it.url ?? null, it.published ?? null, it.kind ?? 'other', Date.now())
        .run();
      found++;
    }
    return { found };
  } catch (e) {
    console.error('فشل خلاصة الأخبار:', e);
    return { found: 0 };
  }
}

// يسأل Claude مع بحث مقيّد بالمصادر الرسمية
async function checkRegulation(env: Env, title: string): Promise<{ changed: boolean; summary: string }> {
  const system = `أنت مراقب تشريعات سعودي. باستخدام البحث في المصادر الرسمية فقط، تحقّق مما إذا صدر تعديل حديث على النظام المذكور خلال الفترة الأخيرة.
أعِد JSON فقط: {"changed": true|false, "summary": "ملخّص موجز للتغيير المكتشَف أو 'لا تغييرات مرصودة'"}`;

  const { text } = await callClaude(env, {
    model: env.PLANNER_MODEL,
    system,
    messages: [{ role: 'user', content: `النظام: ${title}\nهل صدر تعديل أو تحديث رسمي حديث عليه؟` }],
    tools: [webSearchTool(OFFICIAL_DOMAINS)],
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
