// توليد التضمينات عبر Workers AI — §6
//
// مستقلٌّ عن `rag.ts` لأن طبقتَي الاسترجاع (وثائق مرفوعة ومقاطع مستوردة)
// كلتاهما تحتاجه، ووضعه في إحداهما يجعل الأخرى تستوردها فتدور الاستيرادات.
import type { Env } from '../types';

// توليد تضمين لنصّ واحد (bge-m3، يدعم العربية)
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
