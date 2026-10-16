import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';

/** The window and backend origin whose page may use the desktop bridge. */
export interface ITrustedPage {
  window: BrowserWindow;
  origin: string;
}

/**
 * Accepts IPC only from the main frame of the current Captain window, while it
 * shows the current backend's origin. Status pages, other windows, frames and
 * a page that navigated elsewhere are refused.
 */
export function isTrustedSender(
  event: Pick<IpcMainEvent | IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  trusted: ITrustedPage | null
) {
  const frame = event.senderFrame;
  if (!trusted || trusted.window.isDestroyed() || !frame) {
    return false;
  }
  const contents = trusted.window.webContents;
  if (event.sender !== contents || frame !== contents.mainFrame) {
    return false;
  }
  try {
    return new URL(frame.url).origin === trusted.origin;
  } catch {
    return false;
  }
}
