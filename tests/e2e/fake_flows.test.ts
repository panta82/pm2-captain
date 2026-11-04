import {
  FAKE_LAUNCH_PATH,
  daemonRow,
  expect,
  openProcessTab,
  processRow,
  processRows,
  test,
} from '../support/fake_fixture';

const LOCAL_LABEL = 'captain@fake-host:/srv/local/.pm2';

test('moves between the processes of different daemons from the tree', async ({ page, fake }) => {
  await fake.send({ type: 'world.reset', scenario: 'multi' });
  const { daemons } = await fake.state();
  const idOf = (key: string) => daemons.find(daemon => daemon.key === key)!.daemonId;
  const heading = (name: string) => page.getByRole('heading', { name, exact: true });
  const links = page.getByRole('navigation', { name: 'Processes' }).getByRole('link');
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'worker', 'Logs');
  await expect(page).toHaveURL(new RegExp(`/daemons/${idOf('local')}/processes/1/logs$`));

  // A process keeps the tab, on any daemon. "api" of Blue stack comes after the two of Local.
  await links.filter({ hasText: /^api$/ }).nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/daemons/${idOf('blue')}/processes/0/logs$`));
  await expect(heading('api')).toBeVisible();
  await links.filter({ hasText: /^queue$/ }).click();
  await expect(page).toHaveURL(new RegExp(`/daemons/${idOf('staging')}/processes/1/logs$`));
  await expect(heading('queue')).toBeVisible();

  // Ctrl+Up goes back over the daemon rows, to the last process of the daemon above.
  await page.keyboard.press('Control+ArrowUp');
  await page.keyboard.press('Control+ArrowUp');
  await expect(page).toHaveURL(new RegExp(`/daemons/${idOf('blue')}/processes/1/logs$`));

  // A daemon that cannot be reached says why on its own row.
  await page.getByRole('link', { name: 'PM2 Captain' }).click();
  await expect(page).toHaveURL(/:3215\/$/);
  await expect(daemonRow(page, /prod\.example\.com/)).toContainText('unreachable');
  await expect(page.getByText('port 2222: Connection timed out')).toBeVisible();
});

test('selects and opens or closes a daemon with every click', async ({ page, fake }) => {
  await fake.send({ type: 'world.reset', scenario: 'multi' });
  const { daemons } = await fake.state();
  const stagingId = daemons.find(daemon => daemon.key === 'staging')!.daemonId;
  const stagingUrl = new RegExp(`/daemons/${stagingId}$`);
  const staging = page.getByRole('button', { name: 'deploy@staging-01', exact: true });
  const stagingChevron = page.getByRole('button', { name: /^(Collapse|Expand) deploy@staging/ });
  const stagingHeading = page.getByRole('heading', { name: 'deploy@staging-01' });
  const captain = page.getByRole('link', { name: 'PM2 Captain' });
  await page.goto(FAKE_LAUNCH_PATH);
  await expect(processRow(page, 'worker')).toBeVisible();

  // From the table: it is selected, the band is about it, and it closes. Others stay.
  await staging.click();
  await expect(page).toHaveURL(stagingUrl);
  await expect(stagingHeading).toBeVisible();
  await expect(processRow(page, 'queue')).toHaveCount(0);
  await expect(processRow(page, 'worker')).toBeVisible();

  // The next click opens it, and it stays selected.
  await staging.click();
  await expect(processRow(page, 'queue')).toBeVisible();
  await expect(page).toHaveURL(stagingUrl);

  // A double-click counts once.
  await staging.dblclick();
  await expect(processRow(page, 'queue')).toHaveCount(0);
  await staging.click();
  await expect(processRow(page, 'queue')).toBeVisible();

  // From a process, it does the same, which goes back to the table.
  await processRow(page, 'worker').getByText('worker', { exact: true }).click();
  await expect(page).toHaveURL(/\/processes\/1\//);
  await staging.click();
  await expect(page).toHaveURL(stagingUrl);
  await expect(stagingHeading).toBeVisible();
  await expect(processRow(page, 'queue')).toHaveCount(0);
  await expect(processRow(page, 'worker').getByRole('button', { name: 'Stop' })).toBeVisible();

  // The chevron only opens and closes: an open process stays open.
  await processRow(page, 'worker').getByText('worker', { exact: true }).click();
  await expect(page).toHaveURL(/\/processes\/1\//);
  await stagingChevron.click();
  await expect(processRow(page, 'queue')).toBeVisible();
  await expect(page).toHaveURL(/\/processes\/1\//);

  // A process opened from a selected daemon closes back to it, then to everything.
  await staging.click();
  await staging.click();
  await processRow(page, 'queue').getByText('queue', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'queue', exact: true })).toBeVisible();
  await processRow(page, 'queue').getByText('queue', { exact: true }).click();
  await expect(page).toHaveURL(stagingUrl);
  await page.getByRole('button', { name: 'Close daemon' }).click();
  await expect(page).toHaveURL(/:3215\/$/);

  // Captain and Escape go back to everything as well.
  await staging.click();
  await captain.click();
  await expect(page).toHaveURL(/:3215\/$/);
  await staging.click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/:3215\/$/);
  await staging.click();
  await expect(processRow(page, 'queue')).toBeVisible();
  await page.keyboard.press('Escape');

  // Enter does what a click does.
  await page.getByRole('navigation', { name: 'Processes' }).focus();
  await page.keyboard.press('Control+k');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: /fake-host/ })).toBeVisible();
  await expect(processRow(page, 'worker')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(processRow(page, 'worker')).toBeVisible();

  // The name of the daemon above the open process only leads to it.
  await processRow(page, 'worker').getByText('worker', { exact: true }).click();
  await page
    .getByRole('main')
    .getByRole('link', { name: /fake-host/ })
    .click();
  await expect(page.getByRole('heading', { name: /fake-host/ })).toBeVisible();
  await expect(processRow(page, 'worker')).toBeVisible();

  // Its address is enough, and the address of a daemon that is gone falls back.
  await page.goto(`/daemons/${stagingId}`);
  await expect(stagingHeading).toBeVisible();
  await fake.send({ type: 'registry.remove', daemon: 'staging' });
  await expect(page).toHaveURL(/:3215\/$/);
});

test('selects everything and opens or closes it with every click on Captain', async ({
  page,
  fake,
}) => {
  await fake.send({ type: 'world.reset', scenario: 'multi' });
  await page.goto(FAKE_LAUNCH_PATH);
  await expect(processRow(page, 'worker')).toBeVisible();
  const captain = page.getByRole('link', { name: 'PM2 Captain' });
  const links = page.getByRole('navigation', { name: 'Processes' }).getByRole('link');
  // Two for Local, two for Blue stack, two for staging; the fourth daemon has none.
  await expect(links).toHaveCount(6);

  await captain.click();
  await expect(links).toHaveCount(0);
  await expect(captain).toHaveAttribute('title', 'Expand all daemons');
  await captain.click();
  await expect(links).toHaveCount(6);
  await expect(captain).toHaveAttribute('title', 'Collapse all daemons');

  // With only some open, it opens the rest first.
  await page.getByRole('button', { name: /^Collapse Blue stack/ }).click();
  await expect(links).toHaveCount(4);
  await captain.click();
  await expect(links).toHaveCount(6);

  // From a process it does the same, which goes back to the table.
  await processRow(page, 'worker').getByText('worker', { exact: true }).click();
  await expect(page).toHaveURL(/\/processes\/1\//);
  await captain.click();
  await expect(page).toHaveURL(/:3215\/$/);
  await expect(links).toHaveCount(0);
  await captain.click();
  await expect(links).toHaveCount(6);

  // So it does from a selected daemon.
  await page.getByRole('button', { name: 'Blue stack', exact: true }).click();
  await expect(links).toHaveCount(4);
  await captain.click();
  await expect(page).toHaveURL(/:3215\/$/);
  await expect(links).toHaveCount(6);
});

test('rings the row of the keyboard cursor all the way around', async ({ page }) => {
  await page.goto(FAKE_LAUNCH_PATH);
  await expect(processRow(page, 'api')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  const row = processRow(page, 'api');
  await expect(row).toHaveAttribute('data-cursor', 'true');

  // The ring is drawn over the sticky name cell, which would otherwise cover it.
  const ring = await row.evaluate(element => {
    const style = getComputedStyle(element, '::after');
    return { width: style.outlineWidth, style: style.outlineStyle, zIndex: Number(style.zIndex) };
  });
  const nameCell = await row
    .getByRole('cell')
    .first()
    .evaluate(element => Number(getComputedStyle(element).zIndex));
  expect(ring.style).toBe('solid');
  expect(ring.width).toBe('2px');
  expect(ring.zIndex).toBeGreaterThan(nameCell);
});

test('collapses and expands daemons, and remembers them', async ({ page, fake }) => {
  await fake.send({ type: 'world.reset', scenario: 'multi' });
  await page.goto(FAKE_LAUNCH_PATH);
  await expect(processRow(page, 'worker')).toBeVisible();

  await page.getByRole('button', { name: /^Collapse captain@fake-host/ }).click();
  await expect(processRow(page, 'worker')).toHaveCount(0);
  await expect(page).toHaveURL(/:3215\/$/);
  await page.reload();
  await expect(processRow(page, 'queue')).toBeVisible();
  await expect(processRow(page, 'worker')).toHaveCount(0);

  // The filter opens what it finds, without changing what is remembered.
  await page.getByPlaceholder('Filter…').fill('worker');
  await expect(processRow(page, 'worker')).toBeVisible();
  await expect(page.locator('[data-tree-daemon]')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '1 of 6 processes' })).toBeVisible();
  // A daemon with matches can still be closed, until the filter changes.
  await page.getByRole('button', { name: /^Collapse captain@fake-host/ }).click();
  await expect(processRow(page, 'worker')).toHaveCount(0);
  await expect(page.locator('[data-tree-daemon]')).toHaveCount(1);
  await page.getByPlaceholder('Filter…').fill('worke');
  await expect(processRow(page, 'worker')).toBeVisible();
  await page.getByPlaceholder('Filter…').fill('');
  await expect(processRow(page, 'worker')).toHaveCount(0);

  // Its row works as usual while filtering: every click selects it, and closes or opens it.
  await page.getByPlaceholder('Filter…').fill('worker');
  const label = page.getByRole('button', { name: /^captain@fake-host/ });
  await label.click();
  await expect(page.getByRole('heading', { name: /fake-host/ })).toBeVisible();
  await expect(processRow(page, 'worker')).toHaveCount(0);
  await label.click();
  await expect(processRow(page, 'worker')).toBeVisible();
  await page.getByPlaceholder('Filter…').fill('');
  await expect(processRow(page, 'worker')).toHaveCount(0);
  await page.getByRole('link', { name: 'PM2 Captain' }).click();
  await expect(processRow(page, 'worker')).toBeVisible();

  // A daemon's name counts too, and takes all of its processes along.
  await page.getByPlaceholder('Filter…').fill('Blue stack');
  await expect(page.locator('[data-tree-daemon]')).toHaveCount(1);
  await expect(processRows(page)).toHaveCount(2);
  await expect(page.getByRole('heading', { name: /^2 of \d+ processes$/ })).toBeVisible();
  await page.getByPlaceholder('Filter…').fill('');

  // The keys of a tree: Left closes, Right opens and goes in.
  await page.getByRole('navigation', { name: 'Processes' }).focus();
  await page.keyboard.press('Control+k');
  await page.keyboard.press('ArrowLeft');
  await expect(processRow(page, 'worker')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(processRow(page, 'worker')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(processRow(page, 'api').first()).toHaveAttribute('data-cursor', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('[data-tree-daemon]').first()).toHaveAttribute('data-cursor', 'true');

  // An address opens the daemon of its process, however it was left.
  await page.getByRole('button', { name: /^Collapse deploy@staging/ }).click();
  await expect(processRow(page, 'queue')).toHaveCount(0);
  const stagingId = (await fake.state()).daemons.find(daemon => daemon.key === 'staging')!.daemonId;
  await page.goto(`/daemons/${stagingId}/processes/1/info`);
  await expect(processRow(page, 'queue')).toBeVisible();
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
  await expect(page.locator('[data-tree-daemon]')).toHaveCount(1);

  // With nothing to detect, the list stays empty.
  await fake.send({
    type: 'world.reset',
    scenario: { isFirstLaunch: true, daemons: [{ key: 'stopped', isUp: false }] },
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'No PM2 daemons' })).toBeVisible();
});

test('slides only the rows whose move can be seen', async ({ page, fake }) => {
  // Without namespaces, so that reversing the sort reverses the whole list.
  await fake.send({
    type: 'world.reset',
    scenario: { daemons: [{ key: 'local', processes: [{ name: 'worker', instances: 52 }] }] },
  });
  await page.setViewportSize({ width: 1500, height: 600 });
  await page.goto(FAKE_LAUNCH_PATH);
  const rows = processRows(page);
  await expect(rows).toHaveCount(52);
  const idHeader = page.getByRole('columnheader', { name: 'ID', exact: true });
  await idHeader.getByRole('button').click();
  await expect(idHeader).toHaveAttribute('aria-sort', 'ascending');

  // The first two processes end up above the screen, and about twelve fit on it.
  const scrollTop = await rows.nth(0).evaluate(row => {
    const scroller = row.closest('[data-tree-scroller]')!;
    scroller.scrollTop = 5 * row.getBoundingClientRect().height;
    return new Promise<number>(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(scroller.scrollTop)))
    );
  });
  const keys = await rows.evaluateAll(items =>
    items.map(item => (item as HTMLElement).dataset.rowKey as string)
  );
  const moved = await page.evaluateHandle(() => {
    const keysOfMoved: Array<string | undefined> = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: HTMLElement, ...args) {
      keysOfMoved.push(this.dataset.rowKey);
      return animate.apply(this, args);
    };
    return keysOfMoved;
  });

  // Reversing the list sends each row to the far side of the middle. This is a raw
  // click, because Playwright's own scrolls a sticky header back to the list's top.
  const button = (await idHeader.getByRole('button').boundingBox())!;
  await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
  await expect(idHeader).toHaveAttribute('aria-sort', 'descending');
  await expect(rows.first()).toHaveAttribute('data-row-key', keys.at(-1) as string);
  expect(await page.locator('[data-tree-scroller]').evaluate(item => item.scrollTop)).toBe(
    scrollTop
  );
  const movedKeys = await moved.jsonValue();
  // From the screen to below it.
  expect(movedKeys).toContain(keys[8]);
  // From above the screen to below it, which crosses it.
  expect(movedKeys).toContain(keys[0]);
  // From below the screen to below it.
  expect(movedKeys).not.toContain(keys[25]);
});

test('counts, filters and sorts a crowded daemon', async ({ page, fake }) => {
  await fake.send({ type: 'world.reset', scenario: 'busy' });
  await page.goto(FAKE_LAUNCH_PATH);
  const rows = processRows(page);
  await expect(rows).toHaveCount(52);
  // The band and the daemon add up all of them; the cron namespace has the stopped ones.
  await expect(page.getByTitle('48 online, 4 offline', { exact: true })).toHaveCount(2);
  await expect(page.getByTitle('4 offline', { exact: true })).toHaveCount(1);

  const filter = page.getByPlaceholder('Filter…');
  await filter.fill('worker-');
  await expect(rows).toHaveCount(16);
  await expect(rows.first().locator('mark')).toHaveText('worker-');
  // The status is searched too, though the tree shows it only as a dot.
  await filter.fill('stopped');
  await expect(rows).toHaveCount(4);
  await page.getByRole('button', { name: 'Regular expression' }).click();
  await filter.fill('cron-(cleanup|backups)');
  await expect(rows).toHaveCount(2);
  await filter.fill('cron-(');
  await expect(page.getByText(/Invalid regular expression/)).toBeVisible();
  await filter.fill('');
  await expect(rows).toHaveCount(52);

  // CPU wanders in this scenario, so every poll puts the rows in a new order. A sort
  // applies inside each namespace, which is a group of its own in the tree.
  const cpuColumn = () =>
    rows.evaluateAll(items => {
      const groups = new Map<string, number[]>();
      for (const item of items) {
        // The rows off screen are not rendered, so they have text but no innerText.
        const namespace = item.querySelector('[data-column="namespace"]')!.textContent!;
        const cpu = Number.parseFloat(item.querySelector('[data-column="cpu"]')!.textContent!);
        groups.set(namespace, [...(groups.get(namespace) ?? []), cpu]);
      }
      return [...groups.values()];
    });
  const isSorted = (groups: number[][], direction: 1 | -1) =>
    groups.every(values =>
      values.every((value, index) => index === 0 || (value - values[index - 1]) * direction >= 0)
    );
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

test('sorts the side menu from its button, and shows what it sorts by', async ({ page, fake }) => {
  await fake.send(
    { type: 'process.set', daemon: 'local', process: 'api', cpu: 3 },
    { type: 'process.set', daemon: 'local', process: 'worker', cpu: 40 }
  );
  await page.goto(FAKE_LAUNCH_PATH);
  const names = () =>
    processRows(page)
      .getByRole('link')
      .evaluateAll(links => links.map(link => link.querySelector('span span')?.textContent));
  const sortButton = page.getByRole('button', { name: /^Sort processes/ });
  await expect(processRow(page, 'api')).toBeVisible();

  await sortButton.click();
  await page.getByRole('menuitemradio', { name: 'Name', exact: true }).click();
  await expect.poll(names).toEqual(['api', 'mailer', 'scheduler', 'worker']);
  await expect(sortButton).toHaveAccessibleName('Sort processes: Name, ascending');
  // A choice closes the menu, and the keys are back on its button.
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(sortButton).toBeFocused();
  // The same item flips the order.
  await sortButton.click();
  await page.getByRole('menuitemradio', { name: 'Name', exact: true }).click();
  await expect.poll(names).toEqual(['worker', 'scheduler', 'mailer', 'api']);
  // Escape closes it without changing anything.
  await sortButton.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(sortButton).toBeFocused();
  await expect(sortButton).toHaveAccessibleName('Sort processes: Name, descending');

  // The headers change the same sort, and the third click ends it.
  await page.getByRole('button', { name: 'CPU', exact: true }).click();
  await expect(sortButton).toHaveAccessibleName('Sort processes: CPU, descending');
  await expect.poll(async () => (await names())[0]).toBe('worker');

  // Next to a process, the order stays, and the value that explains it shows.
  const worker = processRow(page, 'worker');
  await worker.getByText('worker', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'worker', exact: true })).toBeVisible();
  await expect(worker.getByRole('link')).toContainText('%');
  await expect.poll(async () => (await names())[0]).toBe('worker');

  // It is remembered.
  await page.reload();
  await expect(sortButton).toHaveAccessibleName('Sort processes: CPU, descending');
  await sortButton.click();
  await page.getByRole('menuitemradio', { name: 'PM2 order' }).click();
  await expect.poll(names).toEqual(['api', 'worker', 'scheduler', 'mailer']);
  await expect(worker.getByRole('link')).not.toContainText('%');
});

test('keeps a daemon on the screen while the rows around it open and close', async ({
  page,
  fake,
}) => {
  const daemon = (key: string) => ({
    key,
    label: key,
    pm2Home: `/srv/pm2-${key}`,
    processes: Array.from({ length: 12 }, (_, index) => ({ name: `${key}-${index}` })),
  });
  await fake.send({
    type: 'world.reset',
    scenario: { daemons: [daemon('alpha'), daemon('beta'), daemon('gamma')] },
  });
  await page.setViewportSize({ width: 1500, height: 600 });
  await page.goto(FAKE_LAUNCH_PATH);
  await expect(processRow(page, 'alpha-0')).toBeVisible();

  const scroller = page.locator('[data-tree-scroller]');
  const label = (name: string) => page.getByRole('button', { name, exact: true });
  const topOf = (name: string) =>
    label(name).evaluate(element => element.getBoundingClientRect().top);
  /** The row stays where it was, once anything sliding has settled. */
  const expectStill = async (name: string, top: number) => {
    await expect.poll(async () => Math.abs((await topOf(name)) - top)).toBeLessThan(1.5);
  };

  // The first daemon of a long list, with the list at its top: a click scrolls nothing.
  // A plain focus() scrolled the row away, under the column headers.
  const alphaTop = await topOf('alpha');
  await label('alpha').click();
  await expect(page.getByRole('heading', { name: 'alpha', exact: true })).toBeVisible();
  await expect(processRow(page, 'alpha-0')).toHaveCount(0);
  await expectStill('alpha', alphaTop);
  expect(await scroller.evaluate(element => element.scrollTop)).toBe(0);
  await label('alpha').click();
  await expect(processRow(page, 'alpha-0')).toBeVisible();
  await expectStill('alpha', alphaTop);

  // A daemon further down stays put as well, however it opens or closes.
  // It starts just below the headers, where it can stay with the list shorter too.
  const headerBottom = await page
    .locator('[data-component="ProcessStatsHeader"]')
    .evaluate(element => element.getBoundingClientRect().bottom);
  await label('beta').scrollIntoViewIfNeeded();
  const betaStart = await topOf('beta');
  await scroller.evaluate(
    (element, distance) => {
      element.scrollTop += distance;
    },
    betaStart - headerBottom - 30
  );
  await expect.poll(() => topOf('beta')).toBeLessThan(headerBottom + 40);
  const betaTop = await topOf('beta');
  await label('beta').click();
  await expect(page.getByRole('heading', { name: 'beta', exact: true })).toBeVisible();
  await expect(processRow(page, 'beta-0')).toHaveCount(0);
  await expectStill('beta', betaTop);
  await page.getByRole('button', { name: 'Close daemon' }).click();
  await expect(page.getByRole('heading', { name: /processes$/ })).toBeVisible();
  await expectStill('beta', betaTop);
  await page.getByRole('button', { name: 'Expand beta' }).click();
  await expect(processRow(page, 'beta-0')).toBeVisible();
  await expectStill('beta', betaTop);
  await page.getByRole('button', { name: 'Collapse beta' }).click();
  await expect(processRow(page, 'beta-0')).toHaveCount(0);
  await expectStill('beta', betaTop);
  await page.getByRole('button', { name: 'Expand beta' }).click();

  // With too little left below to hold its place, a row still ends up on the screen,
  // clear of the headers.
  await scroller.evaluate(element => {
    element.scrollTop = element.scrollHeight;
  });
  await label('gamma').scrollIntoViewIfNeeded();
  await label('gamma').click();
  await expect(processRow(page, 'gamma-0')).toHaveCount(0);
  await expect(label('gamma')).toBeInViewport();
  await expect.poll(() => topOf('gamma')).toBeGreaterThanOrEqual(headerBottom);
});
