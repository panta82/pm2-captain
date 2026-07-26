import { LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

const RECONNECT_KEY = 'pm2-captain-reconnecting';

export function RestartOverlay() {
  const [reconnecting, setReconnecting] = useState(
    () => sessionStorage.getItem(RECONNECT_KEY) === 'true'
  );

  useEffect(() => {
    const begin = () => setReconnecting(true);
    window.addEventListener('pm2-captain-reconnecting', begin);
    return () => window.removeEventListener('pm2-captain-reconnecting', begin);
  }, []);

  useEffect(() => {
    if (!reconnecting) {
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch('/health', { cache: 'no-store' });
        if (response.ok && !cancelled) {
          sessionStorage.removeItem(RECONNECT_KEY);
          window.location.reload();
          return;
        }
      } catch {
        // A connection failure is expected while Captain is restarting.
      }
      if (!cancelled) {
        window.setTimeout(poll, 750);
      }
    };
    const timer = window.setTimeout(poll, 750);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [reconnecting]);

  if (!reconnecting) {
    return null;
  }
  return (
    <div
      data-component="RestartOverlay"
      className="fixed inset-0 z-[100] grid place-items-center bg-topbar/90 backdrop-blur-sm"
    >
      <div className="rounded-xl border border-primary/50 bg-panel px-8 py-7 text-center shadow-2xl">
        <LoaderCircle className="mx-auto size-7 animate-spin text-cyan" />
        <p className="mt-4 font-semibold text-white">Captain is restarting…</p>
        <p className="mt-1 font-mono text-xs text-muted">Reconnecting automatically</p>
      </div>
    </div>
  );
}
