/* توليد أيقونات تطبيق الشاشة الرئيسية من علامة ناف.

   يُشغَّل عند تغيّر العلامة أو تغيّر ‎--background‎ في الثيم، لا مع كل بناء:
   المخرجات ملفّات ثابتة تُودَع في المستودع، فلا يحتاج البناء أن يرسم صوراً
   ولا أن تحمل كلُّ منصةٍ حزمةَ رسم في تبعياتها.

     node scripts/build-app-icons.mjs

   ═══ لماذا PNG ولا SVG ═══

   آيفون يتجاهل SVG في ‎apple-touch-icon‎ ولا يقرأ إلا نقطية. وأندرويد يقبل
   SVG في المانيفست ولا يقبله كلُّ متصفّح. فالنقطية هي القاسم المشترك.

   ═══ لماذا خلفية معتمة ═══

   آيفون يسطّح الشفافية على أسود، فأيقونةٌ شفافة تظهر علامةً داكنة على سواد.
   والخلفية هنا ليست قيمةً مكتوبة: تُقرأ من ‎--background‎ في الثيم وتُحوَّل
   من oklch إلى sRGB. فإن تغيّر جذر الثيم تغيّرت الأيقونة بإعادة التشغيل، ولا
   يبقى لونٌ ثالث في النظام يفترق عن الاثنين. وهذا هو نفس منطق استثناء
   ‎<meta name="theme-color">‎ في CLAUDE.md §١: سياقٌ لا يقرأ خاصية مخصّصة،
   فتُشتقّ القيمة من الرمز ولا تُخمَّن.

   ═══ لماذا مقاسان وقناعان ═══

   ‎icon-192‎ و‎icon-512‎ للمانيفست، و‎apple-touch-icon‎ بـ180 لآيفون — وهو
   وحده ما يقرؤه، ولا يقرأ المانيفست في هذا الموضع.

   و‎icon-maskable-512‎ نسخةٌ ثانية بهامش أوسع: أندرويد يقصّ الأيقونة بشكلٍ
   تختاره الشركة المصنّعة — دائرة أو مربّع مستدير أو قطرة — ولا يضمن إلا
   الثمانين بالمئة الوسطى. فالعلامة فيها أصغر، ولولاها لقُصّت أطرافها. */

import { Resvg } from "@resvg/resvg-js"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"

/* ═══ من oklch إلى sRGB ═══

   المعاملات معاملاتُ Björn Ottosson المنشورة مع OKLab، لا أرقاماً مضبوطة
   بالعين. والمسار: oklch → OKLab → LMS → sRGB خطّي → sRGB بتصحيح جاما. */
function oklchToHex(lightness, chroma, hueDegrees) {
  const hue = (hueDegrees * Math.PI) / 180
  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3

  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]

  const channels = linear.map((value) => {
    const clamped = Math.min(1, Math.max(0, value))
    const gamma = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055
    return Math.round(gamma * 255)
      .toString(16)
      .padStart(2, "0")
  })

  return `#${channels.join("")}`
}

/* أوّل ‎--background‎ في الملف هو تعريف ‎:root‎ — الوضع الفاتح. وكتلة
   ‎.dark‎ تليه ولا تُقرأ: الأيقونة واحدة على الجهاز ولا تتبع مظهر القارئ. */
function readLightBackground(themePath) {
  const css = readFileSync(themePath, "utf8")
  const match = css.match(/--background:\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/)
  if (!match) {
    throw new Error(`تعذّرت قراءة --background من ${themePath} — لا تكتب اللون يدوياً، أصلح المسار`)
  }
  return oklchToHex(Number(match[1]), Number(match[2]), Number(match[3]))
}

/* العلامة تُدرَج صورةً داخل لوحةٍ مربّعة بدل نسخ مساراتها: نسخُ المسارات
   يعني نسخةً ثانية من الأصل تفترق عنه بعد أول تعديل، والقاعدة تمنع تعديل
   الأصل أصلاً. */
function compose(markSvg, size, background, inset) {
  const box = Math.round(size * inset)
  const offset = Math.round((size - box) / 2)
  const encoded = Buffer.from(markSvg, "utf8").toString("base64")

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${background}"/>
  <image x="${offset}" y="${offset}" width="${box}" height="${box}" href="data:image/svg+xml;base64,${encoded}"/>
</svg>`
}

function render(svg, size, outputPath) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng()
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, png)
  return png.length
}

/* المخرجات الأربعة.

   ‎inset‎ نسبةُ لوحة العلامة من ضلع الأيقونة، لا نسبةُ حبرها: ملفّ العلامة
   مربّع 1080 وفيه هامشٌ داخليّ، وحبرُ كلمة «ناف» يشغل نحو 76% من عرضه
   و37% من ارتفاعه — كلمةٌ عريضة قصيرة لا تملأ مربّعاً مهما كُبّرت.

   فـ1 للأيقونة العادية: هامش الملفّ نفسه يكفي حاجزاً عن الحافة المستديرة،
   وإضافةُ هامشٍ ثانٍ فوقه تترك الكلمة تسبح في فراغ. و0.92 للقابلة للقصّ،
   فيبقى الحبر داخل الثمانين بالمئة المضمونة مهما كان شكل القصّ. */
const OUTPUTS = [
  { file: "icon-192.png", size: 192, inset: 1 },
  { file: "icon-512.png", size: 512, inset: 1 },
  { file: "icon-maskable-512.png", size: 512, inset: 0.92 },
  { file: "apple-touch-icon.png", size: 180, inset: 1 },
]

export function buildAppIcons({ markPath, themePath, outputDir }) {
  const background = readLightBackground(themePath)
  const markSvg = readFileSync(markPath, "utf8")

  return OUTPUTS.map(({ file, size, inset }) => {
    const bytes = render(compose(markSvg, size, background, inset), size, resolve(outputDir, file))
    return { file, size, bytes, background }
  })
}

/* ═══ التشغيل ═══

   المسارات الثلاثة تُمرَّر وسائطَ سطر أوامر، لأن المستودعات لا تتّفق على
   موضع واحد: العلامة في ‎public/brand‎ هنا وفي ‎web/public/brand‎ هناك.
   وتخمينُ الموضع يُنتج سكربتاً يعمل في مستودعٍ ويصمت في آخر.

     node scripts/build-app-icons.mjs <العلامة> <الثيم> <مجلّد المخرجات>

   والأمر المكتمل يُودَع في ‎package.json‎ تحت ‎icons‎، فيُكتب مرة واحدة.

   ويطبع لونَ الخلفية بعد التحويل: هو نفسه ما يُنسخ إلى ‎background_color‎
   و‎theme_color‎ في المانيفست، فلا يُخمَّن هناك. */
const [markArg, themeArg, outputArg] = process.argv.slice(2)

if (markArg && themeArg && outputArg) {
  const built = buildAppIcons({
    markPath: markArg,
    themePath: themeArg,
    outputDir: outputArg,
  })

  for (const { file, size } of built) {
    console.log(`  ${file} — ${size}×${size}`)
  }
  console.log(`\n  الخلفية: ${built[0].background}  ← انسخها إلى background_color و theme_color`)
}
