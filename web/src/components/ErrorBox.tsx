/* صندوقُ خطأٍ بنمط المنصة (`.error-box`): أيقونةُ «فشل» المسجّلة ونصٌّ يقول ما
   حدث وما العمل. موضعٌ واحد لشاشات الربط — كان مكرّراً في `Connect.tsx` و
   `AiTools.tsx`. ولا يُرسَم شيء بلا نصّ. */

import { Icon, ICON_SM } from '../lib/icons';

export default function ErrorBox({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="error-box" role="alert">
      <Icon.failed size={ICON_SM} aria-hidden />
      <span>{message}</span>
    </div>
  );
}
