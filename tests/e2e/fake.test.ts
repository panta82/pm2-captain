import { spawnSync } from 'node:child_process';

import {
  FAKE_LAUNCH_PATH,
  FAKE_TOKEN,
  FAKE_XDG_CONFIG_HOME,
  expect,
  openProcessTab,
  processRow,
  test,
} from '../support/fake_fixture';

const LOCAL_LABEL = 'captain@fake-host:/srv/local/.pm2';

/** Runs the Captain CLI the way a second terminal would. */
function runCaptain(...args: string[]) {
  return spawnSync('node', ['dist/backend/app.js', ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: FAKE_XDG_CONFIG_HOME },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

test('shows process states that are set from outside', async ({ page, fake }) => {
  await page.goto(FAKE_LAUNCH_PATH);
  const api = processRow(page, 'api');
  await expect(api.getByRole('button', { name: 'Restart' })).toBeVisible();

  await fake.send({
    type: 'process.set',
    daemon: 'local',
    process: 'api',
    status: 'errored',
    restarts: 42,
  });
  await expect(api.getByRole('button', { name: 'Start' })).toBeVisible();
  await expect(api.getByRole('button', { name: 'Stop' })).toBeDisabled();
  await expect(api.getByText('42', { exact: true })).toBeVisible();

  await fake.send(
    { type: 'process.set', daemon: 'local', process: 'api', status: 'online', cpu: 93.4 },
    { type: 'process.add', daemon: 'local', process: 'payments', namespace: 'billing' },
    { type: 'process.remove', daemon: 'local', process: 'worker' }
  );
  await expect(api.getByText('93.4%')).toBeVisible();
  await expect(processRow(page, 'payments').getByText('billing')).toBeVisible();
  await expect(processRow(page, 'worker')).toHaveCount(0);
});

test('runs process actions against the fake daemon', async ({ page, fake }) => {
  await page.goto(FAKE_LAUNCH_PATH);
  const worker = processRow(page, 'worker');

  await worker.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByText('App "worker" was stopped')).toBeVisible();
  await expect(worker.getByRole('button', { name: 'Start' })).toBeVisible();
  const [local] = (await fake.state()).daemons;
  expect(local.processes.find(process => process.name === 'worker')).toMatchObject({
    status: 'stopped',
    pid: null,
  });

  // The next action fails once, with the message the test chose.
  await fake.send({
    type: 'process.set',
    daemon: 'local',
    process: 'worker',
    nextActionError: 'Process failed to launch: EADDRINUSE',
  });
  await worker.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Process failed to launch: EADDRINUSE')).toBeVisible();
  await worker.getByRole('button', { name: 'Start' }).click();
  await expect(worker.getByRole('button', { name: 'Restart' })).toBeVisible();
});

test('shows given log lines from history, live, and after a rotation', async ({ page, fake }) => {
  await fake.send(
    {
      type: 'log.history',
      daemon: 'local',
      process: 'api',
      lines: Array.from(
        { length: 1_200 },
        (_, index) => `history line ${String(index + 1).padStart(4, '0')}`
      ),
    },
    { type: 'log.history', daemon: 'local', process: 'api', channel: 'err', lines: [] },
    // Nothing else may arrive while the test counts lines.
    { type: 'process.set', daemon: 'local', process: 'api', logRate: 0 }
  );
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Logs');

  // The combined view reads half a page from each channel.
  const loaded = page.getByTitle('Loaded lines');
  await expect(page.getByText('history line 1200')).toBeVisible();
  await expect(loaded).toHaveText('250');
  const scroller = page.locator('[data-component="LogsPage"] .overflow-auto');
  await scroller.evaluate(element => (element.scrollTop = 0));
  await expect(loaded).toHaveText('500');

  await fake.send({
    type: 'log.emit',
    daemon: 'local',
    process: 'api',
    channel: 'err',
    lines: ['a very particular failure'],
  });
  await expect(page.getByText('a very particular failure')).toBeVisible();
  await expect(loaded).toHaveText('501');

  await fake.send({ type: 'log.rotate', daemon: 'local', process: 'api', channel: 'out' });
  await scroller.evaluate(element => (element.scrollTop = 0));
  await expect(page.getByText('The active log file rotated')).toBeVisible();

  await page.getByRole('button', { name: 'Err', exact: true }).click();
  await expect(page.getByText('a very particular failure')).toBeVisible();
  await expect(loaded).toHaveText('1');
});

test('streams generated logs when generation is turned on', async ({ page, fake }) => {
  await fake.send({ type: 'process.add', daemon: 'local', process: 'ticker' });
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'ticker', 'Logs');
  await expect(page.getByText('No log lines in the active file yet.')).toBeVisible();

  await fake.send({
    type: 'process.set',
    daemon: 'local',
    process: 'ticker',
    logRate: 20,
    logProfile: 'json',
    logErrorRatio: 0,
  });
  await expect(page.getByTitle('Loaded lines')).not.toHaveText('0');
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(
    page
      .getByRole('button', { name: 'Resume', exact: true })
      .locator('..')
      .getByText(/^[1-9]\d*$/)
  ).toBeVisible();
});

