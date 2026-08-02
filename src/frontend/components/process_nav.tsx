import { Link, useNavigate } from '@tanstack/react-router';
import {
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';

import { processDetailTo } from '@/lib/process_tab';
import { cn } from '@/lib/utils';

import type { IProcessSummary } from '@shared/contracts';

function NavKeysHint({ className }: { className?: string }) {
  return (
    <svg
      data-component="NavKeysHint"
      viewBox="0 0 12 16"
      width={12}
      height={16}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={className}
    >
      <path d="M6 1.5 10.5 7H1.5L6 1.5Z" fill="currentColor" strokeLinejoin="round" />
      <path d="M6 14.5 1.5 9h9L6 14.5Z" fill="currentColor" strokeLinejoin="round" />
    </svg>
  );
}

export function ProcessNav({
  processes,
  selectedId,
  className,
  itemClassName,
  selectedItemClassName,
  idleItemClassName,
  onItemClick,
  leading,
  autoFocus = false,
}: {
  processes: IProcessSummary[];
  selectedId: number;
  className?: string;
  itemClassName?: string;
  selectedItemClassName?: string;
  idleItemClassName?: string;
  onItemClick?: () => void;
  leading?: (process: IProcessSummary, isSelected: boolean) => ReactNode;
  autoFocus?: boolean;
}) {
  const navigate = useNavigate();
  const navRef = useRef<HTMLElement>(null);
  const keepFocusRef = useRef(false);
  const didAutoFocusRef = useRef(false);
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!autoFocus || didAutoFocusRef.current) {
      return;
    }
    didAutoFocusRef.current = true;
    navRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (!keepFocusRef.current) {
      return;
    }
    keepFocusRef.current = false;
    navRef.current?.focus();
    navRef.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const handleFocus = () => {
    setIsFocused(true);
  };

  const handleBlur = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsFocused(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      void navigate({ to: '/' });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      onItemClick?.();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    event.preventDefault();
    if (!processes.length) {
      return;
    }
    const currentIndex = processes.findIndex(process => process.pmId === selectedId);
    const baseIndex = currentIndex < 0 ? 0 : currentIndex;
    const nextIndex =
      event.key === 'ArrowDown'
        ? Math.min(baseIndex + 1, processes.length - 1)
        : Math.max(baseIndex - 1, 0);
    if (nextIndex === currentIndex) {
      return;
    }
    const next = processes[nextIndex];
    keepFocusRef.current = true;
    void navigate({
      to: processDetailTo(),
      params: { pmId: String(next.pmId) },
    });
  };

  return (
    <nav
      data-component="ProcessNav"
      ref={navRef}
      aria-label="Processes"
      tabIndex={0}
      className={cn('outline-none', className)}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      {processes.map(process => {
        const isSelected = process.pmId === selectedId;
        return (
          <Link
            key={process.pmId}
            to={processDetailTo()}
            params={{ pmId: String(process.pmId) }}
            onClick={onItemClick}
            className={cn(itemClassName, isSelected ? selectedItemClassName : idleItemClassName)}
          >
            {leading?.(process, isSelected)}
            <i
              className={cn(
                'size-2 shrink-0 rounded-full',
                process.status === 'online'
                  ? 'bg-online shadow-[0_0_9px_#35D07F]'
                  : 'border border-muted'
              )}
            />
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="truncate font-semibold">{process.name}</span>
              {process.isCaptain ? (
                <img
                  src="/pm2-captain-logo-on-dark.png"
                  alt="Captain"
                  title="This is Captain"
                  className="size-3.5 shrink-0 object-contain"
                />
              ) : null}
            </span>
            {isSelected && isFocused ? <NavKeysHint className="shrink-0 text-cyan/40" /> : null}
          </Link>
        );
      })}
    </nav>
  );
}
