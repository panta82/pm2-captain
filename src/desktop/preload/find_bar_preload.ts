// Runs the find bar's page (find_bar.ts in main). That page has no scripts of
// its own, so this sandboxed preload wires up its elements and talks to main;
// nothing is exposed to the page.
import { ipcRenderer } from 'electron';

import { FIND_BAR_CHANNELS, type IFindBarResult, type IFindBarShow } from '../shared/ipc_channels';

/** Typing quickly runs one search, not one per key. */
const SEARCH_DEBOUNCE_MS = 150;

window.addEventListener('DOMContentLoaded', () => {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const input = element<HTMLInputElement>('query');
  const count = element<HTMLSpanElement>('count');
  const previous = element<HTMLButtonElement>('previous');
  const next = element<HTMLButtonElement>('next');
  const isMac = navigator.platform.toLowerCase().includes('mac');
  /** The text of the running search session; empty when there is none. */
  let session = '';
  /** Results of an older search can arrive after those of a newer one. */
  let lastRequestId = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const render = (active: number, total: number) => {
    count.textContent = input.value ? `${active}/${total}` : '';
    count.toggleAttribute('data-empty', Boolean(input.value) && total === 0);
    previous.disabled = next.disabled = total === 0;
  };

  // A new text starts a session at the first match; the same text steps from
  // the current one.
  const find = (isForward: boolean) => {
    clearTimeout(timer);
    const text = input.value;
    if (!text) {
      return;
    }
    ipcRenderer.send(FIND_BAR_CHANNELS.find, text, isForward, text !== session);
    session = text;
  };

  ipcRenderer.on(FIND_BAR_CHANNELS.result, (_event, result: IFindBarResult) => {
    if (result.requestId < lastRequestId || !input.value) {
      return;
    }
    lastRequestId = result.requestId;
    render(result.activeMatchOrdinal, result.matches);
  });

  ipcRenderer.on(FIND_BAR_CHANNELS.show, (_event, { isReopened, step }: IFindBarShow) => {
    input.focus();
    input.select();
    // Reopening keeps the text but not the session, which closing ended. It
    // only searches again when asked to step, so the selection the page kept
    // stays where it is.
    if (isReopened) {
      session = '';
      render(0, 0);
    }
    if (step !== null) {
      find(step);
    }
  });

  input.addEventListener('input', () => {
    clearTimeout(timer);
    if (!input.value) {
      session = '';
      ipcRenderer.send(FIND_BAR_CHANNELS.stop);
      render(0, 0);
      return;
    }
    timer = setTimeout(() => find(true), SEARCH_DEBOUNCE_MS);
  });

  document.addEventListener('keydown', event => {
    const isMod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    const key = event.key.toLowerCase();
    // The typed letter, or the physical key on layouts that type no Latin letter
    // there, as the Captain page matches its shortcuts.
    const isKey = (letter: string) =>
      /^[a-z]$/.test(key) ? key === letter : event.code === `Key${letter.toUpperCase()}`;
    if (event.key === 'Escape') {
      ipcRenderer.send(FIND_BAR_CHANNELS.close);
    } else if (event.key === 'Enter' && event.target === input) {
      find(!event.shiftKey);
    } else if (event.key === 'F3' && !isMod && !event.altKey) {
      find(!event.shiftKey);
    } else if (isMod && !event.altKey && isKey('g')) {
      find(!event.shiftKey);
    } else if (isMod && !event.altKey && event.shiftKey && isKey('f')) {
      // Back to the page's filter boxes, as Ctrl+Shift+F goes back there.
      ipcRenderer.send(FIND_BAR_CHANNELS.back);
    } else if (isMod && !event.altKey && !event.shiftKey && isKey('f')) {
      input.focus();
      input.select();
    } else {
      return;
    }
    event.preventDefault();
  });

  previous.addEventListener('click', () => find(false));
  next.addEventListener('click', () => find(true));
  element<HTMLButtonElement>('close').addEventListener('click', () =>
    ipcRenderer.send(FIND_BAR_CHANNELS.close)
  );
});
