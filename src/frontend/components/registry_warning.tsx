import { TriangleAlert } from 'lucide-react';

/**
 * Shown while the daemon registry on disk cannot be used. Captain keeps the
 * daemons it last loaded, and picks the file up again once it is fixed.
 */
export function RegistryWarning({ message }: { message: string }) {
  return (
    <div
      data-component="RegistryWarning"
      role="alert"
      className="flex items-start gap-2 border-b border-line bg-surface-control px-4 py-2 text-sm leading-5"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <p className="min-w-0 break-words">
        <span className="font-semibold">The daemon list cannot be loaded.</span> {message} Captain
        keeps showing the daemons it last loaded until the file is fixed.
      </p>
    </div>
  );
}
