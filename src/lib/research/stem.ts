// ملءُ `text_stem` — مدخلِ الفهرس اللفظي الثاني (هجرة 0037).
//
// الجذع يُحسب في الشيفرة (`stemText`) لا في SQL، فيُملأ بمهمّةٍ تجري في كل نبضة
// Cron على ما لم يُحسب جذعُه: مقاطعُ استُوردت للتوّ، أو تغيّر نصُّها ففرّغ المحفّزُ
// جذعَها. والمحفّز يُدرجه في `legal_fts_stem` عند الكتابة.
import { stemText } from '../arabic';
import type { Env } from '../../types';

const STEM_BATCH = 100;

export async function stemPending(env: Env, limit = 600): Promise<{ stemmed: number; remaining: number }> {
  const rows = await env.DB.prepare(
    'SELECT seq, text_norm FROM legal_chunks WHERE text_stem IS NULL ORDER BY seq LIMIT ?'
  )
    .bind(limit)
    .all<{ seq: number; text_norm: string | null }>();
  const pending = rows.results ?? [];
  for (let i = 0; i < pending.length; i += STEM_BATCH) {
    await env.DB.batch(
      pending
        .slice(i, i + STEM_BATCH)
        .map((r) => env.DB.prepare('UPDATE legal_chunks SET text_stem = ? WHERE seq = ?').bind(stemText(r.text_norm ?? ''), r.seq))
    );
  }
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM legal_chunks WHERE text_stem IS NULL').first<{ n: number }>();
  return { stemmed: pending.length, remaining: left?.n ?? 0 };
}
