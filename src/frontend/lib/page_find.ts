import { desktopBridge } from '@/lib/preferences';
import { isShown } from '@/lib/utils';

/**
 * Filter boxes carry their place in the Ctrl+F order in this attribute: the
 * process filter (1), then the log search boxes (2). Ctrl+F goes from box to
 * box, and after the last one to the page's find; Ctrl+Shift+F goes back.
 */
export const FIND_TARGET_ATTRIBUTE = 'data-find-target';

let isFindBarOpen = false;
desktopBridge?.find.onOpenChange(isOpen => {
  isFindBarOpen = isOpen;
});
// Ctrl+Shift+F in the find bar comes back to the last box.
desktopBridge?.find.onBack(() => {
  runFindBack(true);
});

/** The topmost dialog, which keeps Ctrl+F to itself while it is open. */
export function modalRoot(): Element | null {
  return Array.from(document.querySelectorAll('[aria-modal="true"]')).at(-1) ?? null;
}

const stepOf = (element: Element) => Number(element.getAttribute(FIND_TARGET_ATTRIBUTE)) || 0;

/** The filter boxes on screen, in Ctrl+F order: by step, then as the page shows them. */
function findSteps() {
  const root = modalRoot() ?? document;
  return Array.from(root.querySelectorAll<HTMLInputElement>(`input[${FIND_TARGET_ATTRIBUTE}]`))
    .filter(isShown)
    .sort((left, right) => stepOf(left) - stepOf(right));
}

/**
 * The filter box Ctrl+F goes to now, or null when the page's find comes next.
 * From outside the boxes it starts at the first box near the focus, unless the
 * desktop find bar is still open: then it goes back there.
 */
export function nextFindTarget(): HTMLInputElement | null {
  const steps = findSteps();
  const active = document.activeElement;
  const index = steps.findIndex(step => step === active);
  if (index >= 0) {
    return steps[index + 1] ?? null;
  }
  if (desktopBridge && isFindBarOpen) {
    return null;
  }
  // The closest area around the focus that has boxes: the log search from the
  // log lines, the process filter from the process list, the first box from
  // anywhere else.
  for (let area = active; area; area = area.parentElement) {
    const nearest = steps.find(step => area.contains(step));
    if (nearest) {
      return nearest;
    }
  }
  return steps[0] ?? null;
}

/**
 * The filter box Ctrl+F goes back to now, or null at the first one. From the
 * find bar, or from outside the boxes, that is the last box.
 */
export function previousFindTarget(isFromFindBar = false): HTMLInputElement | null {
  const steps = findSteps();
  const index = isFromFindBar
    ? steps.length
    : steps.findIndex(step => step === document.activeElement);
  return index < 0 ? (steps.at(-1) ?? null) : (steps[index - 1] ?? null);
}

function focusBox(input: HTMLInputElement) {
  input.focus();
  input.select();
}

/**
 * Ctrl+F: the next filter box, and after the last one the page's find. The
 * desktop app opens its find bar; a browser is left to open its own. Returns
 * whether the press was handled here.
 */
export function runFind(): boolean {
  const target = nextFindTarget();
  if (target) {
    focusBox(target);
    return true;
  }
  if (desktopBridge) {
    desktopBridge.find.open();
    return true;
  }
  return false;
}

/** Ctrl+Shift+F: the previous filter box. At the first one it stays there. */
export function runFindBack(isFromFindBar = false): boolean {
  const target = previousFindTarget(isFromFindBar);
  if (target) {
    focusBox(target);
    return true;
  }
  const active = document.activeElement;
  return active instanceof HTMLInputElement && active.hasAttribute(FIND_TARGET_ATTRIBUTE);
}

/** Next or previous match. Only the desktop app has a find bar of its own to step through. */
export function stepFind(isForward: boolean): boolean {
  if (!desktopBridge) {
    return false;
  }
  desktopBridge.find.step(isForward);
  return true;
}
