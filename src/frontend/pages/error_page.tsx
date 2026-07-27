import { type ErrorComponentProps, Link, useRouter } from '@tanstack/react-router';
import { House, RotateCw } from 'lucide-react';

import { ErrorPanel } from '@/components/error_panel';
import { Button } from '@/components/ui';

export function ErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'An unexpected error occurred.';

  return (
    <main data-component="ErrorPage" className="flex min-h-0 flex-1 flex-col">
      <ErrorPanel title="Something went wrong" message={message}>
        <Button
          variant="primary"
          onClick={() => {
            reset();
            void router.invalidate();
          }}
        >
          <RotateCw className="size-4" />
          Try again
        </Button>
        <Link
          to="/"
          onClick={() => reset()}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-line bg-panel px-4 text-sm font-semibold text-white hover:border-cyan/60 hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          <House className="size-4" />
          Go home
        </Link>
      </ErrorPanel>
    </main>
  );
}