test('follows a daemon that goes away and comes back', async ({ page, fake }) => {
  await page.goto(FAKE_LAUNCH_PATH);
  const restart = processRow(page, 'api').getByRole('button', { name: 'Restart' });
  await expect(restart).toBeEnabled();

  // The processes stay listed, but nothing can be done to them.
  await fake.send({ type: 'daemon.set', daemon: 'local', isUp: false });
  await expect(restart).toBeDisabled();
  await expect(restart).toHaveAttribute('title', 'Daemon is not connected');
  await page.getByRole('button', { name: /^Daemon: / }).click();
  await expect(page.getByRole('menuitemradio')).toContainText('connecting');
  await page.keyboard.press('Escape');

  await fake.send({ type: 'daemon.set', daemon: 'local', isUp: true });
  await expect(restart).toBeEnabled();
});

test('explains a daemon that cannot be reached, and retries it', async ({ page, fake }) => {
  await fake.send({
    type: 'world.reset',
    scenario: {
      daemons: [
        {
          key: 'local',
          isUp: false,
          error: 'The PM2 daemon is busy exploding.',
          processes: [{ name: 'api' }],
        },
      ],
    },
  });
  await page.goto(FAKE_LAUNCH_PATH);
  await expect(page.getByRole('heading', { name: `Can't reach ${LOCAL_LABEL}` })).toBeVisible();
  await expect(page.getByText('The PM2 daemon is busy exploding.')).toBeVisible();

  await fake.send({ type: 'daemon.set', daemon: 'local', isUp: true });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(processRow(page, 'api')).toBeVisible();
});

