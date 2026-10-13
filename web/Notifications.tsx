import { useEffect, useRef, useState } from 'react';
import { Bell, CheckCheck, RefreshCw, X, ArrowUpLeft } from 'lucide-react';
import { api } from './api.js';
import type { NotificationFeed, UserNotification } from '../shared/notifications.js';

export function focusNotificationTarget(id: string) {
  const find = () => {
    const element = [...document.querySelectorAll<HTMLElement>('[data-notification-target]')].find(
      (el) => el.dataset.notificationTarget === id,
    );
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element.focus({ preventScroll: true });
      return true;
    }
    return false;
  };
  if (find()) return;
  const observer = new MutationObserver(() => {
    if (find()) observer.disconnect();
  });
  observer.observe(document.getElementById('root')!, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 5000);
}

export function Notifications({
  identity,
  customer = false,
  onOpen,
}: {
  identity: string;
  customer?: boolean;
  onOpen: (item: UserNotification) => void;
}) {
  const [feed, setFeed] = useState<NotificationFeed>({ items: [], unread: 0 });
  const [open, setOpen] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const container = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const endpoint = customer ? '/api/storefront/notifications' : '/api/notifications';
  const generation = useRef(0);
  useEffect(() => {
    const serial = ++generation.current;
    let active = true,
      pending = false;
    setFeed({ items: [], unread: 0 });
    setOpen(false);
    setError('');
    async function load() {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const next = await api<NotificationFeed>(endpoint);
        if (active && serial === generation.current) {
          setFeed(next);
          setError('');
        }
      } catch {
        if (active && serial === generation.current)
          setError('تعذر تحديث الإشعارات. أعد المحاولة.');
      } finally {
        pending = false;
      }
    }
    void load();
    const timer = setInterval(() => void load(), 15000);
    const refresh = () => void load();
    window.addEventListener('logistics:updated', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('logistics:updated', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [endpoint, identity]);
  useEffect(() => {
    if (!open) return;
    container.current?.querySelector<HTMLButtonElement>('.notification-close')?.focus();
    function close(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    }
    function outside(e: PointerEvent) {
      if (!container.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', close);
      document.removeEventListener('pointerdown', outside);
    };
  }, [open]);
  async function read(ids: string[]) {
    if (busy || !ids.length) return;
    setBusy(true);
    const serial = generation.current;
    try {
      await api(endpoint + '/read', { method: 'POST', body: JSON.stringify({ ids }) });
      if (serial === generation.current)
        setFeed((current) => {
          const items = current.items.map((n) => (ids.includes(n.id) ? { ...n, read: true } : n));
          return { items, unread: items.filter((n) => !n.read).length };
        });
    } catch {
      if (serial === generation.current) setError('تعذر حفظ حالة القراءة. أعد المحاولة.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="notification-control" ref={container}>
      <button
        ref={trigger}
        type="button"
        className="notification-trigger"
        aria-label={`الإشعارات${feed.unread ? '، ' + feed.unread + ' غير مقروءة' : ''}`}
        aria-expanded={open}
        aria-controls="notification-panel"
        onClick={() => setOpen(!open)}
      >
        <Bell size={20} />
        {feed.unread > 0 && <span>{feed.unread > 99 ? '99+' : feed.unread}</span>}
      </button>
      {open && (
        <section id="notification-panel" className="notification-panel" aria-label="مركز الإشعارات">
          <header>
            <div>
              <h2>الإشعارات</h2>
              <p>المهام والتحديثات الخاصة بحسابك</p>
            </div>
            <button
              className="icon-button notification-close"
              aria-label="إغلاق الإشعارات"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <X size={19} />
            </button>
          </header>
          <div className="notification-tools">
            <span>{feed.unread} غير مقروءة</span>
            <button
              type="button"
              disabled={busy || !feed.unread}
              onClick={() => void read(feed.items.filter((n) => !n.read).map((n) => n.id))}
            >
              <CheckCheck size={16} />
              تحديد الكل كمقروء
            </button>
          </div>
          {error && (
            <div className="notification-error" role="alert">
              {error}
              <button
                type="button"
                onClick={() => window.dispatchEvent(new Event('logistics:updated'))}
              >
                <RefreshCw size={15} />
                تحديث
              </button>
            </div>
          )}
          <div className="notification-list">
            {!feed.items.length && !error && (
              <p className="notification-empty">ما في تحديثات لحسابك حاليًا.</p>
            )}
            {feed.items.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`notification-item ${item.read ? '' : 'is-unread'}`}
                onClick={() => {
                  void read([item.id]);
                  setOpen(false);
                  onOpen(item);
                }}
              >
                <span className="notification-dot" />
                <div>
                  <strong>{item.title}</strong>
                  <span dir="auto">{item.reference}</span>
                  <small>
                    {item.actionRequired ? 'إجراء مطلوب · ' : ''}
                    {new Intl.DateTimeFormat('ar-SY', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    }).format(new Date(item.createdAt))}
                  </small>
                </div>
                <ArrowUpLeft size={17} />
              </button>
            ))}
          </div>
          <footer>تحديث تلقائي أثناء فتح الموقع. فتح الإشعار لا ينفّذ الإجراء.</footer>
        </section>
      )}
    </div>
  );
}
