import type { Page } from '@playwright/test';

import type { IFakeScenario } from '../../src/backend/fake/fake_scenario';
import {
  FAKE_LAUNCH_PATH,
  expect,
  openProcessTab,
  processRow,
  test,
} from '../support/fake_fixture';

const SELECTION_SCENARIO: IFakeScenario = {
  daemons: [
    {
      key: 'local',
      processes: [
        { name: 'api', version: '2.14.0', env: { LOG_LEVEL: 'info', PORT: '3000' } },
        { name: 'mail', version: '2.14.0', env: { LOG_LEVEL: 'info' } },
        { name: 'billing', version: '2.13.4', env: { LOG_LEVEL: 'debug' } },
        {
          name: 'export',
          version: '2.14.0',
          status: 'stopped',
          env: { LOG_LEVEL: 'info' },
        },
        { name: 'pm2-captain', pid: 'captain' },
      ],
    },
  ],
};

const sidebarLink = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Processes' }).getByRole('link', { name, exact: true });
const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });
const matrixRow = (page: Page, label: string) =>
  page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: label }) });

test('selects processes in the sidebar and compares them', async ({ page, fake }) => {
  await fake.send({ type: 'world.reset', scenario: SELECTION_SCENARIO });
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Info');

  await sidebarLink(page, 'billing').click({ modifiers: ['Control'] });
  await expect(heading(page, '2 processes')).toBeVisible();
  await expect(page).toHaveURL(/\/processes\/0,2\/info$/);

  // Shift takes everything from the last picked process to the clicked one.
  await sidebarLink(page, 'api').click();
  await sidebarLink(page, 'export').click({ modifiers: ['Shift'] });
  await expect(heading(page, '4 processes')).toBeVisible();
  await expect(page).toHaveURL(/\/processes\/0,1,2,3\/info$/);
  await expect(page.getByRole('columnheader')).toContainText(['api', 'mail', 'billing', 'export']);
  await expect(page.getByRole('link', { name: 'Logs' })).toHaveCount(0);

  // One process on an older version stands out; a row that is the same everywhere does not.
  const version = matrixRow(page, 'version');
  await expect(version).toHaveAttribute('data-differs', 'true');
  await expect(version.locator('[data-odd]')).toHaveText(['2.13.4']);
  await expect(matrixRow(page, 'namespace')).not.toHaveAttribute('data-differs');
  await page.getByRole('button', { name: 'Only differences' }).click();
  await expect(matrixRow(page, 'namespace')).toHaveCount(0);
  await expect(version).toBeVisible();

  await page.getByRole('link', { name: 'Env' }).click();
  await expect(matrixRow(page, 'LOG_LEVEL').locator('[data-odd]')).toHaveText(['debug']);
  // Most processes have no PORT at all, so having one is not the odd case.
  await expect(matrixRow(page, 'PORT')).toHaveAttribute('data-differs', 'true');
  await expect(matrixRow(page, 'PORT').locator('[data-odd]')).toHaveCount(0);

  // The selection is in the URL, so it survives a reload.
  await page.reload();
  await expect(heading(page, '4 processes')).toBeVisible();

  await page.getByRole('button', { name: 'Remove mail from selection' }).click();
  await expect(heading(page, '3 processes')).toBeVisible();

  // The check box of a process adds and removes it without a modifier key.
  const checkBox = (name: string) => page.getByRole('checkbox', { name: `Select ${name}` });
  await checkBox('mail').click();
  await expect(heading(page, '4 processes')).toBeVisible();
  await expect(checkBox('mail')).toBeChecked();
  await checkBox('mail').focus();
  await page.keyboard.press('Enter');
  await expect(heading(page, '3 processes')).toBeVisible();
  await expect(checkBox('mail')).not.toBeChecked();

  // The first Escape goes back to one process, the second to the list.
  await sidebarLink(page, 'billing').click({ modifiers: ['Control'] });
  await expect(heading(page, '2 processes')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/processes\/\d\/env$/);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/:3215\/$/);
});

