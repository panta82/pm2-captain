import type { ButtonHTMLAttributes, HTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

export function Button({
  className,
  variant = 'secondary',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'toggle' | 'ghost' | 'danger';
}) {
  return (
    <button
      className={cn(
        'inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-transparent px-4 text-sm font-semibold transition-[background-color,box-shadow,color,transform] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-45',
        variant === 'primary' &&
          'bg-primary text-white shadow-[0_2px_0_var(--color-primary-edge),inset_0_1px_0_rgb(255_255_255_/_0.14)] hover:bg-primary-hover active:translate-y-px active:shadow-[0_1px_0_var(--color-primary-edge)]',
        variant === 'secondary' &&
          'bg-key text-control-muted shadow-[0_2px_0_var(--color-key-edge),inset_0_1px_0_rgb(255_255_255_/_0.06)] hover:bg-key-hover hover:text-white active:translate-y-px active:shadow-[0_1px_0_var(--color-key-edge)]',
        variant === 'toggle' &&
          'bg-key text-control-muted shadow-[0_2px_0_var(--color-key-edge),inset_0_1px_0_rgb(255_255_255_/_0.06)] hover:bg-key-hover hover:text-white active:translate-y-px aria-pressed:translate-y-px aria-pressed:bg-key-pressed aria-pressed:text-key-pressed-ink aria-pressed:shadow-[inset_0_2px_4px_rgb(0_0_0_/_0.42),inset_0_0_0_1px_rgb(0_0_0_/_0.22)] aria-pressed:hover:bg-key',
        variant === 'ghost' &&
          'border-transparent bg-transparent text-control-muted hover:bg-panel hover:text-white',
        variant === 'danger' && 'border-danger/50 bg-danger/10 text-danger hover:bg-danger/20',
        className
      )}
      {...props}
      data-component="Button"
    >
      {children}
    </button>
  );
}

export function ToggleGroup({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="group"
      className={cn('inline-flex gap-1 rounded-[10px] border border-line bg-topbar p-1', className)}
      {...props}
      data-component="ToggleGroup"
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div data-component="Skeleton" className={cn('animate-pulse rounded bg-white/7', className)} />
  );
}
