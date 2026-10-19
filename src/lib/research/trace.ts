// أثرُ الاسترجاع — ما جرى في كل دور: الاستعلامات، وما رجع من كل مسار، وما تعطّل.
//
// كان كل عطلٍ في طبقة الاسترجاع يُبتلع ليمضي التوليد — وهذا صحيح، فردٌّ أنفع من
// خطأ — لكنه يُبتلع بلا أثر: فهرسٌ لم يُهيّأ، ونموذجُ تضمينٍ متعطّل، وجدولٌ ناقص،
// كلُّها تُخرج ردّاً يبدو في الشاشة عادياً. والأثر هنا هو ما يقول بعدها ما وقع.

export interface TraceStep {
  /** المرحلة: `planner` · `query` · `lexical` · `semantic` · `documents` · `article` · … */
  stage: string;
  /** الاستعلام الذي جرت عليه، إن كانت لاستعلام. */
  query?: string;
  /** عددُ ما رجع. */
  count?: number;
  /** سببُ التعطّل إن تعطّلت. */
  error?: string;
  /** تفصيلٌ إضافي صغير — نظامٌ حُصر فيه البحث، أو طبقة. */
  detail?: string;
}

export interface RetrievalTrace {
  steps: TraceStep[];
  add(step: TraceStep): void;
  /** يسجّل عطلاً ويعيد رسالته — ليُكتب في السجلّ أيضاً. */
  fail(stage: string, e: unknown, query?: string): string;
  /** هل تعطّل شيء؟ */
  readonly failed: boolean;
}

/** أقصى ما يُحفظ من خطوات الدور الواحد — أثرٌ لا سجلّ كامل. */
const MAX_STEPS = 400;

export function newTrace(): RetrievalTrace {
  const steps: TraceStep[] = [];
  return {
    steps,
    add(step) {
      if (steps.length < MAX_STEPS) steps.push(step);
    },
    fail(stage, e, query) {
      const msg = String((e as any)?.message ?? e).slice(0, 300);
      if (steps.length < MAX_STEPS) steps.push({ stage, query, error: msg });
      return msg;
    },
    get failed() {
      return steps.some((s) => s.error);
    },
  };
}

/**
 * يحفظ أثر الدور. فشلُ الحفظ لا يُسقط الدور — الأثر خادمٌ للدور لا شرطٌ له.
 */
export async function saveTrace(
  env: { DB: D1Database },
  t: {
    conversationId: string | null;
    messageId: string | null;
    userId: string | null;
    plan: { consultation_type?: string } | null;
    trace: RetrievalTrace;
    resultKeys: string[];
  }
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO retrieval_traces (id, conversation_id, message_id, user_id, consultation_type, plan_json,
                                     steps_json, result_keys_json, failed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        t.conversationId,
        t.messageId,
        t.userId,
        t.plan?.consultation_type ?? null,
        t.plan ? JSON.stringify(t.plan) : null,
        JSON.stringify(t.trace.steps),
        JSON.stringify(t.resultKeys),
        t.trace.failed ? 1 : 0,
        Date.now()
      )
      .run();
  } catch (e: any) {
    console.error('save trace failed:', e?.message ?? e);
  }
}
