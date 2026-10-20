// منفّذُ مهامّ البحث في الخلفية — Durable Object لكل مهمّة.
//
// `POST /start` يحفظ معرّف المهمّة ويضبط المنبّه ويعود فوراً؛ والبناء في `alarm()`:
// المنبّه يعمل مستقلاً عن الطلب الذي أطلقه، فإغلاقُ المتصفّح لا يقطعه، وله من
// الوقت ما لا يملكه `waitUntil` بعد انتهاء الطلب.
//
// والحالة كلُّها في جدول `research_jobs` لا في تخزين الكائن: منه تقرأ الواجهة
// التقدّم، ومنه يُعرف ما تعطّل. وتخزين الكائن لا يحمل إلا معرّف مهمّته.
import { buildResearchMemo } from './lib/research/build';
import type { RetrievalTrace } from './lib/research/trace';
import type { ConsultationType, Env } from './types';

/** ما يُعرض من آخر خطوات الأثر في التقدّم. */
const RECENT_STEPS = 6;

function progressOf(trace: RetrievalTrace) {
  return {
    steps: trace.steps.length,
    recent: trace.steps.slice(-RECENT_STEPS).map((s) => ({ stage: s.stage, query: s.query ?? null, count: s.count ?? null })),
  };
}

export class ResearchRunner {
  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== 'POST' || url.pathname !== '/start') return new Response('not found', { status: 404 });
    const jobId = (await req.text()).trim();
    if (!jobId) return new Response('job id required', { status: 400 });
    await this.state.storage.put('jobId', jobId);
    await this.state.storage.setAlarm(Date.now());
    return new Response(null, { status: 202 });
  }

  async alarm(): Promise<void> {
    const jobId = await this.state.storage.get<string>('jobId');
    if (!jobId) return;
    const job = await this.env.DB.prepare('SELECT * FROM research_jobs WHERE id = ?')
      .bind(jobId)
      .first<Record<string, any>>();
    // مهمّةٌ حُذفت محادثتها، أو انتهت في محاولةٍ سابقة — لا شيء يُعاد.
    if (!job || job.status === 'done' || job.status === 'failed') {
      await this.state.storage.deleteAll();
      return;
    }
    const update = (sql: string, ...args: unknown[]) =>
      this.env.DB.prepare(`UPDATE research_jobs SET ${sql}, updated_at = ? WHERE id = ?`)
        .bind(...args, Date.now(), jobId)
        .run();

    await update("status = 'running', stage = 'started'");
    try {
      const { memoId } = await buildResearchMemo(this.env, {
        conversationId: job.conversation_id,
        userId: job.user_id,
        message: job.message,
        consultationType: (job.consultation_type ?? undefined) as ConsultationType | undefined,
        attachmentIds: JSON.parse(job.attachment_ids_json ?? '[]'),
        deep: job.deep === 1,
        onProgress: async (stage, trace) => {
          await update('stage = ?, progress_json = ?', stage, JSON.stringify(progressOf(trace)));
        },
      });
      await update("status = 'done', stage = 'done', memo_id = ?", memoId);
    } catch (e) {
      // لا تُرمى: رميةٌ من المنبّه تُعيده، وإعادةُ بحثٍ معمّق كاملٍ تضاعف كلفته
      // على خطأٍ يتكرّر غالباً. والتفصيل للسجلّ، وفي الجدول رمزٌ تعرض الواجهة نصَّه المسجّل.
      console.error('research job failed:', jobId, e);
      await update("status = 'failed', error = ?", 'research_failed').catch(() => {});
    }
    await this.state.storage.deleteAll();
  }
}
