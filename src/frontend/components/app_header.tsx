import { Link } from '@tanstack/react-router';
import { LoaderCircle, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';

import { useDaemonSelection } from '@/lib/daemon_selection';
import { cn } from '@/lib/utils';

import type { IProcessListResult } from '@shared/contracts';

import { DaemonPicker } from './daemon_picker';
import { ProcessCounts } from './process_counts';

export function AppHeader({
  data,
  loading,
  failed,
  sidebar = false,
  filter,
}: {
  data?: IProcessListResult;
  loading: boolean;
  failed: boolean;
  sidebar?: boolean;
  filter?: ReactNode;
}) {
  const { selectedDaemonId } = useDaemonSelection();

  return (
    <header
      data-component="AppHeader"
      className={
        sidebar
          ? '@container flex h-16 shrink-0 items-center gap-3 border-b border-line bg-surface-menu px-4 sm:px-5'
          : cn(
              'flex shrink-0 flex-wrap items-center gap-x-3 border-b border-line bg-surface-menu px-3 lg:h-16 lg:flex-nowrap lg:gap-3 lg:px-5',
              filter ? 'gap-y-2 py-2.5 lg:py-0' : 'h-16 px-4'
            )
      }
    >
      <div
        className={
          sidebar ? 'flex min-w-0 items-center gap-3' : 'order-1 flex min-w-0 items-center gap-3'
        }
      >
        <Link
          to="/"
          aria-label="PM2 Captain"
          className="flex min-w-0 items-center gap-3 rounded-md hover:brightness-125 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          <div className="relative grid size-8 shrink-0 place-items-center">
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
          {/* The hat alone leaves the daemon picker enough room in a narrow header. */}
          <div
            className={cn(
              'hidden whitespace-nowrap text-lg font-bold',
              sidebar ? '@[21rem]:block' : 'sm:block'
            )}
          >
            <span className="text-white">PM2 </span>
            <span className="text-cyan">Captain</span>
          </div>
        </Link>
        {!sidebar && loading ? (
          <LoaderCircle
            className="hidden size-3.5 animate-spin text-cyan sm:block"
            aria-label="Loading PM2 processes"
          />
        ) : !sidebar && failed && !data ? (
          <span className="hidden truncate font-mono text-xs text-danger sm:block">
            PM2 unavailable
          </span>
        ) : null}
      </div>
      {/* Once loaded, the picker holds this slot even when a later request
          fails; the page itself reports the failure. */}
      {data ? (
        <DaemonPicker
          data={data}
          className={sidebar ? 'flex-1' : 'order-2 flex-1 lg:w-64 lg:flex-none'}
        />
      ) : null}
      {!sidebar ? (
        <ProcessCounts
          processes={data?.processes.filter(process => process.daemonId === selectedDaemonId) || []}
          className="order-3 shrink-0 sm:gap-4 lg:order-5"
        />
      ) : null}
      {!sidebar ? <div className="order-3 hidden min-w-0 lg:block lg:flex-1" /> : null}
      {!sidebar && filter ? (
        <div className="order-4 w-full min-w-0 basis-full lg:w-[min(28rem,40vw)] lg:max-w-md lg:basis-auto lg:justify-self-end">
          {filter}
        </div>
      ) : null}
    </header>
  );
}
