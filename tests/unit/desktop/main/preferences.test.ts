import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPreferenceStore } from '../../../../src/desktop/main/preferences';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2c-preferences-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('desktop preferences', () => {
  it('keeps UI preferences and the window across launches, privately', async () => {
    const directory = libPath.join(root, 'profile');
    const store = createPreferenceStore(directory);
    expect(store.setUi('pm2-captain-selected-daemon', '830f902f-c88b-4ed8-8051-c3a81c44ed87')).toBe(
      true
    );
    expect(store.setUi('pm2-captain-process-tab', 'logs')).toBe(true);
    expect(store.setUi('pm2-captain:process-sidebar-width', '320')).toBe(true);
    expect(store.setUi('pm2-captain-matrix-only-differences', 'true')).toBe(true);
    expect(store.setUi('pm2-captain-skipped-update-version', '1.2.3-beta.1')).toBe(true);
    store.setWindow({ x: 10, y: 20, width: 1200, height: 800, isMaximized: false });
    store.flush();

    const reloaded = createPreferenceStore(directory);
    expect(reloaded.ui()).toEqual({
      'pm2-captain-selected-daemon': '830f902f-c88b-4ed8-8051-c3a81c44ed87',
      'pm2-captain-process-tab': 'logs',
      'pm2-captain:process-sidebar-width': '320',
      'pm2-captain-matrix-only-differences': 'true',
      'pm2-captain-skipped-update-version': '1.2.3-beta.1',
    });
    expect(reloaded.window()).toEqual({
      x: 10,
      y: 20,
      width: 1200,
      height: 800,
      isMaximized: false,
    });
    const path = libPath.join(directory, 'preferences.json');
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('refuses keys and values a page could not legitimately send', () => {
    const store = createPreferenceStore(root);

    expect(store.setUi('launch-token', 'secret')).toBe(false);
    expect(store.setUi('pm2-captain-process-tab', 'settings')).toBe(false);
    expect(store.setUi('pm2-captain-selected-daemon', '../../etc')).toBe(false);
    expect(store.setUi('pm2-captain:process-sidebar-width', 320)).toBe(false);
    expect(store.setUi('pm2-captain-skipped-update-version', '../../etc')).toBe(false);
    expect(store.setUi('pm2-captain-skipped-update-version', '1'.repeat(201))).toBe(false);
    expect(store.ui()).toEqual({});
  });

  it('starts from defaults when the file is broken, and drops invalid entries', async () => {
    await fs.writeFile(libPath.join(root, 'preferences.json'), '{broken');
    expect(createPreferenceStore(root).ui()).toEqual({});

    await fs.writeFile(
      libPath.join(root, 'preferences.json'),
      JSON.stringify({
        version: 1,
        ui: { 'pm2-captain-process-tab': 'env', other: 'x', 'pm2-captain-selected-daemon': 'no' },
        window: { width: 5, height: 800 },
      })
    );
    const store = createPreferenceStore(root);
    expect(store.ui()).toEqual({ 'pm2-captain-process-tab': 'env' });
    expect(store.window()).toBeNull();
  });
});
