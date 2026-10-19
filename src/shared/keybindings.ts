/**
 * Keyboard shortcuts: the actions, their default keys, and the key syntax that
 * `keybindings.json` uses. The frontend matches keyboard events against them.
 */

export type IKeyboardActionGroup = 'Search' | 'Processes' | 'Navigation' | 'Logs' | 'Help';

/** One thing a shortcut can do. */
export interface IKeyboardActionDefinition {
  id: string;
  /** How the shortcut list describes it. */
  label: string;
  group: IKeyboardActionGroup;
  /** Default keys in the desktop app. */
  desktopKeys: readonly string[];
  /**
   * Default keys in a browser tab, which has its own find bar to step through.
   */
  browserKeys: readonly string[];
  /** A held key repeats it. Only for moving around, never for actions like Restart. */
  isRepeatable?: boolean;
}

export const KEYBOARD_ACTIONS = [
  {
    id: 'find',
    label: 'Jump to the next search box',
    group: 'Search',
    desktopKeys: ['Mod+F'],
    browserKeys: ['Mod+F'],
  },
  {
    id: 'find.back',
    label: 'Jump to the previous search box',
    group: 'Search',
    desktopKeys: ['Mod+Shift+F'],
    browserKeys: ['Mod+Shift+F'],
  },
  {
    id: 'find.next',
    label: 'Next match in the page',
    group: 'Search',
    desktopKeys: ['Mod+G', 'F3'],
    browserKeys: [],
    isRepeatable: true,
  },
  {
    id: 'find.previous',
    label: 'Previous match in the page',
    group: 'Search',
    desktopKeys: ['Mod+Shift+G', 'Shift+F3'],
    browserKeys: [],
    isRepeatable: true,
  },
  {
    id: 'process.restart',
    label: 'Restart the open processes, or start a stopped one',
    group: 'Processes',
    desktopKeys: ['Alt+R'],
    browserKeys: ['Alt+R'],
  },
  {
    id: 'process.next',
    label: 'Next process, focusing the process list',
    group: 'Processes',
    desktopKeys: ['Mod+ArrowDown'],
    browserKeys: ['Mod+ArrowDown'],
    isRepeatable: true,
  },
  {
    id: 'process.previous',
    label: 'Previous process, focusing the process list',
    group: 'Processes',
    desktopKeys: ['Mod+ArrowUp'],
    browserKeys: ['Mod+ArrowUp'],
    isRepeatable: true,
  },
  {
    id: 'tab.info',
    label: 'Info tab',
    group: 'Navigation',
    desktopKeys: ['1'],
    browserKeys: ['1'],
  },
  {
    id: 'tab.env',
    label: 'Env tab',
    group: 'Navigation',
    desktopKeys: ['2'],
    browserKeys: ['2'],
  },
  {
    id: 'tab.logs',
    label: 'Logs tab',
    group: 'Navigation',
    desktopKeys: ['3'],
    browserKeys: ['3'],
  },
  {
    id: 'daemon.picker',
    label: 'Open the daemon picker',
    group: 'Navigation',
    desktopKeys: ['Mod+K'],
    browserKeys: ['Mod+K'],
  },
  {
    id: 'logs.latest',
    label: 'Jump to the end and follow',
    group: 'Logs',
    desktopKeys: ['End'],
    browserKeys: ['End'],
  },
  {
    id: 'shortcuts.help',
    label: 'Show keyboard shortcuts',
    group: 'Help',
    desktopKeys: ['?'],
    browserKeys: ['?'],
  },
] as const satisfies readonly IKeyboardActionDefinition[];

export type IKeyboardActionId = (typeof KEYBOARD_ACTIONS)[number]['id'];

const ACTIONS_BY_ID = new Map<string, IKeyboardActionDefinition>(
  KEYBOARD_ACTIONS.map(action => [action.id, action])
);

export function isKeyboardActionId(id: string): id is IKeyboardActionId {
  return ACTIONS_BY_ID.has(id);
}

export function keyboardAction(id: IKeyboardActionId): IKeyboardActionDefinition {
  return ACTIONS_BY_ID.get(id)!;
}

/** A parsed key combination. Modifiers must match exactly. */
export interface IKeyCombo {
  /** Ctrl, or Cmd on a Mac. */
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  /**
   * A lowercase letter, a digit, another printable character, or a key name as
   * `KeyboardEvent.key` reports it, such as `F3` or `ArrowUp`.
   */
  key: string;
}

type IModifier = Exclude<keyof IKeyCombo, 'key'>;

const MODIFIER_NAMES: Record<string, IModifier> = {
  mod: 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
};

const NAMED_KEYS = new Map(
  [
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Enter',
    'Escape',
    'Tab',
    'Backspace',
    'Delete',
    'Insert',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
  ].map(name => [name.toLowerCase(), name])
);

/**
 * Reads a combination such as `Mod+Shift+G`, `Alt+ArrowDown`, `F3` or `?`.
 * Modifier and key names ignore case. Returns null for anything else.
 */
export function parseKeyCombo(text: string): IKeyCombo | null {
  // The modifiers are words followed by "+"; the rest is the key, which may be "+" itself.
  const match = /^((?:[A-Za-z]+\+)*)(.+)$/.exec(text.trim());
  if (!match) {
    return null;
  }
  const combo: IKeyCombo = {
    mod: false,
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
    key: '',
  };
  for (const name of match[1].split('+').filter(Boolean)) {
    const modifier = MODIFIER_NAMES[name.toLowerCase()];
    if (!modifier || combo[modifier]) {
      return null;
    }
    combo[modifier] = true;
  }
  const key = match[2];
  if (key === 'Space' || key === 'space') {
    combo.key = ' ';
  } else if ([...key].length === 1 && key.trim()) {
    combo.key = key.toLowerCase();
  } else {
    const name = NAMED_KEYS.get(key.toLowerCase());
    if (!name) {
      return null;
    }
    combo.key = name;
  }
  return combo;
}

/**
 * The user's keys for some actions, as `keybindings.json` sets them. Each entry
 * replaces the action's default keys; an empty list leaves the action without keys.
 */
export type IKeybindingOverrides = Partial<Record<IKeyboardActionId, string[]>>;

/** The keybindings file, as the backend read it. */
export interface IKeybindingSettings {
  path: string;
  overrides: IKeybindingOverrides;
  /** Why the file was not used. The default keys apply meanwhile. */
  error: string | null;
}

export type IKeyboardSurface = 'desktop' | 'browser';

/** One key combination of an action, with the text it was written as. */
export interface IKeyBinding {
  actionId: IKeyboardActionId;
  text: string;
  combo: IKeyCombo;
}

/**
 * The keys in effect, in the order they are tried. The user's keys come first,
 * so one of them wins over a default that uses the same combination.
 */
export function resolveKeybindings(
  surface: IKeyboardSurface,
  overrides: IKeybindingOverrides
): IKeyBinding[] {
  const custom: IKeyBinding[] = [];
  const defaults: IKeyBinding[] = [];
  for (const action of KEYBOARD_ACTIONS) {
    const userKeys = overrides[action.id];
    const keys = userKeys ?? (surface === 'desktop' ? action.desktopKeys : action.browserKeys);
    for (const text of keys) {
      const combo = parseKeyCombo(text);
      if (combo) {
        (userKeys ? custom : defaults).push({ actionId: action.id, text, combo });
      }
    }
  }
  return [...custom, ...defaults];
}
