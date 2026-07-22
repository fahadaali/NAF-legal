#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# إعداد موارد Cloudflare لمنصّة «مستشار ناف» وربطها.
# يُنشئ: D1 · R2 · Vectorize (فهرسان) · KV · Queue، ويحدّث wrangler.toml
# بالمعرّفات، ثم يطبّق ترحيلات قاعدة البيانات على السحابة.
#
# المتطلّبات: سجّل الدخول أولًا:  npx wrangler login
# التشغيل:  bash scripts/setup-cloudflare.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

TOML=wrangler.toml
say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }
ok()  { printf '\033[1;32m✓ %s\033[0m\n' "$1"; }

# استخراج قيمة من ناتج wrangler عبر مفتاح (يدعم صيغ JSON/TOML الشائعة)
extract_id() { grep -oE '[0-9a-f]{32}' | head -1; }

say "التحقّق من تسجيل الدخول إلى Cloudflare"
npx wrangler whoami >/dev/null 2>&1 || { echo "سجّل الدخول أولًا: npx wrangler login"; exit 1; }
ok "مسجّل الدخول"

# ── D1 ──
say "إنشاء قاعدة بيانات D1 (naf_legal)"
D1_OUT=$(npx wrangler d1 create naf_legal 2>&1 || true)
echo "$D1_OUT"
D1_ID=$(echo "$D1_OUT" | grep -oE '"?database_id"?[ =:]+"?[0-9a-f-]{36}"?' | grep -oE '[0-9a-f-]{36}' | head -1 || true)
if [ -z "${D1_ID:-}" ]; then
  echo "لم أستطع قراءة database_id تلقائيًا (قد تكون موجودة). نفّذ: npx wrangler d1 list ثم ضع المعرّف يدويًا في $TOML"
else
  sed -i.bak "s/REPLACE_WITH_D1_ID/$D1_ID/" "$TOML" && ok "D1 id = $D1_ID"
fi

# ── R2 ──
say "إنشاء حاوية R2 (naf-legal-files)"
npx wrangler r2 bucket create naf-legal-files 2>&1 || echo "(قد تكون موجودة)"
ok "R2 جاهزة"

# ── Vectorize (بُعد 1024 مطابق لـ bge-m3) ──
say "إنشاء فهرس Vectorize لقاعدة المعرفة"
npx wrangler vectorize create naf-legal-kb --dimensions=1024 --metric=cosine 2>&1 || echo "(قد يكون موجودًا)"
say "إنشاء فهرس Vectorize لبحث المحادثات"
npx wrangler vectorize create naf-legal-conv --dimensions=1024 --metric=cosine 2>&1 || echo "(قد يكون موجودًا)"
ok "Vectorize جاهز"

# ── KV ──
say "إنشاء مساحة KV"
KV_OUT=$(npx wrangler kv namespace create KV 2>&1 || true)
echo "$KV_OUT"
KV_ID=$(echo "$KV_OUT" | grep -oE 'id ?= ?"?[0-9a-f]{32}"?' | extract_id || true)
if [ -z "${KV_ID:-}" ]; then
  echo "لم أستطع قراءة KV id تلقائيًا. نفّذ: npx wrangler kv namespace list ثم ضعه يدويًا في $TOML"
else
  sed -i.bak "s/REPLACE_WITH_KV_ID/$KV_ID/" "$TOML" && ok "KV id = $KV_ID"
fi

# ── Queue ──
say "إنشاء طابور المعالجة (naf-legal-ingest)"
npx wrangler queues create naf-legal-ingest 2>&1 || echo "(قد يكون موجودًا)"
ok "Queue جاهز"

# ── الأسرار ──
say "الأسرار المطلوبة (تُدخَل مرّة واحدة)"
echo "شغّل الأوامر التالية وأدخِل القيم عند الطلب:"
echo "  npx wrangler secret put ANTHROPIC_API_KEY"
echo "  npx wrangler secret put JWT_SECRET   # سلسلة عشوائية طويلة، مثل: openssl rand -hex 32"

# ── الترحيلات على السحابة ──
say "تطبيق ترحيلات قاعدة البيانات على السحابة"
read -r -p "تطبيق الترحيلات الآن على D1 البعيدة؟ [y/N] " ans
if [ "${ans:-N}" = "y" ] || [ "${ans:-N}" = "Y" ]; then
  npx wrangler d1 migrations apply naf_legal --remote
  ok "الترحيلات مطبَّقة"
fi

rm -f "$TOML.bak"
say "اكتمل الإعداد. للنشر:  npm run deploy"
echo "بعد النشر: افتح الموقع وأنشئ حساب المسؤول الأول، ثم أضِف بقية المستخدمين من لوحة الإدارة."
