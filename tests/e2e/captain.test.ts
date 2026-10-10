import { type Page, expect, test } from '@playwright/test';
import { existsSync, rmSync } from 'node:fs';

const launchPath = '/launch?token=pm2-captain-e2e-token';
const fixturePm2Home = '/tmp/pm2-captain-e2e';

async function openDaemonManager(page: Page) {
  await page.getByRole('button', { name: /^Daemon: / }).click();
  await page.getByRole('menuitem', { name: 'Manage daemons…' }).click();
  return page.getByRole('dialog', { name: 'PM2 daemons' });
}

test('requires a launch session for APIs', async ({ request }) => {
  const response = await request.get('/api/trpc/processes.list?batch=1&input=%7B%7D');
  expect(response.status()).toBe(401);
});

test('navigates status, info, environment, and streaming logs', async ({ page }) => {
  await page.goto(launchPath);
  await expect(page.getByText('captain-fixture', { exact: true }).first()).toBeVisible();

  await page.getByText('captain-fixture', { exact: true }).first().click();
  await expect(page).toHaveURL(/\/daemons\/[0-9a-f-]+\/processes\/0\/info$/);
  await expect(page.getByRole('heading', { name: 'CONFIGURATION' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'EXECUTION' })).toBeVisible();
  const processHeading = page.getByRole('heading', {
    name: 'captain-fixture',
    exact: true,
  });
  const processHeadingBox = await processHeading.boundingBox();
  expect(processHeadingBox?.y).toBeLessThan(60);
  await expect(page.getByRole('navigation', { name: 'Processes' })).not.toContainText('%');
  await expect(page.getByText('Environment values are never shown')).toHaveCount(0);

  await page.getByRole('link', { name: 'Env' }).click();
  await expect(page).toHaveURL(/\/daemons\/[0-9a-f-]+\/processes\/0\/env$/);
  await expect(page.getByRole('heading', { name: /^ENVIRONMENT/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /DIVERGENT/ })).toHaveCount(0);
  const divergentVariable = page.getByText('PM2_CAPTAIN_E2E_ENV', { exact: true });
  await expect(divergentVariable).toBeVisible();
  await expect(divergentVariable).toHaveClass(/text-warning/);
  await expect(divergentVariable).toHaveAttribute('title', 'Differs from local environment');
  await expect(page.getByText('visible', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Logs' }).click();
  await expect(page.getByText('fixture output').first()).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();
  const resumeButton = page.getByRole('button', { name: 'Resume', exact: true });
  await expect(resumeButton).toBeVisible();
  await expect(resumeButton.locator('..').getByText(/^[1-9]\d*$/)).toBeVisible({
    timeout: 5_000,
  });
  await resumeButton.click();

  await page.getByPlaceholder('Filter loaded logs…').fill('fixture error');
  await expect(page.getByText('fixture error').first()).toBeVisible();
  // The sidebar's process filter has the same toggles, so address the log toolbar.
  await page.getByRole('main').getByRole('button', { name: 'Regular expression' }).click();
  await page.getByPlaceholder('Filter loaded logs…').fill('fixture error \\d+');
  await expect(page.getByText('fixture error').first()).toBeVisible();
  await page.getByRole('button', { name: 'Err', exact: true }).click();
  await expect(page.getByText('fixture error').first()).toBeVisible();
});

test('restarts, stops, and starts a fixture', async ({ page }) => {
  await page.goto(launchPath);
  const row = page.getByRole('row', { name: /captain-fixture/ });
  const restartButton = row.getByRole('button', { name: 'Restart' });
  const runningPrimaryWidth = (await restartButton.boundingBox())?.width;
  await restartButton.click();
  await expect(page.getByText('App "captain-fixture" was restarted')).toBeVisible();

  await row.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const startButton = row.getByRole('button', { name: 'Start' });
  await expect(startButton).toBeVisible({
    timeout: 10_000,
  });
  await expect(row.getByRole('button', { name: 'Stop' })).toBeDisabled();
  expect((await startButton.boundingBox())?.width).toBe(runningPrimaryWidth);
  await startButton.click();
  await expect(row.getByRole('button', { name: 'Restart' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(row.getByRole('button', { name: 'Stop' })).toBeEnabled();
});

test('keeps process actions on compact mobile cards', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(launchPath);

  const card = page.locator('article').filter({ hasText: 'captain-fixture' });
  await expect(card.getByText('captain-fixture', { exact: true })).toBeVisible();

  const startButton = card.getByRole('button', { name: 'Start' });
  if (await startButton.isVisible()) {
    await startButton.click();
  }

  await expect(card.getByRole('button', { name: 'Restart' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Stop' })).toBeVisible();
  await page.getByRole('button', { name: 'Open captain-fixture' }).click();
  await expect(page).toHaveURL(/\/daemons\/[0-9a-f-]+\/processes\/0\/info$/);
  await expect(page.getByRole('button', { name: 'Restart' })).toBeVisible();
});

test('redirects a stale process route back to status', async ({ page }) => {
  await page.goto(launchPath);
  await page.getByText('captain-fixture', { exact: true }).first().click();
  const daemonId = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/daemons/${daemonId}/processes/99999/info`);
  await expect(page).toHaveURL('http://127.0.0.1:3214/');
});

test('shows one daemon at a time and manages daemons in the settings screen', async ({ page }) => {
  await page.goto(launchPath);
  const localRow = page.getByRole('row', { name: /captain-fixture/ });
  await expect(localRow).toBeVisible();

  await page.getByRole('button', { name: /^Daemon: / }).click();
  await expect(page.getByRole('menuitemradio')).toHaveCount(1);
  await expect(page.getByRole('menuitemradio')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  // The fixture PM2 is a regular entry, and the screen closes from the backdrop or its button.
  let dialog = await openDaemonManager(page);
  await expect(dialog.getByRole('tab')).toHaveCount(2);
  await expect(dialog.getByLabel('PM2 home')).toHaveValue(fixturePm2Home);
  await expect(dialog.getByRole('button', { name: 'Delete' })).toBeVisible();
  await page.mouse.click(8, 8);
  await expect(dialog).toHaveCount(0);
  dialog = await openDaemonManager(page);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);

  dialog = await openDaemonManager(page);
  await dialog.getByRole('tab', { name: 'Add daemon' }).click();
  await dialog.getByLabel('SSH destination').fill('127.0.0.1');
  await dialog.getByLabel('Port').fill('1');
  await dialog.getByLabel('Extra SSH options').fill('-o BatchMode=yes -o ConnectTimeout=1');
  await dialog.getByLabel('PM2 home (optional)').fill('/srv/pm2/');
  await dialog.getByLabel('Label (optional)').fill('staging');
  await dialog.getByRole('button', { name: 'Add daemon' }).click();

  // The new daemon opens in its own tab, showing how it is configured.
  await expect(dialog.getByRole('tab', { name: /staging/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(dialog.getByLabel('SSH destination')).toHaveValue('127.0.0.1');
  await expect(dialog.getByLabel('Port')).toHaveValue('1');
  await expect(dialog.getByLabel('Extra SSH options')).toHaveValue(
    '-o BatchMode=yes -o ConnectTimeout=1'
  );
  await expect(dialog.getByLabel('PM2 home (optional)')).toHaveValue('/srv/pm2');

  const saveButton = dialog.getByRole('button', { name: 'Save' });
  await expect(saveButton).toBeDisabled();
  await dialog.getByLabel('SSH destination').fill('elsewhere');
  await dialog.getByRole('button', { name: 'Reset' }).click();
  await expect(dialog.getByLabel('SSH destination')).toHaveValue('127.0.0.1');
  await dialog.getByLabel('Label (optional)').fill('broken');
  await saveButton.click();
  await expect(dialog.getByRole('tab', { name: /broken/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(saveButton).toBeDisabled();

  // A local PM2 home without a daemon is listed, but nothing is created there.
  const missingPm2Home = '/tmp/pm2-captain-e2e-missing';
  rmSync(missingPm2Home, { recursive: true, force: true });
  await dialog.getByRole('tab', { name: 'Add daemon' }).click();
  await dialog.getByRole('button', { name: 'Local', exact: true }).click();
  await dialog.getByLabel('PM2 home').fill(missingPm2Home);
  await dialog.getByRole('button', { name: 'Add daemon' }).click();
  await expect(dialog.getByText(`PM2 is not running in ${missingPm2Home}.`)).toBeVisible();
  expect(existsSync(missingPm2Home)).toBe(false);
  page.once('dialog', confirmation => confirmation.accept());
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(dialog.getByRole('tab')).toHaveCount(3);
  await dialog.getByRole('button', { name: 'Close' }).click();

  // Managing daemons leaves the page on the daemon it was showing.
  await expect(localRow).toBeVisible();

  // Daemons are summarized by process counts; an unreachable one has none to show.
  await page.getByRole('button', { name: /^Daemon: / }).click();
  const localOption = page.getByRole('menuitemradio').first();
  await expect(localOption.getByTitle('1 online')).toBeVisible();
  await expect(localOption.getByTitle('0 offline')).toBeVisible();
  const remoteOption = page.getByRole('menuitemradio', { name: /broken/ });
  await expect(remoteOption).toContainText('unreachable');
  await remoteOption.click();
  const remotePicker = page.getByRole('button', { name: 'Daemon: broken' });
  await expect(remotePicker).toBeVisible();
  await expect(localRow).toHaveCount(0);
  await expect(page.getByRole('heading', { name: "Can't reach broken" })).toBeVisible();

  await remotePicker.click();
  await page.getByRole('menuitemradio').first().click();
  await expect(localRow).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'DAEMON' })).toHaveCount(0);

  await localRow.getByText('captain-fixture', { exact: true }).click();
  await expect(page).toHaveURL(/\/daemons\/[0-9a-f-]+\/processes\/0\//);
  const sidebar = page.locator('[data-component="ResizableSidebar"]');
  const processLink = page
    .getByRole('navigation', { name: 'Processes' })
    .getByRole('link', { name: 'captain-fixture', exact: true });
  expect((await processLink.boundingBox())?.height).toBe(48);

  // The sidebar filters its own list while the open process stays in view.
  const sidebarFilter = sidebar.getByPlaceholder('Filter processes…');
  await sidebarFilter.fill('no-such-process');
  await expect(sidebar.getByText('No processes match the filter.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'captain-fixture', exact: true })).toBeVisible();
  await sidebarFilter.fill('fixture');
  await expect(processLink.locator('mark')).toHaveText('fixture');
  await sidebarFilter.fill('');
  await expect(processLink.locator('mark')).toHaveCount(0);

  const sidebarWidth = (await sidebar.boundingBox())?.width || 0;
  const resizeHandle = page.getByRole('separator', { name: 'Resize process sidebar' });
  await resizeHandle.focus();
  await resizeHandle.press('ArrowRight');
  expect((await sidebar.boundingBox())?.width).toBeGreaterThan(sidebarWidth);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('pm2-captain:process-sidebar-width')))
    .toBe(String(sidebarWidth + 16));

  // A daemon without processes has no process page to switch to.
  await sidebar.getByRole('button', { name: /^Daemon: / }).click();
  await page.getByRole('menuitemradio', { name: /broken/ }).click();
  await expect(page).toHaveURL('http://127.0.0.1:3214/');
  await expect(page.getByRole('heading', { name: "Can't reach broken" })).toBeVisible();

  // The settings screen opens on the current daemon, which can be deleted from its tab.
  dialog = await openDaemonManager(page);
  await expect(dialog.getByRole('tab', { name: /broken/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  page.once('dialog', confirmation => confirmation.accept());
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(dialog.getByRole('tab')).toHaveCount(2);

  // Without any daemon, the status page offers to add one.
  await dialog.getByRole('tab', { name: /pm2-captain-e2e/ }).click();
  page.once('dialog', confirmation => confirmation.accept());
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(dialog.getByRole('tab')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('heading', { name: 'No PM2 daemons' })).toBeVisible();
  await page.getByRole('button', { name: 'Add daemon' }).click();
  dialog = page.getByRole('dialog', { name: 'PM2 daemons' });
  await dialog.getByRole('button', { name: 'Local', exact: true }).click();
  await dialog.getByLabel('PM2 home').fill(fixturePm2Home);
  await dialog.getByRole('button', { name: 'Add daemon' }).click();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(localRow).toBeVisible();
});

test('authenticates command-line daemon handoffs', async ({ page }) => {
  await page.goto(launchPath);
  // Port 1 keeps the handed-off daemon from reaching the developer's own PM2.
  const input = {
    kind: 'ssh',
    sshArgs: ['-o', 'BatchMode=yes', '-p', '1', '127.0.0.1'],
  };
  const headers = { authorization: 'Bearer pm2-captain-e2e-token' };

  const unauthorized = await page.request.post('/launch/daemon', { data: input });
  expect(unauthorized.status()).toBe(401);

  const response = await page.request.post('/launch/daemon', { data: input, headers });
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ added: true });

  const local = await page.request.post('/launch/daemon', {
    data: { kind: 'local', pm2Home: fixturePm2Home },
    headers,
  });
  expect(await local.json()).toMatchObject({ added: false });
  const invalid = await page.request.post('/launch/daemon', {
    data: { ...input, pm2Home: 'relative/pm2' },
    headers,
  });
  expect(invalid.status()).toBe(400);

  // Tabs are the local daemon, the handed-off daemon, and "Add daemon".
  const dialog = await openDaemonManager(page);
  await expect(dialog.getByRole('tab')).toHaveCount(3);
  await dialog.getByRole('tab').nth(1).click();
  page.once('dialog', confirmation => confirmation.accept());
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(dialog.getByRole('tab')).toHaveCount(2);
});

test('offers a clear way home from an unknown route', async ({ page }) => {
  await page.goto(launchPath);
  await page.goto('/does-not-exist');

  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByText('Bad url? Click the button below to go back home.')).toBeVisible();
  await page.getByRole('link', { name: 'Go home' }).click();
  await expect(page).toHaveURL('http://127.0.0.1:3214/');
  await expect(page.getByText('captain-fixture', { exact: true }).first()).toBeVisible();
});
