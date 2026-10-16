// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IProcessSummary } from '../../../../src/shared/contracts';

const mocked = vi.hoisted(() => ({
  run: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock('../../../../src/frontend/lib/bulk_action', () => ({
  useBulkAction: () => ({ progress: new Map(), runningAction: null, run: mocked.run }),
}));

vi.mock('../../../../src/frontend/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({}),
    processes: {
      action: { useMutation: () => ({ mutate: mocked.mutate, isPending: false }) },
    },
  },
}));

const { BulkProcessActions } =
  await import('../../../../src/frontend/components/bulk_process_actions');
const { ProcessActions } = await import('../../../../src/frontend/components/process_actions');
const { useConnectionReplaced } = await import('../../../../src/frontend/lib/daemon_connection');

afterEach(() => {
  cleanup();
  mocked.run.mockClear();
  mocked.mutate.mockClear();
});

const DAEMON_ID = '830f902f-c88b-4ed8-8051-c3a81c44ed87';
const OLD_CONNECTION = '11111111-1111-4111-8111-111111111111';
const NEW_CONNECTION = '22222222-2222-4222-8222-222222222222';

/** The same processes as another location would show them: only the connection differs. */
function processes(connectionId: string, status: IProcessSummary['status'] = 'online') {
  return [0, 1, 2].map((pmId): IProcessSummary => ({
    daemonId: DAEMON_ID,
    connectionId,
    pmId,
    name: `app-${pmId}`,
    namespace: 'default',
    status,
    pid: null,
    mode: 'fork',
    cpu: null,
    memory: null,
    uptime: null,
    restarts: 0,
    unstableRestarts: 0,
    version: null,
    watching: false,
    isCaptain: false,
  }));
}

describe('a daemon moved to another location', () => {
  it('drops an armed bulk stop, even when the processes look the same', () => {
    const view = render(
      createElement(BulkProcessActions, { processes: processes(OLD_CONNECTION) })
    );
    fireEvent.click(screen.getByRole('button', { name: /^Stop/ }));
    expect(screen.getByRole('button', { name: 'Really stop 3?' })).toBeTruthy();

    view.rerender(createElement(BulkProcessActions, { processes: processes(NEW_CONNECTION) }));

    expect(screen.queryByRole('button', { name: 'Really stop 3?' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Stop/ }));
    expect(mocked.run).not.toHaveBeenCalled();
    // A new confirmation acts on the new connection's processes.
    fireEvent.click(screen.getByRole('button', { name: 'Really stop 3?' }));
    expect(mocked.run).toHaveBeenCalledWith('stop', processes(NEW_CONNECTION));
  });

  it('sends single-process actions to the new connection', () => {
    const [before] = processes(OLD_CONNECTION, 'stopped');
    const [after] = processes(NEW_CONNECTION, 'stopped');
    const view = render(createElement(ProcessActions, { process: before }));

    view.rerender(createElement(ProcessActions, { process: after }));
    fireEvent.click(screen.getByRole('button', { name: /Start/ }));

    expect(mocked.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ daemonId: DAEMON_ID, connectionId: NEW_CONNECTION, pmId: 0 })
    );
  });

  it('reports a replaced connection, but not the first load or another daemon', () => {
    const onReplaced = vi.fn();
    const hook = renderHook(
      ({ daemonId, connectionId }: { daemonId: string; connectionId: string | undefined }) =>
        useConnectionReplaced(daemonId, connectionId, onReplaced),
      { initialProps: { daemonId: DAEMON_ID, connectionId: undefined as string | undefined } }
    );

    hook.rerender({ daemonId: DAEMON_ID, connectionId: OLD_CONNECTION });
    hook.rerender({ daemonId: DAEMON_ID, connectionId: OLD_CONNECTION });
    expect(onReplaced).not.toHaveBeenCalled();
    hook.rerender({
      daemonId: 'b61e3d2f-b6d1-4af2-8e2f-6bb3fdf1f7fa',
      connectionId: NEW_CONNECTION,
    });
    expect(onReplaced).not.toHaveBeenCalled();
    hook.rerender({
      daemonId: 'b61e3d2f-b6d1-4af2-8e2f-6bb3fdf1f7fa',
      connectionId: OLD_CONNECTION,
    });
    expect(onReplaced).toHaveBeenCalledOnce();
  });
});
