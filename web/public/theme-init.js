/* ضبط المظهر قبل أوّل رسم — ملفٌّ لا نصٌّ مضمَّن.
 *
 * كان في `<script>` داخل `index.html`، وسياسة المحتوى (`script-src 'self'`)
 * تمنع المضمَّن — فلولا إخراجه لسقط النصُّ صامتاً وبدأت كلُّ صفحةٍ فاتحةً
 * ثم قفزت إلى الداكن عند تركيب React.
 *
 * ويُحمَّل بوسمٍ عاديّ في `<head>` بلا `defer` ولا `type=module`: كلاهما
 * يؤجّل التنفيذ إلى ما بعد تحليل المستند، وهو بالضبط ما يُنتج الوميض الذي
 * وُضع هذا الملف لمنعه.
 *
 * والآلية صنف `dark` على الجذر — آليةُ ثيم ناف نفسها، لا سمة `data-theme`.
 * والمفتاح لا يُخزَّن إلا عند اختيار صريح، فغيابه معناه «يتبع النظام».
 *
 * ونظيره في `web/src/lib/theme.ts`؛ وأيُّ تغيير هنا يلزمه تغييرٌ هناك —
 * ومنهما معاً قيمتا `theme-color`.
 */
(function () {
  var dark;
  try {
    var saved = localStorage.getItem('naf-theme');
    dark = saved === 'dark' || (saved !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  } catch (e) {
    /* التخزين ممنوع في هذا المتصفّح. والرجوع إلى تفضيل النظام لا إلى الداكن
       ثابتاً: `theme.ts` يرجع إلى «يتبع النظام» في الحالة نفسها، وفرضُ
       الداكن هنا كان يجعل الصفحة تبدأ داكنةً ثم تنقلب فاتحةً بعد التركيب. */
    dark = matchMedia('(prefers-color-scheme: dark)').matches;
  }
  document.documentElement.classList.toggle('dark', dark);

  /* والوسم يُضبط هنا أيضاً لا عند التركيب وحده.
     القيمتان هما `--background` في الوضعين حرفياً، مكتوبتان hex بموجب
     استثناء <meta name="theme-color"> في CLAUDE.md §1: الوسم لا يحلّ var().
     أي تغيير في الثيم يستوجب تحديثهما هنا وفي `theme.ts`. */
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#1c2433' : '#e8ebed');
})();