test('acts on a whole selection, and leaves Captain running', async ({ page, fake }) => {
  await fake.send({ type: 'world.reset', scenario: SELECTION_SCENARIO });
  await fake.send({ type: 'process.set', daemon: 'local', process: 'mail', actionDelayMs: 1_500 });
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Info');
  await page.getByRole('navigation', { name: 'Processes' }).focus();
  await page.keyboard.press('Control+a');
  await expect(heading(page, '5 processes')).toBeVisible();

  const actions = page.locator('[data-component="BulkProcessActions"]:visible');
  const button = (name: string | RegExp) => actions.getByRole('button', { name, exact: true });
  await expect(button('Start 1')).toBeEnabled();
  await expect(button('Restart 4')).toBeEnabled();
  await expect(button('Stop 3')).toHaveAttribute(
    'title',
    'Captain is skipped: it cannot stop itself'
  );

  // Stopping several processes takes a second click.
  await button('Stop 3').click();
  expect(
    (await fake.state()).daemons[0].processes.every(process => process.status !== 'stopping')
  ).toBe(true);
  // The confirmation is for the processes it was asked for, not for a changed selection.
  await page.getByRole('checkbox', { name: 'Select billing' }).click();
  await expect(button('Stop 2')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select billing' }).click();
  await button('Stop 3').click();
  await button('Really stop 3?').click();
  await expect(matrixRow(page, 'status').getByText('stopping…')).toHaveCount(3);
  await expect(button(/^Start/)).toBeDisabled();
  await expect(page.getByText('3 processes were stopped')).toBeVisible();

  const statuses = async () =>
    Object.fromEntries(
      (await fake.state()).daemons[0].processes.map(process => [process.name, process.status])
    );
  expect(await statuses()).toEqual({
    api: 'stopped',
    mail: 'stopped',
    billing: 'stopped',
    export: 'stopped',
    'pm2-captain': 'online',
  });

  // One failure does not hold the others back, and its reason stays on the process.
  await fake.send(
    {
      type: 'process.set',
      daemon: 'local',
      process: 'billing',
      nextActionError: 'Process failed to launch: EADDRINUSE',
    },
    { type: 'process.set', daemon: 'local', process: 'export', nextActionError: 'Disk is full' }
  );
  await button('Start 4').click();
  await expect(page.getByText('2 of 4 processes were started, 2 failed')).toBeVisible();
  // Each process keeps its own reason.
  const statusCells = matrixRow(page, 'status').getByRole('cell');
  await expect(statusCells.nth(2)).toHaveText('Process failed to launch: EADDRINUSE');
  await expect(statusCells.nth(3)).toHaveText('Disk is full');
  expect(await statuses()).toMatchObject({ api: 'online', mail: 'online' });
});

test('opens the rows picked in the status table once the key is let go', async ({ page, fake }) => {
  await fake.send({ type: 'world.reset', scenario: SELECTION_SCENARIO });
  await page.goto(FAKE_LAUNCH_PATH);
  const name = (process: string) => processRow(page, process).getByText(process, { exact: true });

  await page.keyboard.down('Control');
  await name('api').click();
  await name('billing').click();
  await name('export').click();
  await name('billing').click();
  await expect(page).toHaveURL(/:3215\/$/);
  await page.keyboard.up('Control');
  await expect(page).toHaveURL(/\/processes\/0,3\/info$/);
  await expect(heading(page, '2 processes')).toBeVisible();

  await page.getByRole('button', { name: 'Close selection' }).click();
  await page.keyboard.down('Shift');
  await name('mail').click();
  await name('export').click();
  await page.keyboard.up('Shift');
  await expect(heading(page, '3 processes')).toBeVisible();
  await expect(page).toHaveURL(/\/processes\/1,2,3\/info$/);
});

test('keeps the rest of a selection when one of its processes is gone', async ({ page, fake }) => {
  await fake.send({ type: 'world.reset', scenario: SELECTION_SCENARIO });
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Info');
  await sidebarLink(page, 'billing').click({ modifiers: ['Shift'] });
  await expect(heading(page, '3 processes')).toBeVisible();

  // The first process of the selection is the one whose lookup the page watches.
  await fake.send({ type: 'process.remove', daemon: 'local', process: 'api' });
  await expect(heading(page, '2 processes')).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/processes\/1,2\/info$/);
  await expect(page.getByRole('columnheader')).toContainText(['mail', 'billing']);
});
