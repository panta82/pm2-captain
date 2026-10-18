import { Download, LoaderCircle } from 'lucide-react';
import { useEffect } from 'react';
import { toast } from 'sonner';

import { useUpdatesAPI } from '@/lib/updates_api';

import type { IAppUpdateState } from '@shared/desktop_bridge';

import { Button } from './ui';

function UpdateToast({
  state,
  onInstall,
  onSkip,
}: {
  state: IAppUpdateState;
  onInstall: () => void;
  onSkip: () => void;
}) {
  const isInstalling = state.status === 'installing';
  return (
    <div data-component="UpdateToast" className="flex flex-col gap-3 text-sm">
      <div className="flex items-start gap-2">
        <Download className="mt-0.5 size-4 shrink-0 text-cyan" aria-hidden />
        <p>
          {isInstalling
            ? `Installing PM2 Captain ${state.version}…`
            : `PM2 Captain ${state.version} is ready to install.`}
        </p>
      </div>
      {state.error ? <p className="text-danger">{state.error.message}</p> : null}
      <Button variant="primary" disabled={isInstalling} onClick={onInstall}>
        {isInstalling ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
        {state.requiresAuthorization
          ? 'Install update (asks for your password)'
          : 'Restart to update'}
      </Button>
      {!isInstalling ? (
        <button
          type="button"
          className="self-center cursor-pointer text-sm font-medium text-control-muted underline-offset-4 hover:text-cyan hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          onClick={onSkip}
        >
          Skip this version
        </button>
      ) : null}
    </div>
  );
}

/** A persistent update notification. The API owns runtime and transport selection. */
export function UpdateNotice() {
  const updates = useUpdatesAPI();
  useEffect(() => {
    let isActive = true;
    let isInstallPending = false;
    let isSkipPending = false;
    let state: IAppUpdateState | null = null;
    let toastId: string | number | undefined;
    let errorToastId: string | number | undefined;

    const dismissToast = () => {
      if (toastId !== undefined) {
        toast.dismiss(toastId);
        // Queued removal of this toast must not hide a later notification.
        toastId = undefined;
      }
    };

    const installUpdate = () => {
      if (
        !isActive ||
        !state ||
        state.status !== 'downloaded' ||
        isInstallPending ||
        isSkipPending
      ) {
        return;
      }
      const version = state.version;
      isInstallPending = true;
      void Promise.resolve()
        .then(() => updates.install())
        .catch((error: unknown) => {
          if (
            !isActive ||
            !state ||
            state.version !== version ||
            state.error?.phase === 'install'
          ) {
            return;
          }
          receiveState({
            ...state,
            status: 'downloaded',
            error: {
              phase: 'install',
              message:
                error instanceof Error ? error.message : 'The update could not be installed.',
            },
          });
        })
        .finally(() => {
          isInstallPending = false;
        });
    };

    const skipUpdate = (version: string | null) => {
      if (!isActive || !version || isSkipPending || isInstallPending) {
        return;
      }
      isSkipPending = true;
      void Promise.resolve()
        .then(() => updates.skip(version))
        .catch((error: unknown) => {
          if (isActive) {
            toast.error('Unable to skip this version.', {
              description: error instanceof Error ? error.message : 'Please try again.',
            });
          }
        })
        .finally(() => {
          isSkipPending = false;
        });
    };

    const receiveState = (next: IAppUpdateState | null) => {
      if (!isActive) {
        return;
      }
      state = next;
      if (errorToastId !== undefined) {
        toast.dismiss(errorToastId);
        errorToastId = undefined;
      }
      const isInstalling = next?.status === 'installing';
      if (
        !next ||
        (next.status !== 'downloaded' && !isInstalling) ||
        (!isInstalling && next.version === next.skippedVersion)
      ) {
        dismissToast();
        return;
      }
      toastId = toast.message(
        <UpdateToast
          state={next}
          onInstall={installUpdate}
          onSkip={() => skipUpdate(next.version)}
        />,
        {
          id: toastId,
          duration: Infinity,
          closeButton: false,
          dismissible: false,
          classNames: { content: 'w-full' },
        }
      );
    };

    const unsubscribe = updates.subscribe(receiveState, error => {
      if (isActive) {
        errorToastId = toast.error('Unable to read update status.', {
          id: errorToastId,
          description: error.message,
          onDismiss: dismissedToast => {
            if (errorToastId === dismissedToast.id) {
              errorToastId = undefined;
            }
          },
          onAutoClose: closedToast => {
            if (errorToastId === closedToast.id) {
              errorToastId = undefined;
            }
          },
        });
      }
    });
    return () => {
      isActive = false;
      unsubscribe();
      dismissToast();
      if (errorToastId !== undefined) {
        toast.dismiss(errorToastId);
      }
    };
  }, [updates]);
  return null;
}
