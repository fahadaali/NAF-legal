/**
 * ختمُ الاعتمادات في KV — لا في القاعدة، ولا خاماً.
 *
 * التفويض يُنتج ما لم تُنتجه الأنواعُ الثابتة: سرَّ عميلٍ يُسجَّل عند خادمٍ
 * أجنبيّ، ورمزَ وصولٍ يُعاد سكُّه. والأول **اعتمادٌ دائم** لا يُشبه ما في
 * `AUTH_KV`: جلسةُ `sess:` رمزٌ من المركز يموت في خمس عشرة دقيقة ومقيَّدٌ
 * بـ`aud` ويُقتل بالخروج الخلفيّ، وهذا مفتاحٌ إلى نظام طرفٍ ثالث لا أجلَ
 * نملكه ولا بابَ إبطالٍ عندنا. فمن قرأ نسخةً من المساحة قرأ مفتاحاً يعمل.
 *
 * والقاعدة مستبعدةٌ ابتداءً — `migrations/0025` تنصّ عليه — فبقي KV، ومعه
 * طبقةٌ واحدة تُناسب هذا الفرق ولا تُناسب غيره.
 *
 * **والمفتاح يُشتقّ من `AUTH_CLIENT_SECRET` بـHKDF، ولا سرَّ جديد.** سرٌّ
 * جديد هو الجواب في الكتب، وثمنُه خطوةُ إعدادٍ تُنسى فينشر العاملُ ويعطب
 * صامتاً. وهذا السرّ لازمٌ أصلاً — الدخولُ الموحّد ميّتٌ بدونه — فالمفتاح
 * موجودٌ بالضبط حين تكون المنصة صالحةً للعمل. و`info` يفصل المجال: المشتقُّ
 * هنا لا يمسّ مسار الدخول ولا العكس، والسرُّ نفسه لا يُستعمل مفتاحَ تعميةٍ
 * مباشرةً.
 *
 * **وثمنُه يُقال لا يُكتشف:** تدويرُ `AUTH_CLIENT_SECRET` — وهو إجراءٌ
 * عاديّ — يجعل كلَّ مختومٍ غيرَ مقروء. فليس ذلك عطلاً يُرمى: `open` تردّ
 * `null`، ويُمحى الصفُّ المختوم، ويعود المصدر «غير مربوط»، فيُضغط «بدء
 * التفويض» مرّةً. وهي حالُ `sessionKeyFor` نفسها في `naf-auth`، موصوفةً
 * هناك بالعبارة ذاتها.
 */
import type { Env } from '../types';

/** ترميزُ base64url. وفي `naf-auth/safe` فكُّه ولا عقدُه — فهذا مقابلُه. */
export function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** فكُّه — نسخةٌ محليّة فلا يُستورد مسارُ التفويض من حزمة الدخول الموحّد. */
export function bytesFromBase64Url(input: string): Uint8Array {
  const norm = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const SALT = 'naf-legal/mcp-oauth';
const INFO = 'mcp-oauth:v1';
const enc = (s: string) => new TextEncoder().encode(s);

/* المفتاح يُشتقّ مرّةً لعمر العازل: الاشتقاق ليس رخيصاً، والنداء قد يتكرّر
   في الدور الواحد. والسرُّ لا يُخزَّن — المشتقُّ وحده، وهو `extractable: false`. */
let cached: { secret: string; key: CryptoKey } | null = null;

async function keyFor(env: Env): Promise<CryptoKey | null> {
  const secret = env.AUTH_CLIENT_SECRET;
  if (!secret) {
    console.error('sealed: AUTH_CLIENT_SECRET غير مضبوط — لا ختم ولا فكّ');
    return null;
  }
  if (cached && cached.secret === secret) return cached.key;
  try {
    const base = await crypto.subtle.importKey('raw', enc(secret), 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc(SALT), info: enc(INFO) },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    cached = { secret, key };
    return key;
  } catch (e) {
    console.error('sealed: تعذّر اشتقاق المفتاح:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * يختم قيمةً لمفتاحٍ بعينه.
 *
 * و`slot` يدخل **بيانات المصادقة المرافقة**: مختومٌ نُسخ من مفتاح مصدرٍ إلى
 * مفتاح آخر لا يُفكّ. رخيصةٌ وحقيقية — وبدونها يكفي نقلُ قيمةٍ في المساحة
 * ليُقرأ اعتمادُ مصدرٍ في سياق غيره.
 */
export async function seal(env: Env, slot: string, value: unknown): Promise<string | null> {
  const key = await keyFor(env);
  if (!key) return null;
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc(slot) },
      key,
      enc(JSON.stringify(value))
    );
    return JSON.stringify({
      v: 1,
      iv: base64UrlFromBytes(iv),
      ct: base64UrlFromBytes(new Uint8Array(ct)),
    });
  } catch (e) {
    console.error('sealed: تعذّر الختم:', e instanceof Error ? e.message : e);
    return null;
  }
}

/** يفكّ مختوماً. و`null` لكلّ تعذّر — لا رمي: المنادي يعامله معاملة الغائب. */
export async function unseal<T>(env: Env, slot: string, sealed: string | null): Promise<T | null> {
  if (!sealed) return null;
  const key = await keyFor(env);
  if (!key) return null;
  try {
    const env_ = JSON.parse(sealed);
    if (env_?.v !== 1 || typeof env_.iv !== 'string' || typeof env_.ct !== 'string') return null;
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytesFromBase64Url(env_.iv), additionalData: enc(slot) },
      key,
      bytesFromBase64Url(env_.ct)
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    /* مفتاحٌ دُوّر، أو مختومٌ تلف، أو نُقل من مفتاحٍ آخر. وكلُّها حالٌ
       واحدة عند المنادي: لا اعتماد — فيُعاد التفويض. */
    return null;
  }
}
