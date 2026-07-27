import { Link } from '@tanstack/react-router';
import { LoaderCircle, ShieldCheck } from 'lucide-react';

import type { IProcessListResult } from '@shared/contracts';

export function HostStatus({
  data,
  showHost = true,
}: {
  data?: IProcessListResult;
  showHost?: boolean;
}) {
  const online = data?.processes.filter(process => process.status === 'online').length || 0;
  const offline = (data?.processes.length || 0) - online;

  return (
    <div
      data-component="HostStatus"
      className="flex items-center gap-4 font-mono text-xs text-muted"
    >
      {showHost && data?.hostLabel ? <span className="truncate">{data.hostLabel}</span> : null}
      <span className="flex items-center gap-2">
        <i className="size-2 rounded-full bg-online shadow-[0_0_10px_#35D07F]" />
        {online}
      </span>
      <span className="flex items-center gap-2">
        <i className="size-2 rounded-full border border-muted" />
        {offline}
      </span>
    </div>
  );
}

export function AppHeader({
  data,
  loading,
  failed,
  sidebar = false,
}: {
  data?: IProcessListResult;
  loading: boolean;
  failed: boolean;
  sidebar?: boolean;
}) {
  return (
    <header
      data-component="AppHeader"
      className={
        sidebar
          ? 'flex h-16 shrink-0 items-center justify-between border-b border-line bg-panel/45 px-4 sm:px-5'
          : 'flex h-16 shrink-0 items-center justify-between border-b border-line bg-topbar px-4 sm:px-5'
      }
    >
      <div className="flex min-w-0 items-center gap-3">
        <Link
          to="/"
          className="flex min-w-0 items-center gap-3 rounded-md hover:brightness-125 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          <div className="relative grid size-8 place-items-center">
            <img
              src="/pm2-captain-logo-on-dark.png"
              alt=""
              className="size-8 object-contain"
              onError={event => {
                event.currentTarget.style.display = 'none';
                event.currentTarget.nextElementSibling?.classList.remove('hidden');
              }}
            />
            <ShieldCheck className="hidden size-7 text-cyan" aria-hidden="true" />
          </div>
          <div className="whitespace-nowrap text-lg font-bold">
            <span className="text-white">PM2 </span>
            <span className="text-cyan">Captain</span>
          </div>
        </Link>
        {!sidebar && loading ? (
          <LoaderCircle
            className="hidden size-3.5 animate-spin text-cyan sm:block"
            aria-label="Loading PM2 processes"
          />
        ) : !sidebar && data?.hostLabel ? (
          <span className="hidden truncate font-mono text-xs text-muted sm:block">
            {data.hostLabel}
          </span>
        ) : !sidebar && failed ? (
          <span className="hidden truncate font-mono text-xs text-danger sm:block">
            PM2 unavailable
          </span>
        ) : null}
      </div>
      {!sidebar ? <HostStatus data={data} showHost={false} /> : null}
    </header>
  );
}
