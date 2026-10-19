import { promises as fs } from 'node:fs';
import libPath from 'node:path';
import { z } from 'zod';

import {
  IKeybindingOverrides,
  IKeybindingSettings,
  isKeyboardActionId,
  parseKeyCombo,
} from '../../shared/keybindings';
import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';

const KEYBINDINGS_FILE_NAME = 'keybindings.json';
/** Far more than any list of shortcuts needs. */
const MAX_FILE_SIZE = 64 * 1024;
const MAX_QUOTED_LENGTH = 60;

const KeybindingFileSchema = z
  .object({
    bindings: z.record(z.string(), z.union([z.string(), z.array(z.string()).max(16), z.null()])),
  })
  .strict();

/** The keybindings file cannot be used as it is. */
export class KeybindingFileError extends Error {
  readonly code = 'KEYBINDINGS_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'KeybindingFileError';
  }
}

const quote = (text: string) =>
  JSON.stringify(text.length > MAX_QUOTED_LENGTH ? `${text.slice(0, MAX_QUOTED_LENGTH)}…` : text);

/** Validates the file's content. Throws KeybindingFileError. */
export function parseKeybindings(content: string): IKeybindingOverrides {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new KeybindingFileError('The file is not valid JSON.');
  }
  const result = KeybindingFileSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue.path.length ? issue.path.join('.') : 'the top level';
    throw new KeybindingFileError(
      `Unsupported content at ${where}: ${issue.message}. The file holds {"bindings": {"<action>": "<keys>"}}.`
    );
  }
  const overrides: IKeybindingOverrides = {};
  for (const [actionId, keys] of Object.entries(result.data.bindings)) {
    if (!isKeyboardActionId(actionId)) {
      throw new KeybindingFileError(
        `${quote(actionId)} is not a shortcut action. The shortcut list (press ?) shows their names.`
      );
    }
    const list = keys === null ? [] : typeof keys === 'string' ? [keys] : keys;
    for (const text of list) {
      if (!parseKeyCombo(text)) {
        throw new KeybindingFileError(
          `${actionId}: ${quote(text)} is not a key combination such as "Ctrl+Shift+F", "Alt+R" or "F3".`
        );
      }
    }
    overrides[actionId] = list;
  }
  return overrides;
}

/**
 * The user's keyboard shortcuts, from keybindings.json in Captain's config
 * directory. Captain only reads the file; a missing file means the defaults.
 */
export function createKeybindingStore({ settings, log }: IContainer) {
  const path = libPath.join(settings.configDir, KEYBINDINGS_FILE_NAME);
  let lastError: string | null = null;

  const load = async (): Promise<IKeybindingOverrides> => {
    let content: string;
    try {
      // A link is followed: the file is never written, so a dotfile setup keeps working.
      const stats = await fs.stat(path);
      if (!stats.isFile()) {
        throw new KeybindingFileError('It is not a file.');
      }
      if (stats.size > MAX_FILE_SIZE) {
        throw new KeybindingFileError('The file is too large.');
      }
      content = await fs.readFile(path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {};
      }
      if (code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR' || code === 'ELOOP') {
        throw new KeybindingFileError(`The file cannot be read (${code}).`);
      }
      throw error;
    }
    return parseKeybindings(content);
  };

  return new (class KeybindingStore {
    readonly path = path;

    /** Read on every request, so an edit applies when the UI asks again. */
    read = async (): Promise<IKeybindingSettings> => {
      try {
        const overrides = await load();
        lastError = null;
        return { path, overrides, error: null };
      } catch (error) {
        if (!(error instanceof KeybindingFileError)) {
          throw error;
        }
        // The UI asks again whenever its window gets focus; report a problem once.
        if (error.message !== lastError) {
          log.warn({ path, reason: error.message }, 'Ignoring the keybindings file');
        }
        lastError = error.message;
        return { path, overrides: {}, error: error.message };
      }
    };
  })();
}

export type IKeybindingStore = ReturnType<typeof createKeybindingStore>;

export default define({
  createKeybindingStore,
});
