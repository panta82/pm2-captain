import {
  FAKE_LAUNCH_PATH,
  expect,
  failOnPageError,
  processRow,
  test,
} from '../support/fake_fixture';

test('warns while the daemon list is broken, keeps the daemons, and recovers', async ({
  page,
  fake,
}) => {
  const expectNoPageError = failOnPageError(page);
  await page.goto(FAKE_LAUNCH_PATH);
  await expect(processRow(page, 'api')).toBeVisible();
  const warning = page.getByRole('alert').filter({ hasText: 'The daemon list cannot be loaded.' });

  await fake.send({ type: 'registry.fail', reason: 'invalid' });
  await expect(warning).toContainText('not valid JSON');
  await expect(processRow(page, 'api')).toBeVisible();

  await fake.send({ type: 'registry.fail', reason: 'missing' });
  await expect(warning).toContainText('missing');

  await fake.send({ type: 'registry.recover' });
  await expect(warning).toHaveCount(0);
  await expect(processRow(page, 'api')).toBeVisible();
  expectNoPageError();
});

test('follows renames and removals made outside Captain', async ({ page, fake }) => {
  await page.goto(FAKE_LAUNCH_PATH);
  await expect(processRow(page, 'api')).toBeVisible();

  await fake.send({ type: 'registry.edit', daemon: 'local', label: 'Renamed outside' });
  await expect(page.getByRole('button', { name: /^Daemon: / })).toContainText('Renamed outside');

  await fake.send({ type: 'registry.remove', daemon: 'local' });
  await expect(page.getByRole('heading', { name: 'No PM2 daemons' })).toBeVisible();

  await fake.send({ type: 'registry.add', daemon: 'local' });
  await expect(processRow(page, 'api')).toBeVisible();
});

test('leaves a process page when its daemon is moved elsewhere', async ({ page, fake }) => {
  const original = (await fake.state()).daemons[0].pm2Home!;
  await page.goto(FAKE_LAUNCH_PATH);
  await processRow(page, 'api').getByText('api', { exact: true }).click();
  await expect(page).toHaveURL(/\/processes\/0\//);

  await fake.send({ type: 'registry.edit', daemon: 'local', pm2Home: '/srv/moved-away/.pm2' });

  // The old PM2 IDs belong to the old location; the page goes back to the status.
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  await expect(page.getByText('The daemon was reconfigured. Showing its processes.')).toBeVisible();
  await expect(page.getByText('PM2 is not running in /srv/moved-away/.pm2.')).toBeVisible();

  await fake.send({ type: 'registry.edit', daemon: 'local', pm2Home: original });
  await expect(processRow(page, 'api')).toBeVisible();
});

test('keeps a draft when the daemon was changed outside Captain while its form was open', async ({
  page,
  fake,
}) => {
  await page.goto(FAKE_LAUNCH_PATH);
  await expect(processRow(page, 'api')).toBeVisible();
  await page.getByRole('button', { name: /^Daemon: / }).click();
  await page.getByRole('menuitem', { name: 'Manage daemons…' }).click();
  const dialog = page.getByRole('dialog', { name: 'PM2 daemons' });
  const label = dialog.getByLabel(/^Label/);
  await label.fill('My draft');

  await fake.send({ type: 'registry.edit', daemon: 'local', label: 'Edited outside' });
  await dialog.getByRole('button', { name: 'Save' }).click();

  await expect(
    dialog.getByText('This daemon was changed elsewhere since you opened it.')
  ).toBeVisible();
  await expect(label).toHaveValue('My draft');
  expect((await fake.state()).registry.daemons?.[0].label).toBe('Edited outside');

  await dialog.getByRole('button', { name: 'Load the saved version' }).click();
  await expect(label).toHaveValue('Edited outside');
});

test('keeps the working daemons and connections while two daemons share a location', async ({
  page,
  fake,
}) => {
  await fake.send({ type: 'world.reset', scenario: 'multi' });
  const original = (await fake.state()).daemons.find(daemon => daemon.key === 'local')!.pm2Home!;
  await page.goto(FAKE_LAUNCH_PATH);
  await expect(processRow(page, 'worker')).toBeVisible();
  // The daemons and their connections as the page's own API calls see them.
  const connections = () =>
    page.evaluate(async () => {
      const response = await fetch('/api/trpc/processes.list');
      const body = (await response.json()) as {
        result: { data: { daemons: Array<{ daemonId: string; connectionId: string }> } };
      };
      return body.result.data.daemons.map(daemon => [daemon.daemonId, daemon.connectionId]);
    });
  const before = await connections();
  const warning = page.getByRole('alert').filter({ hasText: 'The daemon list cannot be loaded.' });

  // Edited outside into the location of another daemon: the list is refused as a file would be.
  await fake.send({ type: 'registry.edit', daemon: 'local', pm2Home: '/srv/pm2-blue' });
  await expect(warning).toContainText("repeats another daemon's location");
  expect(await connections()).toEqual(before);
  await expect(processRow(page, 'worker')).toBeVisible();

  await fake.send({ type: 'registry.edit', daemon: 'local', pm2Home: original });
  await expect(warning).toHaveCount(0);
  expect(await connections()).toEqual(before);
});

test('keeps the draft and the notice when the saved version cannot be loaded', async ({
  page,
  fake,
}) => {
  await page.goto(FAKE_LAUNCH_PATH);
  await expect(processRow(page, 'api')).toBeVisible();
  await page.getByRole('button', { name: /^Daemon: / }).click();
  await page.getByRole('menuitem', { name: 'Manage daemons…' }).click();
  const dialog = page.getByRole('dialog', { name: 'PM2 daemons' });
  const label = dialog.getByLabel(/^Label/);
  await label.fill('My draft');
  await fake.send({ type: 'registry.edit', daemon: 'local', label: 'Edited outside' });
  await dialog.getByRole('button', { name: 'Save' }).click();
  const notice = dialog.getByText('This daemon was changed elsewhere since you opened it.');
  await expect(notice).toBeVisible();

  const isDaemonList = (url: URL) => url.pathname.includes('daemons.list');
  await page.route(isDaemonList, route => route.abort());
  await dialog.getByRole('button', { name: 'Load the saved version' }).click();
  await expect(page.getByText(/Unable to load the saved version/)).toBeVisible();
  await expect(label).toHaveValue('My draft');
  await expect(notice).toBeVisible();

  // A later change, right before loading: the load reads it, not a cached list.
  await page.unroute(isDaemonList);
  await fake.send({ type: 'registry.edit', daemon: 'local', label: 'Edited again' });
  await dialog.getByRole('button', { name: 'Load the saved version' }).click();
  await expect(label).toHaveValue('Edited again');
  await expect(notice).toHaveCount(0);
});
