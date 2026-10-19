import type { Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import libPath from 'node:path';

import {
  FAKE_LAUNCH_PATH,
  FAKE_XDG_CONFIG_HOME,
  expect,
  failOnPageError,
  openProcessTab,
  processRow,
  test,
} from '../support/fake_fixture';

const KEYBINDINGS_PATH = libPath.join(FAKE_XDG_CONFIG_HOME, 'pm2-captain', 'keybindings.json');

test.afterEach(async () => {
  await fs.rm(KEYBINDINGS_PATH, { force: true });
});

/**
 * Whether the page took the last key, so the browser did nothing with it. The
 * listener runs after Captain's, which stops a key it takes from going further.
 */
async function trackKeys(page: Page) {
  await page.evaluate(() => {
    window.addEventListener(
      'keydown',
      event => {
        (window as unknown as { wasTaken: boolean }).wasTaken = event.defaultPrevented;
      },
      true
    );
  });
  return () => page.evaluate(() => (window as unknown as { wasTaken: boolean }).wasTaken);
}

const processFilter = (page: Page) => page.getByPlaceholder('Filter processes…').first();
/** The hints on screen; narrow-screen variants of a control are rendered but hidden. */
const hints = (page: Page) =>
  page.locator('[data-component="ShortcutHint"]').filter({ visible: true });

test('steps through the filter boxes with Ctrl+F, then leaves find to the browser', async ({
  page,
}) => {
  const assertNoErrors = failOnPageError(page);
  await page.goto(FAKE_LAUNCH_PATH);
  await expect(processRow(page, 'api')).toBeVisible();
  const wasTaken = await trackKeys(page);

  await processFilter(page).fill('api');
  await processFilter(page).blur();
  await page.keyboard.press('Control+f');
  await expect(processFilter(page)).toBeFocused();
  expect(await processFilter(page).evaluate((input: HTMLInputElement) => input.selectionEnd)).toBe(
    3
  );
  expect(await wasTaken()).toBe(true);
  // From the last box, the browser's own find bar opens.
  await page.keyboard.press('Control+f');
  expect(await wasTaken()).toBe(false);

  // The first Escape clears the box, the next one leaves it.
  await page.keyboard.press('Escape');
  await expect(processFilter(page)).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(processFilter(page)).not.toBeFocused();

  // With logs open: the process filter, each log search box, then the browser.
  await openProcessTab(page, 'api', 'Logs');
  await page.getByRole('button', { name: 'Add a search box' }).click();
  await page.keyboard.press('Escape');
  const logBoxes = page.getByPlaceholder(/^(Filter|Highlight) loaded logs…$/);
  await page.keyboard.press('Control+f');
  await expect(processFilter(page)).toBeFocused();
  await page.keyboard.press('Control+f');
  await expect(logBoxes.nth(0)).toBeFocused();
  await page.keyboard.press('Control+f');
  await expect(logBoxes.nth(1)).toBeFocused();
  await page.keyboard.press('Control+f');
  expect(await wasTaken()).toBe(false);

  // Ctrl+Shift+F goes back, and stays at the first box.
  await page.keyboard.press('Control+Shift+F');
  await expect(logBoxes.nth(0)).toBeFocused();
  await page.keyboard.press('Control+Shift+F');
  await expect(processFilter(page)).toBeFocused();
  await page.keyboard.press('Control+Shift+F');
  await expect(processFilter(page)).toBeFocused();
  expect(await wasTaken()).toBe(true);
  assertNoErrors();
});

test('goes from a filter box into its list, and clears the process filter with Escape', async ({
  page,
}) => {
  const heading = (name: string) => page.getByRole('heading', { name, exact: true });
  await page.goto(FAKE_LAUNCH_PATH);
  await expect(processRow(page, 'api')).toBeVisible();

  // With nothing focused, the arrow keys go into the list, from either end.
  await page.keyboard.press('ArrowUp');
  await expect(processRow(page, 'mailer')).toBeFocused();
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.press('ArrowDown');
  await expect(processRow(page, 'api')).toBeFocused();
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());

  // Ctrl+F, type, Down: the first process that is left.
  await page.keyboard.press('Control+f');
  await page.keyboard.type('er');
  await page.keyboard.press('ArrowDown');
  await expect(processRow(page, 'worker')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(processRow(page, 'scheduler')).toBeFocused();
  // Escape clears the filter from the list as well.
  await page.keyboard.press('Escape');
  await expect(processFilter(page)).toHaveValue('');
  await expect(processRow(page, 'api')).toBeVisible();
  // Enter goes on to the list too.
  await processFilter(page).fill('sched');
  await processFilter(page).press('Enter');
  await expect(processRow(page, 'scheduler')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(heading('scheduler')).toBeVisible();

  // In the sidebar, the filter leads to the list, where the arrows go on.
  const sidebar = page.getByRole('navigation', { name: 'Processes' });
  await processFilter(page).fill('');
  await page.keyboard.press('ArrowDown');
  await expect(sidebar).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(heading('mailer')).toBeVisible();
  // There, Escape clears the filter first, and only the next one leaves.
  await processFilter(page).fill('a');
  await sidebar.focus();
  await page.keyboard.press('Escape');
  await expect(processFilter(page)).toHaveValue('');
  await expect(heading('mailer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(processRow(page, 'api')).toBeVisible();

  // Enter in a log search box goes on to the lines, which the keys then scroll.
  await openProcessTab(page, 'mailer', 'Logs');
  await page.getByPlaceholder('Filter loaded logs…').press('Enter');
  await expect(page.getByLabel('Log lines')).toBeFocused();

  // The list is one tab stop: from the filter's buttons, Tab lands on it.
  await processFilter(page).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(sidebar).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(sidebar).not.toBeFocused();
  expect(
    await page.evaluate(() => document.activeElement?.closest('nav[aria-label="Processes"]'))
  ).toBeNull();
});

test('goes into the open process from the sidebar, and back with Escape', async ({ page }) => {
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Info');
  const sidebar = page.getByRole('navigation', { name: 'Processes' });

  await sidebar.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-component="InfoPage"]')).toBeFocused();
  // Back to the list, still on the same process.
  await page.keyboard.press('Escape');
  await expect(sidebar).toBeFocused();
  await expect(page.getByRole('heading', { name: 'api', exact: true })).toBeVisible();

  await page.keyboard.press('3');
  await expect(page.getByLabel('Log lines')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Log lines')).toBeFocused();
  // An empty search box passes Escape on, back to the list.
  await page.getByPlaceholder('Filter loaded logs…').focus();
  await page.keyboard.press('Escape');
  await expect(sidebar).toBeFocused();

  // So do the daemon picker and the empty process filter in the sidebar.
  await page
    .getByRole('button', { name: /^Daemon: / })
    .first()
    .focus();
  await page.keyboard.press('Escape');
  await expect(sidebar).toBeFocused();
  await processFilter(page).focus();
  await page.keyboard.press('Escape');
  await expect(sidebar).toBeFocused();
});

test('shows the shortcuts while Ctrl is held', async ({ page }) => {
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Info');
  await expect(hints(page)).toHaveCount(0);

  await page.keyboard.down('Control');
  await expect(hints(page).first()).toBeVisible();
  await expect(hints(page)).toHaveText(['Ctrl+K', 'Ctrl+F', 'Alt+R', '1', '2', '3']);
  await expect(page.locator('[data-component="ShortcutHintBar"]')).toContainText('All shortcuts');
  await page.keyboard.up('Control');
  await expect(hints(page)).toHaveCount(0);

  // Ctrl+C is a chord, not a request for hints.
  await page.keyboard.down('Control');
  await page.keyboard.press('c');
  await page.waitForTimeout(600);
  await expect(hints(page)).toHaveCount(0);
  await page.keyboard.up('Control');
});

test('restarts, moves through processes and switches tabs from the keyboard', async ({ page }) => {
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Info');

  await page.keyboard.press('Alt+r');
  await expect(page.getByText('App "api" was restarted')).toBeVisible();

  // Ctrl+Down moves on and focuses the list, where plain Down goes on.
  await page.keyboard.press('Control+ArrowDown');
  await expect(page.getByRole('heading', { name: 'worker', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/processes\/1\/info$/);
  await expect(page.getByRole('navigation', { name: 'Processes' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('heading', { name: 'scheduler', exact: true })).toBeVisible();
  await page.keyboard.press('Control+ArrowUp');
  await expect(page.getByRole('heading', { name: 'worker', exact: true })).toBeVisible();

  await page.keyboard.press('2');
  await expect(page).toHaveURL(/\/processes\/1\/env$/);
  await page.keyboard.press('3');
  await expect(page).toHaveURL(/\/processes\/1\/logs$/);
  await page.keyboard.press('1');
  await expect(page).toHaveURL(/\/processes\/1\/info$/);
  // Typed into a box, a digit is just a digit.
  await processFilter(page).press('2');
  await expect(page).toHaveURL(/\/processes\/1\/info$/);
  await processFilter(page).fill('');

  // On the status page they move through the rows, and Enter opens one.
  await page.goto('/');
  await expect(processRow(page, 'api')).toBeVisible();
  await page.keyboard.press('Control+ArrowDown');
  await expect(processRow(page, 'api')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(processRow(page, 'worker')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'worker', exact: true })).toBeVisible();

  await page.keyboard.press('Control+k');
  await expect(page.getByRole('menu', { name: 'Daemons' })).toBeVisible();
});

test('follows the latest log lines again on End', async ({ page }) => {
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Logs');
  const scroller = page.locator('[data-component="LogsPage"] .overflow-auto');
  const anchored = page.getByRole('button', { name: 'Anchored to the latest line' });
  await expect(anchored).toBeVisible();

  await scroller.hover();
  await page.mouse.wheel(0, -3_000);
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
  await page.keyboard.press('End');
  await expect(anchored).toBeVisible();
  // In the search box, End only moves the caret.
  await page.mouse.wheel(0, -3_000);
  await page.getByPlaceholder('Filter loaded logs…').press('End');
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
});

test('lists the shortcuts, and takes other keys from keybindings.json', async ({ page }) => {
  await page.goto(FAKE_LAUNCH_PATH);
  await expect(processRow(page, 'api')).toBeVisible();

  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toContainText('Restart the open processes');
  await expect(dialog).toContainText('Alt+R');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // Typed into a box, "?" is just a character.
  await processFilter(page).press('?');
  await expect(processFilter(page)).toHaveValue('?');
  await expect(dialog).toBeHidden();

  await fs.writeFile(
    KEYBINDINGS_PATH,
    JSON.stringify({ bindings: { find: 'Alt+F', 'daemon.picker': null } })
  );
  await page.goto('/');
  await expect(processRow(page, 'api')).toBeVisible();
  await page.keyboard.down('Control');
  // No daemon picker key any more, and the filter's new key.
  await expect(hints(page)).toHaveText(['Alt+F']);
  await page.keyboard.up('Control');
  await page.keyboard.press('Alt+f');
  await expect(processFilter(page)).toBeFocused();
  await page.keyboard.press('Escape');

  // A broken file is reported, and the default keys apply meanwhile.
  await fs.writeFile(KEYBINDINGS_PATH, '{"bindings": {"process.kill": "Alt+K"}}');
  await page.goto('/');
  await expect(page.getByText(/"process\.kill" is not a shortcut action/)).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('menu', { name: 'Daemons' })).toBeVisible();
});
