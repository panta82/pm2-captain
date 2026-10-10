import { Link } from '@tanstack/react-router';
import { ArrowLeft, House } from 'lucide-react';

function NotFoundIcon() {
  return (
    <svg
      data-component="NotFoundIcon"
      viewBox="0 0 64 56"
      width={84}
      height={74}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className="mx-auto text-amber-500"
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
        404
      </text>
    </svg>
  );
}

export function NotFoundPage() {
  return (
    <main
      data-component="NotFoundPage"
      className="grid min-h-0 flex-1 place-items-center px-5 py-12"
    >
      <section className="w-full max-w-md rounded-2xl border border-line bg-panel p-7 text-center shadow-2xl">
        <NotFoundIcon />
        <h1 className="mt-3 text-2xl font-bold text-white">Page not found</h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          Bad url? Click the button below to go back home.
        </p>
        <Link
          to="/"
          className="mt-6 inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-primary bg-primary px-4 text-sm font-semibold text-white hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          <House className="size-4" />
          Go home
        </Link>
      </section>
    </main>
  );
}
