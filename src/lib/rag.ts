// الاسترجاع (RAG) والتضمين — §6
import type { Env } from '../types';

// توليد تضمين لنصّ واحد عبر Workers AI (bge-m3، يدعم العربية)
export async function embed(env: Env, text: string): Promise<number[]> {
  const res: any = await env.AI.run(env.EMBEDDING_MODEL as any, { text: [text] });
  const vec = res?.data?.[0] ?? res?.[0];
  if (!vec) throw new Error('فشل توليد التضمين');
  return vec;
}

export async function embedBatch(env: Env, texts: string[]): Promise<number[][]> {
  const res: any = await env.AI.run(env.EMBEDDING_MODEL as any, { text: texts });
  return res?.data ?? res;
}

// تقسيم النص إلى مقاطع بحدود منطقية (المواد/الفقرات) مع تداخل بسيط
export function chunkText(text: string, targetChars = 1200, overlap = 150): string[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length <= targetChars) return clean ? [clean] : [];

  // نحاول القطع عند حدود المواد أولًا
  const articleSplit = clean.split(/(?=(?:المادة|مادة)\s+[\(\d])/);
  const chunks: string[] = [];
  let current = '';
  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const part of articleSplit) {
    if ((current + part).length > targetChars && current) {
      pushCurrent();
      // تداخل: أعِد آخر جزء
      current = current.length > overlap ? '' : current;
    }
    current += part;
    while (current.length > targetChars * 1.5) {
      chunks.push(current.slice(0, targetChars).trim());
      current = current.slice(targetChars - overlap);
    }
  }
  pushCurrent();
  return chunks.filter(Boolean);
}

export interface RagResult {
  text: string;
  score: number;
  documentId: string;
  title: string;
  articleRef?: string;
}

// البحث في Vectorize وإعادة أوثق المقاطع مع الإسناد
export async function retrieve(env: Env, queries: string[], topK = 5): Promise<RagResult[]> {
  const seen = new Map<string, RagResult>();
  for (const q of queries) {
    if (!q?.trim()) continue;
    const vector = await embed(env, q);
    const matches = await env.VECTORIZE.query(vector, { topK, returnMetadata: 'all' });
    for (const m of matches.matches ?? []) {
      const meta = (m.metadata ?? {}) as any;
      const key = m.id;
      if (!seen.has(key) || (seen.get(key)!.score < m.score)) {
        seen.set(key, {
          text: meta.text ?? '',
          score: m.score,
          documentId: meta.document_id ?? '',
          title: meta.title ?? 'نظام',
          articleRef: meta.article_ref,
        });
      }
    }
  }
  return Array.from(seen.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ── بحث المحادثات الدلالي (§3) ──
export async function indexConversationMessage(
  env: Env,
  opts: { messageId: string; conversationId: string; userId: string; role: string; content: string; title: string }
): Promise<void> {
  try {
    const vec = await embed(env, opts.content.slice(0, 2000));
    await env.CONV_VECTORIZE.upsert([
      {
        id: opts.messageId,
        values: vec,
        metadata: {
          user_id: opts.userId,
          conversation_id: opts.conversationId,
          role: opts.role,
          title: opts.title,
          snippet: opts.content.slice(0, 300),
        },
      },
    ]);
  } catch {
    // Vectorize/AI غير متاح محليًا — يُتجاهل بلا إفشال
  }
}

export interface ConvSearchHit {
  conversationId: string;
  title: string;
  snippet: string;
  score: number;
}

export async function searchConversations(env: Env, userId: string, query: string, topK = 10): Promise<ConvSearchHit[] | null> {
  try {
    const vec = await embed(env, query);
    const res = await env.CONV_VECTORIZE.query(vec, {
      topK,
      returnMetadata: 'all',
      filter: { user_id: userId },
    });
    return (res.matches ?? []).map((m) => {
      const meta = (m.metadata ?? {}) as any;
      return { conversationId: meta.conversation_id ?? '', title: meta.title ?? '', snippet: meta.snippet ?? '', score: m.score };
    });
  } catch {
    return null; // إشارة للرجوع إلى البحث النصّي
  }
}

// تنسيق سياق RAG لإدراجه في البرومبت مع الإسناد
export function formatRagContext(results: RagResult[]): string {
  if (!results.length) return '';
  const blocks = results
    .map((r, i) => `[${i + 1}] المصدر: ${r.title}${r.articleRef ? ` — ${r.articleRef}` : ''}\n${r.text}`)
    .join('\n\n---\n\n');
  return `<سياق_نظامي>\nالمقاطع التالية مسترجَعة من قاعدة المعرفة النظامية الرسمية. استند إليها وأشِر لأرقامها عند الاقتباس:\n\n${blocks}\n</سياق_نظامي>`;
}
