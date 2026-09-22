/**
 * فحصُ محوّلات المصادر الخارجية — على أجسامٍ حقيقية لا مُخترَعة.
 *
 * الأجسام أدناه **منسوخةٌ من ردِّ الخادمين حيَّين** (تراث والمكتبة الشاملة)
 * وقت كتابة هذه الشفرة، مقتطعةً في طولها لا في شكلها. ومحوّلٌ يُختبر على شكلٍ
 * من تأليف كاتبه يثبت أن الكاتب متّسقٌ مع نفسه، لا أن المحوّل يعمل.
 *
 * وأهمُّ ما يُفحص هنا ليس الحقول بل **وسمُ الحاشية**: الشاملة تردّ
 * `matched_in`، والحاشية كلام المحقِّق لا المصنِّف — ونسبتُها إلى المؤلف خطأٌ
 * علميّ يُنقل في مذكرةٍ تُرفع لمحكمة.
 *
 *   node audit/external-adapters-check.mjs     (أو: npm run check:external)
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* شفرةُ العامل تستورد بلا لاحقة (`./mcp`) — وهو الصواب فيها: `tsconfig`
   على حلّ الحزم، و`wrangler` يحزمها. ومحلّلُ Node لا يعرف ذلك، فيُلحق هنا
   لا هناك: الفحصُ يتكيّف مع الشفرة، ولا تُغيَّر الشفرة ليمرّ فحص. */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      if (existsSync(`${base}.ts`)) {
        return { url: pathToFileURL(`${base}.ts`).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { adapt } = await import('../src/lib/external.ts');

const src = (id, label) => ({
  id,
  label,
  kind: 'mcp',
  endpoint: 'https://example.invalid/mcp',
  role: 'fiqh',
  enabled: true,
  searchTool: 't',
  args: {},
  queryField: 'q',
  maxResults: 8,
  timeoutMs: 1000,
  tokenKey: null,
});

// ── جسمُ تراث، كما ردّه فعلاً ──
const TURATH = {
  count: 17497,
  results: [
    {
      book_id: 27107,
      author_id: 208,
      cat_id: 22,
      meta: {
        headings: ['فقه المعاملات ١٤٦٣٦', 'الإجارة ١٠٧٠', 'أحكام الإجارة ١٠٣٨', 'شروط صحة عقد سيارة الأجرة'],
        page_id: 53951,
        page: 4057,
        vol: '12',
        book_name: 'فتاوى الشبكة الإسلامية',
        author_name: 'مجموعة من المؤلفين',
      },
      snip: 'الأول أن من <em>شروط</em> <em>صحة</em> <em>العقد</em> في <em>الإجارة</em> أن تكون المنفعة معلومة',
      text: 'شروط صحة عقد سيارة الأجرة السُّؤَالُ لدي سيارة ركاب عمومي وطلب مني السائق أن أعطيه السيارة ليعمل عليها في نقل الركاب',
      link: 'https://app.turath.io/book/27107?page=53951',
    },
    {
      book_id: 11811,
      author_id: 62,
      cat_id: 17,
      meta: { headings: [], page_id: 582, page: 146, vol: '2', book_name: 'الملخص الفقهي', author_name: 'صالح الفوزان' },
      snip: 'مجمل <em>شروط</em> <em>صحة</em> <em>الإجارة</em> بنوعها',
      text: 'وبهذا يتضح أن مجمل شروط صحة الإجارة بنوعها أن يكون عقد الإجارة على المنفعة لا على العين',
      link: 'https://app.turath.io/book/11811?page=582',
    },
  ],
};

// ── جسمُ الشاملة، كما ردّه فعلاً ──
const SHAMELA = {
  mode: 'near',
  query: 'شروط صحة الإجارة',
  total_hits: 23,
  returned: 3,
  has_more: true,
  next_offset: 3,
  results: [
    {
      book_id: 26094,
      book_name: 'الهداية على مذهب الإمام أحمد',
      author_name: 'أبو الخطاب الكلوذاني',
      category: 'الفقه الحنبلي',
      book_date: 510,
      page_id: 289,
      printed_page: '298',
      matched_in: ['body', 'foot'],
      readable: true,
      snippet_body: 'ولَا يَجُوزُ عَقْدُ <mark>الإِجَارَةِ</mark> عَلَى مَنْفَعَةٍ مُحَرَّمَةٍ كَالغِنَاءِ والزَّمْرِ',
      snippet_foot: 'وجملة ذلك أن من <mark>شروط</mark> <mark>صحة</mark> <mark>الإجارة</mark> أن تكون المنفعة مباحة',
    },
    {
      book_id: 20699,
      book_name: 'الممتع في شرح المقنع - ت ابن دهيش ط 3',
      author_name: 'ابن المنجى، أبو البركات',
      category: 'الفقه الحنبلي',
      book_date: 695,
      page_id: 1522,
      printed_page: '2/ 747',
      matched_in: ['body'],
      readable: true,
      snippet_body: '[فصل في <mark>شروط</mark> <mark>الإجارة</mark>] قال: ولا تصح إلا بشروط ثلاثة',
      snippet_foot: '',
    },
    {
      // الحالةُ الخطرة: المطابقة في الحاشية وحدها — كلام المحقِّق لا المصنِّف
      book_id: 30001,
      book_name: 'كتابٌ محقَّق',
      author_name: 'مصنِّفٌ متقدّم',
      category: 'الفقه الحنبلي',
      printed_page: '45',
      matched_in: ['foot'],
      readable: true,
      snippet_body: '',
      snippet_foot: 'قال المحقِّق: وانظر ما ذكره ابن قدامة في <mark>الإجارة</mark>',
    },
  ],
};

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
};

console.log('محوّلات المصادر — على أجسام الخادمين الحقيقية:');

// ── تراث ──
const t = adapt(src('turath', 'تراث'), TURATH);
check('تراث: عدد المقاطع', t.length === 2, `got ${t.length}`);
check('تراث: الكتاب والمؤلِّف', t[0].title === 'فتاوى الشبكة الإسلامية' && t[0].author === 'مجموعة من المؤلفين', JSON.stringify(t[0]).slice(0, 120));
check('تراث: الجزء/الصفحة', t[0].ref === '12/4057', t[0].ref);
check('تراث: الرابط الخارجي يُحمل', t[0].url === 'https://app.turath.io/book/27107?page=53951', String(t[0].url));
check('تراث: العنوان الأول تصنيفاً', t[0].category === 'فقه المعاملات ١٤٦٣٦', String(t[0].category));
check('تراث: بلا عناوين → بلا تصنيف', t[1].category === undefined, String(t[1].category));
check('تراث: كلُّه متن', t.every((h) => h.section === 'متن'), JSON.stringify(t.map((h) => h.section)));

// ── الشاملة ──
const s = adapt(src('shamela', 'المكتبة الشاملة'), SHAMELA);
check('الشاملة: عدد المقاطع', s.length === 3, `got ${s.length}`);
check('الشاملة: الصفحة المطبوعة كما هي', s[1].ref === '2/ 747', String(s[1].ref));
check('الشاملة: التصنيف', s[0].category === 'الفقه الحنبلي', String(s[0].category));
check('الشاملة: لا رابط خارجيّ (محلّية)', s.every((h) => h.url === undefined), JSON.stringify(s.map((h) => h.url)));

// ★ الفحص الأهمّ
check('الشاملة: متنٌ وحاشيةٌ معاً → يُؤخذ المتن ويُوسم متناً', s[0].section === 'متن' && s[0].text.includes('يَجُوزُ'), `${s[0].section} | ${s[0].text.slice(0, 40)}`);
check('الشاملة: متنٌ وحده → متن', s[1].section === 'متن', String(s[1].section));
check('★ الشاملة: حاشيةٌ وحدها → تُوسم حاشيةً ولا تُنسب للمصنِّف', s[2].section === 'حاشية' && s[2].text.includes('المحقِّق'), `${s[2].section} | ${s[2].text.slice(0, 40)}`);

// ── تنظيف وسوم الإبراز ──
const all = [...t, ...s];
check('وسوم الإبراز <em>/<mark> مُزالة من كل مقطع', all.every((h) => !/<\/?(em|mark)>/.test(h.text)), JSON.stringify(all.find((h) => /<\/?(em|mark)>/.test(h.text))?.text ?? ''));

// ── المحوّل العامّ: خادمٌ لم يُكتب له محوّل ──
const g = adapt(src('future-legal', 'مصدر قانونيّ لاحق'), {
  results: [
    { title: 'نظامٌ ما', author: 'جهة', page: 12, snippet: 'نصُّ المقطع', link: 'https://x.example/a' },
    { title: 'بلا نصّ', page: 3 },
  ],
});
check('العامّ: يقرأ شكلاً لم يُكتب له محوّل', g.length === 1 && g[0].text === 'نصُّ المقطع' && g[0].ref === '12', JSON.stringify(g));
check('العامّ: مقطعٌ بلا نصّ يُسقَط', g.length === 1, `got ${g.length}`);

// ── الصلابة ──
check('جسمٌ فارغ → []', adapt(src('turath', 'تراث'), {}).length === 0);
check('جسمٌ null → []', adapt(src('turath', 'تراث'), null).length === 0);
check('جسمٌ نصّي → []', adapt(src('turath', 'تراث'), 'لا شيء').length === 0);
check('results ليست مصفوفة → []', adapt(src('shamela', 'الشاملة'), { results: 'x' }).length === 0);

// ── السقف الكلّي ──
const big = { results: Array.from({ length: 40 }, (_, i) => ({ meta: { book_name: `ك${i}` }, text: 'ح'.repeat(1400) })) };
const capped = adapt(src('turath', 'تراث'), big);
const total = capped.reduce((n, h) => n + h.text.length, 0);
check('السقف الكلّي يمنع مزاحمة السياق النظامي', total <= 12000 && capped.length < 40, `chars=${total} hits=${capped.length}`);
check('وسقفُ المقطع الواحد', capped.every((h) => h.text.length <= 1500), 'مقطعٌ تجاوز');

console.log(`\n${pass} نجحت · ${fail} أخفقت`);
process.exit(fail ? 1 : 0);
