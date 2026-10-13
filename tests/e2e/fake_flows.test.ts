import type { Page } from '@playwright/test';

import {
  FAKE_LAUNCH_PATH,
  expect,
  openProcessTab,
  processRow,
  test,
} from '../support/fake_fixture';

const LOCAL_LABEL = 'captain@fake-host:/srv/local/.pm2';

async function pickDaemon(page: Page, name: RegExp) {
  await page
    .getByRole('button', { name: /^Daemon: / })
    .first()
    .click();
  await page.getByRole('menuitemradio', { name }).click();
}

test('follows a process to the daemon that is switched to', async ({ page, fake }) => {
  await fake.send({ type: 'world.reset', scenario: 'multi' });
  const { daemons } = await fake.state();
  const idOf = (key: string) => daemons.find(daemon => daemon.key === key)!.daemonId;
  const heading = (name: string) => page.getByRole('heading', { name, exact: true });
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Logs');
  await expect(page).toHaveURL(new RegExp(`/daemons/${idOf('local')}/processes/0/logs$`));

  // The process of the same name, on the same tab.
  await pickDaemon(page, /Blue stack/);
  await expect(page).toHaveURL(new RegExp(`/daemons/${idOf('blue')}/processes/0/logs$`));
  await expect(heading('api')).toBeVisible();
  await pickDaemon(page, /deploy@staging-01/);
  await expect(page).toHaveURL(new RegExp(`/daemons/${idOf('staging')}/processes/0/logs$`));

  // Without a process of that name, the first one.
  await page
    .getByRole('navigation', { name: 'Processes' })
    .getByRole('link', { name: 'queue' })
    .click();
  await expect(heading('queue')).toBeVisible();
  await pickDaemon(page, /Blue stack/);
  await expect(heading('api')).toBeVisible();

  // A daemon that shows no processes has no process page to go to.
  await pickDaemon(page, /prod\.example\.com/);
  await expect(page).toHaveURL(/:3215\/$/);
  await expect(
    page.getByRole('heading', { name: "Can't reach deploy@prod.example.com" })
  ).toBeVisible();
  await expect(page.getByText('port 2222: Connection timed out')).toBeVisible();
});

test('leaves the page of a process that is gone', async ({ page, fake }) => {
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'worker', 'Info');
  await expect(page.getByRole('heading', { name: 'worker', exact: true })).toBeVisible();

  await fake.send({ type: 'process.remove', daemon: 'local', process: 'worker' });

  // The Info tab retries the lookup a few times before it gives up.
  await expect(page).toHaveURL(/:3215\/$/, { timeout: 15_000 });
  await expect(processRow(page, 'api')).toBeVisible();
  await expect(processRow(page, 'worker')).toHaveCount(0);
});

test('starts with the local daemons it detects on a first launch', async ({ page, fake }) => {
  await fake.send({
    type: 'world.reset',
    scenario: {
      isFirstLaunch: true,
      daemons: [
        { key: 'running', processes: [{ name: 'solo' }] },
        { key: 'stopped', isUp: false, processes: [{ name: 'never-seen' }] },
        { key: 'remote', kind: 'ssh', sshArgs: ['deploy@remote'], processes: [{ name: 'far' }] },
      ],
    },
  });
  await page.goto(FAKE_LAUNCH_PATH);
  await expect(processRow(page, 'solo')).toBeVisible();
  await page.getByRole('button', { name: /^Daemon: / }).click();
  await expect(page.getByRole('menuitemradio')).toHaveCount(1);

  // With nothing to detect, the list stays empty.
  await fake.send({
    type: 'world.reset',
    scenario: { isFirstLaunch: true, daemons: [{ key: 'stopped', isUp: false }] },
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'No PM2 daemons' })).toBeVisible();
});

test('counts, filters and sorts a crowded daemon', async ({ page, fake }) => {
  await fake.send({ type: 'world.reset', scenario: 'busy' });
  await page.goto(FAKE_LAUNCH_PATH);
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(52);
  await expect(page.getByTitle('48 online')).toBeVisible();
  await expect(page.getByTitle('4 offline')).toBeVisible();

  const filter = page.getByPlaceholder('Filter processes…');
  await filter.fill('worker-');
  await expect(rows).toHaveCount(16);
  await expect(rows.first().locator('mark')).toHaveText('worker-');
  // The status is searched too, though the table shows it only as a dot.
  await filter.fill('stopped');
  await expect(rows).toHaveCount(4);
  await page.getByRole('button', { name: 'Regular expression' }).click();
  await filter.fill('cron-(cleanup|backups)');
  await expect(rows).toHaveCount(2);
  await filter.fill('cron-(');
  await expect(page.getByText(/Invalid regular expression/)).toBeVisible();
  await filter.fill('');
  await expect(rows).toHaveCount(52);

  // CPU wanders in this scenario, so every poll puts the rows in a new order.
  const cpuColumn = () =>
    rows.evaluateAll(items =>
      items.map(item => Number.parseFloat((item as HTMLTableRowElement).cells[5].innerText))
    );
  const isSorted = (values: number[], direction: 1 | -1) =>
    values.every((value, index) => index === 0 || (value - values[index - 1]) * direction >= 0);
  await page.getByRole('button', { name: 'CPU', exact: true }).click();
  const firstDirection = isSorted(await cpuColumn(), 1) ? 1 : -1;
  await expect.poll(async () => isSorted(await cpuColumn(), firstDirection)).toBe(true);
  await page.waitForTimeout(2_500);
  expect(isSorted(await cpuColumn(), firstDirection)).toBe(true);
  await page.getByRole('button', { name: 'CPU', exact: true }).click();
  await expect
    .poll(async () => isSorted(await cpuColumn(), firstDirection === 1 ? -1 : 1))
    .toBe(true);
});

test('shows a slow action while it runs', async ({ page, fake }) => {
  await fake.send({
    type: 'process.set',
    daemon: 'local',
    process: 'worker',
    actionDelayMs: 2_500,
  });
  await page.goto(FAKE_LAUNCH_PATH);
  const worker = processRow(page, 'worker');

  await worker.getByRole('button', { name: 'Stop' }).click();
  // Nothing else can be asked of the process until PM2 answers.
  await expect(worker.getByRole('button', { name: /^(Start|Restart)$/ })).toBeDisabled();
  await expect(worker.getByRole('button', { name: 'Stop' })).toBeDisabled();
  const [local] = (await fake.state()).daemons;
  expect(local.processes.find(process => process.name === 'worker')?.status).toBe('stopping');

  await expect(page.getByText('App "worker" was stopped')).toBeVisible();
  await expect(worker.getByRole('button', { name: 'Start' })).toBeEnabled();
});

test('waits for a daemon that is slow to connect', async ({ page, fake }) => {
  await fake.send({
    type: 'world.reset',
    scenario: {
      daemons: [{ key: 'local', connectDelayMs: 2_500, processes: [{ name: 'api' }] }],
    },
  });
  await page.goto(FAKE_LAUNCH_PATH);

  await expect(page.getByText(`Connecting to ${LOCAL_LABEL}…`)).toBeVisible();
  await expect(processRow(page, 'api')).toBeVisible();
});
