// منفّذُ استخراج نصوص المرفقات — Durable Object لكل مرفق.
//
// `POST /start` يحفظ معرّف المرفق ويضبط المنبّه ويعود فوراً؛ والقراءة في `alarm()`:
// المنبّه يعمل مستقلاً عن طلب الرفع، فلا يقطعه انتهاءُ الطلب ولا إغلاقُ المتصفّح، وله
// خمس عشرة دقيقة حيث لا يملك `waitUntil` بعد الردّ إلا ثلاثين ثانية. التفصيل في
// `src/lib/attachmentExtraction.ts`.
//
// والحالة كلُّها في صفّ المرفق لا في تخزين الكائن: منه تقرأ الشاشة، ومنه يُعرف ما تعطّل.
// وتخزين الكائن لا يحمل إلا معرّف مرفقه وعددَ محاولاته.
import { extractAttachment, markStalled } from './lib/attachmentExtraction';
import type { Env } from './types';

/**
 * محاولاتُ المنبّه للمرفق الواحد.
 *
 * المنبّه يُعاد إن انقطع قبل أن يتمّ — نشرٌ جديد، أو تجاوزُ زمنه — وكلُّ إعادةٍ تقرأ
 * المستند من أوّله على حساب نداءاتٍ تُدفع. فإعادةٌ واحدة تكفي عارضاً عابراً، وما
 * انقطع مرّتين يتكرّر انقطاعُه: يُوسَم متعثّراً ولا يُقرأ ثالثةً.
 */
const MAX_ATTEMPTS = 2;

export class ExtractRunner {
  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== 'POST' || url.pathname !== '/start') return new Response('not found', { status: 404 });
    const id = (await req.text()).trim();
    if (!id) return new Response('attachment id required', { status: 400 });
    await this.state.storage.put('attachmentId', id);
    await this.state.storage.setAlarm(Date.now());
    return new Response(null, { status: 202 });
  }

  async alarm(): Promise<void> {
    const id = await this.state.storage.get<string>('attachmentId');
    if (!id) return;
    // تُعدّ المحاولة قبل العمل لا بعده: محاولةٌ قُطعت في منتصفها لا تصل إلى ما بعدها.
    const attempt = ((await this.state.storage.get<number>('attempts')) ?? 0) + 1;
    await this.state.storage.put('attempts', attempt);
    try {
      if (attempt > MAX_ATTEMPTS) await markStalled(this.env, [id]);
      else await extractAttachment(this.env, id);
    } catch (e) {
      /* تُرمى ليُعاد المنبّه، خلافاً لمنفّذ البحث: القراءةُ نفسها — وهي ما يُدفع — لا ترمي،
         تَسِم الصفَّ بما انتهت إليه. فما يصل هنا تعثُّرُ ما قبلها — قاعدةٌ أو تخزينٌ لم
         يُجب — وإعادتُه رخيصة، والمحاولاتُ معدودةٌ أعلاه. */
      console.error('attachment extraction failed:', id, e);
      throw e;
    }
    await this.state.storage.deleteAll();
  }
}
