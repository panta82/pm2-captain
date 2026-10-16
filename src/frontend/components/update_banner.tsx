import { Download, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import { desktopBridge } from '@/lib/preferences';
import { trpc } from '@/lib/trpc';

import type { IDesktopUpdateState } from '@shared/desktop_bridge';

import { Button } from './ui';

/**
 * A downloaded update, ready to install, or one being installed. Installing is
 * always the user's choice; nothing installs on an ordinary quit.
 */
export function UpdateBanner({
  state,
  onInstall,
}: {
  state: IDesktopUpdateState;
  onInstall: () => void;
}) {
  const isInstalling = state.status === 'installing';
  if (state.status !== 'downloaded' && !isInstalling) {
    return null;
  }
  return (
    <div
      data-component="UpdateBanner"
      role="status"
      className="flex flex-wrap items-center gap-3 border-b border-line bg-surface-control px-4 py-2 text-sm"
    >
      <Download className="size-4 shrink-0 text-cyan" aria-hidden />
      <p className="min-w-0 flex-1">
        PM2 Captain {state.version} is ready to install.
        {state.error ? <span className="ml-1 text-danger">{state.error.message}</span> : null}
      </p>
      <Button variant="primary" disabled={isInstalling} onClick={onInstall}>
        {isInstalling ? <LoaderCircle className="size-4 animate-spin" /> : null}
        {state.requiresAuthorization
          ? 'Install update (asks for your password)'
          : 'Restart to update'}
      </Button>
    </div>
  );
}

/** The desktop app's update, through its preload bridge. */
function DesktopUpdateNotice() {
  const [state, setState] = useState<IDesktopUpdateState | null>(null);

  useEffect(() => {
    if (!desktopBridge) {
      return;
    }
    void desktopBridge.updates.getState().then(setState, () => undefined);
    return desktopBridge.updates.onState(setState);
  }, []);

  return state ? (
    <UpdateBanner state={state} onInstall={() => void desktopBridge?.updates.install()} />
  ) : null;
}

/**
 * Fake mode's simulated update, in a browser. Outside fake mode the backend
 * answers null once and nothing is shown or polled.
 */
function FakeUpdateNotice() {
  const utils = trpc.useUtils();
  const update = trpc.fake.update.useQuery(undefined, {
    refetchInterval: query => (query.state.data ? 1_000 : false),
    refetchOnWindowFocus: false,
  });
  const install = trpc.fake.installUpdate.useMutation({
    onSettled: () => utils.fake.update.invalidate(),
  });

  return update.data ? (
    <UpdateBanner state={update.data} onInstall={() => install.mutate()} />
  ) : null;
}

/** The update banner, wherever this page runs. */
export function UpdateNotice() {
  return desktopBridge ? <DesktopUpdateNotice /> : <FakeUpdateNotice />;
}
