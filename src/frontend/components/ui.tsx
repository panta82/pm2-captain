import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

export function Button({
  className,
  variant = 'secondary',
  loading,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  loading?: boolean;
}) {
  return (
    <button
      className={cn(
        'inline-flex h-10 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-45',
        variant === 'primary' && 'border-primary bg-primary text-white hover:bg-[#3188ff]',
        variant === 'secondary' &&
          'border-line bg-panel text-white hover:border-cyan/60 hover:bg-panel-hover',
        variant === 'ghost' &&
          'border-transparent bg-transparent text-muted hover:bg-panel hover:text-white',
        variant === 'danger' &&
          'border-danger/50 bg-danger/10 text-danger hover:bg-danger/20',
        className
      )}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" /> : null}
      {children}
    </button>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-white/7', className)} />;
}
