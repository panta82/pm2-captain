import { describe, expect, it } from 'vitest';

import { isTrustedSender } from '../../../../src/desktop/main/ipc_trust';

const ORIGIN = 'http://127.0.0.1:45713';

function page(url = `${ORIGIN}/daemons/x`) {
  const mainFrame = { url };
  const webContents = { mainFrame };
  const window = { webContents, isDestroyed: () => false };
  return { window, webContents, mainFrame, trusted: { window: window as never, origin: ORIGIN } };
}

describe('IPC trust', () => {
  it('accepts the main frame of the Captain page', () => {
    const { webContents, mainFrame, trusted } = page();
    expect(isTrustedSender({ sender: webContents, senderFrame: mainFrame } as never, trusted)).toBe(
      true
    );
  });

  it('refuses frames, other pages, other origins and status pages', () => {
    const { webContents, mainFrame, trusted } = page();
    const other = page();
    const subframe = { url: `${ORIGIN}/` };

    const cases = [
      { sender: webContents, senderFrame: subframe },
      { sender: other.webContents, senderFrame: other.mainFrame },
      { sender: webContents, senderFrame: null },
    ];
    for (const event of cases) {
      expect(isTrustedSender(event as never, trusted)).toBe(false);
    }
    for (const url of ['http://127.0.0.1:3212/', 'data:text/html,hi', 'https://example.com/']) {
      mainFrame.url = url;
      expect(
        isTrustedSender({ sender: webContents, senderFrame: mainFrame } as never, trusted)
      ).toBe(false);
    }
    expect(isTrustedSender({ sender: webContents, senderFrame: mainFrame } as never, null)).toBe(
      false
    );
  });

  it('refuses a closed window', () => {
    const { webContents, mainFrame, window, trusted } = page();
    window.isDestroyed = () => true;
    expect(isTrustedSender({ sender: webContents, senderFrame: mainFrame } as never, trusted)).toBe(
      false
    );
  });
});
