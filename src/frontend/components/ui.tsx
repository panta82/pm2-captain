import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

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

export function ConfirmAction({
  title,
  description,
  trigger,
  confirmLabel,
  onConfirm,
}: {
  title: string;
  description: string;
  trigger: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,440px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-panel p-6 shadow-2xl">
          <AlertDialog.Title className="text-lg font-bold text-white">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-6 text-muted">
            {description}
          </AlertDialog.Description>
          <div className="mt-6 flex justify-end gap-3">
            <AlertDialog.Cancel asChild>
              <Button>Cancel</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant="danger" onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-white/7', className)} />;
}
