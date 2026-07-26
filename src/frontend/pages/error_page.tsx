import { type ErrorComponentProps, Link, useRouter } from '@tanstack/react-router';
import { House, RotateCw } from 'lucide-react';

import { Button } from '@/components/ui';

function ErrorIcon() {
  return (
    <svg
      data-component="ErrorIcon"
      viewBox="0 0 64 56"
      width={84}
      height={74}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className="mx-auto text-danger"
    >
      <path
        d="M26.2 9.2
           Q32 2.8 37.8 9.2
           L54.8 43.8
           Q58.5 51.5 50.8 51.5
           H13.2
           Q5.5 51.5 9.2 43.8
           Z"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <text
        x="32"
        y="40"
        textAnchor="middle"
        fill="currentColor"
        fontSize="14"
        fontWeight="700"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
      >
        ERR
      </text>
    </svg>
  );
}

export function ErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'An unexpected error occurred.';

  return (
    <main data-component="ErrorPage" className="grid min-h-0 flex-1 place-items-center px-5 py-12">
      <section className="w-full max-w-md rounded-2xl border border-line bg-panel p-7 text-center shadow-2xl">
        <ErrorIcon />
        <h1 className="mt-3 text-2xl font-bold text-white">Something went wrong</h1>
        <p className="mt-3 text-sm leading-6 text-muted">{message}</p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
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
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-line bg-panel px-4 text-sm font-semibold text-white transition-colors hover:border-cyan/60 hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            <House className="size-4" />
            Go home
          </Link>
        </div>
      </section>
    </main>
  );
}
