import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { formatDate, formatTime } from '../lib/format';
import { Icon, ICON_MD } from '../lib/icons';

// جرس الإشعارات داخل المنصّة
export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<any[]>([]);
  const [unread, setUnread] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);

  const load = () =>
    api.notifications().then((r) => {
      setItems(r.notifications);
      setUnread(r.unread);
    }).catch(() => {});

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000); // تحديث كل دقيقة
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (open && wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [open]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && unread > 0) {
      await api.markNotificationsRead().catch(() => {});
      setUnread(0);
      load();
    }
  };

  return (
    <div className="notif-wrap" ref={wrap}>
      <button className="theme-toggle" onClick={toggle} title="الإشعارات">
        <Icon.notifications size={ICON_MD} aria-hidden />{unread > 0 && <span className="notif-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="notif-panel">
          <div className="notif-head">الإشعارات</div>
          {items.length === 0 ? (
            <div className="empty-state" style={{ padding: 24, fontSize: '0.875rem' }}>لا إشعارات.</div>
          ) : (
            items.map((n) => (
              <div key={n.id} className={`notif-item ${n.read_at ? '' : 'unread'}`}>
                <div className="notif-title">{n.title}</div>
                {n.body && <div className="notif-body">{n.body}</div>}
                <div className="notif-time"><bdi>{formatDate(n.created_at)} {formatTime(n.created_at)}</bdi></div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
