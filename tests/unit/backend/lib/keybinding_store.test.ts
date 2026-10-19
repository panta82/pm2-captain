import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKeybindingStore } from '../../../../src/backend/lib/keybinding_store';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(path => fs.rm(path, { recursive: true, force: true }))
  );
});

async function setup(content?: string) {
  const configDir = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2-captain-keybindings-'));
  directories.push(configDir);
  const path = libPath.join(configDir, 'keybindings.json');
  if (content !== undefined) {
    await fs.writeFile(path, content);
  }
  const log = { warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
  const store = createKeybindingStore({ settings: { configDir }, log } as never);
  return { store, path, log, configDir };
}

describe('keybinding store', () => {
  it('means the default keys when there is no file', async () => {
    const { store, path } = await setup();

    expect(await store.read()).toEqual({ path, overrides: {}, error: null });
  });

  it('reads one key, several keys, or none for an action', async () => {
    const { store } = await setup(
      JSON.stringify({
        bindings: {
          'process.restart': 'Ctrl+Shift+R',
          'tab.info': ['1', 'Alt+1'],
          'daemon.picker': null,
        },
      })
    );

    expect((await store.read()).overrides).toEqual({
      'process.restart': ['Ctrl+Shift+R'],
      'tab.info': ['1', 'Alt+1'],
      'daemon.picker': [],
    });
  });

  it('ignores a file it cannot use, says why once, and picks up the fix', async () => {
    const { store, path, log } = await setup('{"bindings": {');

    const broken = await store.read();
    expect(broken).toEqual({ path, overrides: {}, error: 'The file is not valid JSON.' });
    await store.read();
    expect(log.warn).toHaveBeenCalledTimes(1);

    await fs.writeFile(path, '{"bindings": {"find": "Alt+F"}}');
    expect(await store.read()).toEqual({ path, overrides: { find: ['Alt+F'] }, error: null });
  });

  it('explains unknown actions, bad keys and an unexpected shape', async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ bindings: { 'process.kill': 'Alt+K' } }, /"process\.kill" is not a shortcut action/],
      [{ bindings: { find: 'Ctrl+Foo' } }, /find: "Ctrl\+Foo" is not a key combination/],
      [{ bindings: { find: 3 } }, /Unsupported content at bindings\.find/],
      [{ binding: {} }, /Unsupported content/],
      [[], /Unsupported content at the top level/],
    ];
    for (const [content, error] of cases) {
      const { store } = await setup(JSON.stringify(content));
      const result = await store.read();
      expect(result.overrides).toEqual({});
      expect(result.error).toMatch(error);
    }
  });

  it('refuses a directory and an oversized file', async () => {
    const directory = await setup();
    await fs.mkdir(directory.path);
    expect((await directory.store.read()).error).toBe('It is not a file.');

    const large = await setup(`{"bindings": {}, "padding": "${'x'.repeat(70_000)}"}`);
    expect((await large.store.read()).error).toBe('The file is too large.');
  });

  it('follows a symbolic link, as a dotfile setup uses', async () => {
    const { store, path, configDir } = await setup();
    const target = libPath.join(configDir, 'dotfiles-keybindings.json');
    await fs.writeFile(target, '{"bindings": {"tab.logs": "Alt+L"}}');
    await fs.symlink(target, path);

    expect((await store.read()).overrides).toEqual({ 'tab.logs': ['Alt+L'] });
  });
});
