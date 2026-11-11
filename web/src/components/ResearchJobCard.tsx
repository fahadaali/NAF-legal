// بحثٌ يجري في الخلفية — سؤالُه، ومرحلتُه، ثم مذكرتُه حين يتمّ.
//
// البحث المعمّق دقائق، ويبنيه الخادم في `ResearchRunner` ولو أُغلقت الصفحة. فالبطاقة
// تسأل عن حاله كل بضع ثوانٍ ما دام جارياً، وتتوقّف عند أوّل حالٍ نهائية. ومن عاد إلى
// المحادثة وجدها كما تركها: `GET /api/research/conversations/:id/job` يعيدها إليه.
import { useEffect, useRef, useState } from 'react';
import { api, type Citation, type ResearchJob, type ResearchMemo as Memo } from '../lib/api';
import { Icon, ICON_SM } from '../lib/icons';
import { RT, stageOf, jobErrorText } from '../lib/researchTerms';
import ResearchMemo from './ResearchMemo';

/** فترةُ السؤال عن حال المهمّة. الجولة الواحدة ثوانٍ إلى دقيقة، فلا وجه لأقصر. */
const POLL_MS = 3000;

export default function ResearchJobCard({
  jobId,
  onOpenSource,
  onDraft,
  onRetry,
  onLoaded,
  disabled,
}: {
  jobId: string;
  onOpenSource: (c: Citation) => void;
  /** المذكرة وسؤالُها — يُصاغ منها في الدور التالي. */
  onDraft: (memo: Memo, question: string) => void;
  onRetry: (question: string, deep: boolean) => void;
  /** السؤال حين يصل — لمن عاد إلى المحادثة ولا يعرفه إلا من المهمّة. */
  onLoaded?: (question: string) => void;
  disabled?: boolean;
}) {
  const [job, setJob] = useState<ResearchJob | null>(null);
  const [memo, setMemo] = useState<Memo | null>(null);
  const [lost, setLost] = useState(false);
  // في مرجع: دالّةٌ جديدة مع كل رسمٍ للأب لا تُعيد بدء السؤال عن الحال.
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const r = await api.researchJob(jobId);
        if (!live) return;
        setJob(r.job);
        onLoadedRef.current?.(r.job.message);
        setLost(false);
        if (r.memo) setMemo((m) => m ?? r.memo);
        if (r.job.status === 'done' || r.job.status === 'failed') return;
      } catch {
        // انقطاعٌ عابر لا يُنهي المتابعة: يُقال، ويُعاد السؤال في موعده.
        if (live) setLost(true);
      }
      if (live) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [jobId]);

  const running = !job || job.status === 'queued' || job.status === 'running';
  const stage = job ? stageOf(job) : { label: RT.stageAnalysing };

  return (
    <div className="research-job">
      {running && (
        <div className="research-job-progress" role="status">
          <span className="typing-note">
            <Icon.running size={ICON_SM} aria-hidden className="icon-spin" />
            {stage.label}
            {stage.round != null && (
              <>
                {' '}
                <bdi>{stage.round}</bdi>
              </>
            )}
          </span>
          {job?.deep && (
            <span className="research-job-hint">
              <Icon.deepResearch size={ICON_SM} aria-hidden /> {RT.deepResearch} · {RT.canLeave}
            </span>
          )}
          {job?.progress?.recent.length ? (
            <ul className="research-job-steps">
              {job.progress.recent
                .filter((s) => s.query)
                .map((s, i) => (
                  <li key={i}>
                    <Icon.search size={ICON_SM} aria-hidden /> <bdi>{s.query}</bdi>
                  </li>
                ))}
            </ul>
          ) : null}
          {lost && (
            <span className="research-job-lost">
              <Icon.warning size={ICON_SM} aria-hidden /> تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة
            </span>
          )}
        </div>
      )}

      {job?.status === 'failed' && (
        <div className="research-job-failed" role="alert">
          <span>
            <Icon.failed size={ICON_SM} aria-hidden /> {jobErrorText(job.error)}
          </span>
          <button type="button" className="btn-sm" disabled={disabled} onClick={() => onRetry(job.message, job.deep)}>
            <Icon.refresh size={ICON_SM} aria-hidden /> إعادة المحاولة
          </button>
        </div>
      )}

      {job?.status === 'done' && memo && (
        <>
          {/* بلا أيقونة: `CircleCheck` «معتمد» — حكمُ إنسان، والمذكرة لم يُراجعها أحدٌ بعد. */}
          <p className="research-job-done" role="status">
            {RT.done}
          </p>
          <ResearchMemo
            memo={memo}
            onChange={setMemo}
            onOpenSource={onOpenSource}
            onDraft={(m) => onDraft(m, job.message)}
            disabled={disabled}
          />
        </>
      )}
    </div>
  );
}