test('shows several daemons, and connects one that is added by hand', async ({ page, fake }) => {
  await fake.send({ type: 'world.reset', scenario: 'multi' });
  await page.goto(FAKE_LAUNCH_PATH);
  await expect(processRow(page, 'worker')).toBeVisible();

  const picker = page.getByRole('button', { name: /^Daemon: / });
  await picker.click();
  await expect(page.getByRole('menuitemradio')).toHaveCount(4);
  await expect(page.getByRole('menuitemradio', { name: /Blue stack/ })).toBeVisible();
  await expect(page.getByRole('menuitemradio', { name: /prod\.example\.com/ })).toContainText(
    'unreachable'
  );

  // A remote daemon is named by what the server reported about itself.
  await page.getByRole('menuitemradio', { name: /deploy@staging-01/ }).click();
  await expect(processRow(page, 'queue')).toBeVisible();
  await expect(processRow(page, 'worker')).toHaveCount(0);

  // The scenario keeps this daemon out of Captain's list until someone adds it.
  await page.getByRole('button', { name: /^Daemon: / }).click();
  await page.getByRole('menuitem', { name: 'Manage daemons…' }).click();
  const dialog = page.getByRole('dialog', { name: 'PM2 daemons' });
  await dialog.getByRole('tab', { name: 'Add daemon' }).click();
  await dialog.getByRole('button', { name: 'Local', exact: true }).click();
  await dialog.getByLabel('PM2 home').fill('/srv/pm2-spare');
  await dialog.getByRole('button', { name: 'Add daemon' }).click();
  await expect(dialog.getByRole('tab', { name: /pm2-spare/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await dialog.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: /^Daemon: / }).click();
  await page.getByRole('menuitemradio', { name: /pm2-spare/ }).click();
  await expect(processRow(page, 'spare-app')).toBeVisible();
});

test('marks the process that is Captain itself', async ({ page, fake }) => {
  await fake.send({ type: 'process.add', daemon: 'local', process: 'pm2-captain', pid: 'captain' });
  await page.goto(FAKE_LAUNCH_PATH);

  const captain = processRow(page, 'pm2-captain');
  await expect(captain.getByAltText('Captain')).toBeVisible();
  await expect(captain.getByRole('button', { name: 'Stop' })).toBeDisabled();
  await expect(captain.getByRole('button', { name: 'Stop' })).toHaveAttribute(
    'title',
    'Captain cannot stop itself'
  );
});

test('is controlled from the command line', async ({ page }) => {
  await page.goto(FAKE_LAUNCH_PATH);
  const worker = processRow(page, 'worker');
  await expect(worker.getByRole('button', { name: 'Restart' })).toBeVisible();

  const set = runCaptain(
    '--port',
    '3215',
    'fake',
    'process.set',
    'local',
    'worker',
    'status=stopped'
  );
  expect(set.stdout.trim()).toBe('OK');
  await expect(worker.getByRole('button', { name: 'Start' })).toBeVisible();

  const state = runCaptain('--port', '3215', 'fake', 'state');
  expect(JSON.parse(state.stdout)).toMatchObject({
    scenario: 'basic',
    daemons: [{ key: 'local' }],
  });

  const unknown = runCaptain('--port', '3215', 'fake', 'process.set', 'local', 'nope', 'cpu=1');
  expect(unknown.status).toBe(1);
  expect(unknown.stderr).toContain('The fake daemon "local" has no process "nope".');
});

test('keeps fake commands behind the launch token and out of a real Captain', async ({
  request,
}) => {
  const headers = { authorization: `Bearer ${FAKE_TOKEN}` };
  const command = { type: 'process.set', daemon: 'local', process: 'api', status: 'errored' };

  const anonymous = await request.get('/api/fake/state');
  expect(anonymous.status()).toBe(401);
  const fromPage = await request.post('/api/fake/commands', {
    data: command,
    headers: { ...headers, origin: 'http://127.0.0.1:3215' },
  });
  expect(fromPage.status()).toBe(403);

  // The other test server runs without --fake, with the same launch token.
  const real = await request.post('http://127.0.0.1:3214/api/fake/commands', {
    data: command,
    headers,
  });
  expect(real.status()).toBe(404);
  const realCommand = runCaptain('--port', '3214', 'fake', 'state');
  expect(realCommand.status).toBe(1);
  expect(realCommand.stderr).toContain('is not in fake mode');
});

test('never opens a fake Captain for a real launch, or the other way around', () => {
  const real = runCaptain('--no-open', '--port', '3215');
  expect(real.status).toBe(78);
  expect(real.stderr).toContain('Port 3215 already hosts a PM2 Captain in fake mode.');

  const fake = runCaptain('--no-open', '--port', '3214', '--fake');
  expect(fake.status).toBe(78);
  expect(fake.stderr).toContain('Port 3214 already hosts a PM2 Captain with real daemons.');
});
