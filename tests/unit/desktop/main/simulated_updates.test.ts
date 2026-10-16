import { describe, expect, it, vi } from 'vitest';

import { createSimulatedUpdateController } from '../../../../src/desktop/main/simulated_updates';

const log = { info: vi.fn() } as never;

describe('simulated updates', () => {
  it('shows what the backend reports and sends the user’s actions back', async () => {
    const sendAction = vi.fn();
    const controller = createSimulatedUpdateController({
      currentVersion: '1.5.0',
      log,
      sendAction,
    });
    const listener = vi.fn();
    controller.onState(listener);
    expect(controller.state).toMatchObject({ status: 'idle', currentVersion: '1.5.0' });

    controller.receive({ ...controller.state, status: 'downloaded', version: '9.9.9' });
    await controller.install();
    await controller.check();

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: 'downloaded' }));
    expect(controller.state.version).toBe('9.9.9');
    expect(sendAction.mock.calls).toEqual([['install'], ['check']]);
  });
});
