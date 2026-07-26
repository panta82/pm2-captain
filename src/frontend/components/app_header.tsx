import { ShieldCheck } from 'lucide-react';

import type { ProcessListResult } from '@shared/contracts';

export function AppHeader({ data }: { data?: ProcessListResult }) {
  const online = data?.processes.filter(process => process.status === 'online').length || 0;
  const offline = (data?.processes.length || 0) - online;

  return (
    <header className="flex h-[58px] shrink-0 items-center justify-between border-b border-line bg-topbar px-4 sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <div className="relative grid size-8 place-items-center">
          <img
            src="/pm2-captain-logo.png"
            alt=""
            className="size-8 object-contain"
            onError={event => {
              event.currentTarget.style.display = 'none';
              event.currentTarget.nextElementSibling?.classList.remove('hidden');
            }}
          />
          <ShieldCheck className="hidden size-7 text-cyan" aria-hidden="true" />
        </div>
        <div className="whitespace-nowrap text-lg font-bold tracking-tight">
          <span className="text-white">PM2 </span>
          <span className="text-cyan">Captain</span>
        </div>
        <span className="hidden truncate font-mono text-xs text-muted sm:block">
          {data?.hostLabel || 'connecting…'}
        </span>
      </div>
      <div className="flex items-center gap-4 font-mono text-xs text-muted">
        <span className="flex items-center gap-2">
          <i className="size-2 rounded-full bg-online shadow-[0_0_10px_#35D07F]" />
          {online}
        </span>
        <span className="flex items-center gap-2">
          <i className="size-2 rounded-full border border-muted" />
          {offline}
        </span>
      </div>
    </header>
  );
}
