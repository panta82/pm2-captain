import {
  FAKE_LAUNCH_PATH,
  downloadLogLines,
  expect,
  failOnPageError,
  openProcessTab,
  test,
} from '../support/fake_fixture';

function createSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

test('retains visited tab DOM and scroll without fetching environment again', async ({
  page,
  fake,
}) => {
  const expectNoPageError = failOnPageError(page);
  await fake.send({
    type: 'process.set',
    daemon: 'local',
    process: 'api',
    env: Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`SETTING_${index}`, 'test'])
    ),
  });
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Env');
  const environment = page.locator('[data-component="EnvPanel"]');
  await expect(environment).toBeVisible();
  await environment.evaluate(element => element.setAttribute('data-retained', 'yes'));
  const envPage = page.locator('[data-component="EnvPage"]');
  await envPage.evaluate(element => {
    element.scrollTop = 400;
  });
  await page.getByRole('link', { name: 'Info', exact: true }).click();
  await expect(environment).toBeHidden();
  await expect(environment).toBeAttached();

  const environmentRequests: string[] = [];
  page.on('request', request => {
    if (
      request.url().includes('processes.detail') &&
      request.url().includes('includeEnvironment')
    ) {
      environmentRequests.push(request.url());
    }
  });
  // Revisit beyond the old 500 ms stale time.
  await page.waitForTimeout(650);
  await page.getByRole('link', { name: 'Env', exact: true }).click();
  await expect(environment).toBeVisible();
  await expect(environment).toHaveAttribute('data-retained', 'yes');
  expect(await envPage.evaluate(element => element.scrollTop)).toBe(400);
  await page.waitForTimeout(200);
  expect(environmentRequests).toEqual([]);
  expectNoPageError();
});

test('lays out offscreen environment values after scrolling, resizing and tab visits', async ({
  page,
  fake,
}) => {
  const expectNoPageError = failOnPageError(page);
  const value = 'a-long-unbroken-environment-value-'.repeat(40);
  await fake.send({
    type: 'process.set',
    daemon: 'local',
    process: 'api',
    env: {
      ...Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => [`SETTING_${index}`, 'test'])
      ),
      ZZZ_WRAPPED_VALUE: value,
    },
  });
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Env');
  const envPage = page.locator('[data-component="EnvPage"]');
  const row = page
    .locator('[data-component="EnvPanel"] dl > div')
    .filter({ hasText: 'ZZZ_WRAPPED_VALUE' });
  for (const width of [1500, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await row.scrollIntoViewIfNeeded();
    await expect(row.getByText(value, { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        row.evaluate(element => {
          const content = element.querySelector('dd')!;
          return (
            content.getBoundingClientRect().height > 40 &&
            element.getBoundingClientRect().height >= content.getBoundingClientRect().height + 24
          );
        })
      )
      .toBe(true);
    const offset = await envPage.evaluate(element => element.scrollTop);
    await page.getByRole('link', { name: 'Info', exact: true }).click();
    await page.getByRole('link', { name: 'Env', exact: true }).click();
    await expect(row.getByText(value, { exact: true })).toBeVisible();
    await expect.poll(() => envPage.evaluate(element => element.scrollTop)).toBe(offset);
  }
  expectNoPageError();
});

test('retains log controls and catches up on output written while hidden', async ({
  page,
  fake,
}) => {
  const expectNoPageError = failOnPageError(page);
  await fake.send(
    { type: 'process.set', daemon: 'local', process: 'api', logRate: 0 },
    { type: 'log.history', daemon: 'local', process: 'api', lines: ['keep before leaving'] },
    { type: 'log.history', daemon: 'local', process: 'api', channel: 'err', lines: [] }
  );
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Logs');
  const logs = page.locator('[data-component="LogsPage"]');
  await logs.evaluate(element => element.setAttribute('data-retained', 'yes'));
  await page.getByRole('button', { name: 'Out', exact: true }).click();
  await expect(page.getByTitle('Loaded lines')).toHaveText('1');
  await page.getByPlaceholder('Filter loaded logs…').fill('keep');
  await expect(page.getByTitle('Filtered / loaded lines')).toHaveText('1/1');
  await page.getByRole('link', { name: 'Info', exact: true }).click();
  await expect(logs).toBeHidden();
  await fake.send({
    type: 'log.emit',
    daemon: 'local',
    process: 'api',
    lines: ['keep while away', 'other output'],
  });
  await expect(logs.getByTitle('Filtered / loaded lines')).toHaveText('1/1');
  await page.getByRole('link', { name: 'Logs', exact: true }).click();
  await expect(logs).toHaveAttribute('data-retained', 'yes');
  await expect(page.getByRole('button', { name: 'Out', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByPlaceholder('Filter loaded logs…')).toHaveValue('keep');
  await expect(page.getByTitle('Filtered / loaded lines')).toHaveText('2/3');
  await expect(page.getByText('keep while away', { exact: true })).toBeVisible();
  expectNoPageError();
});

test('keeps paused output frozen across tab visits and resumes without duplicating lines', async ({
  page,
  fake,
}) => {
  const expectNoPageError = failOnPageError(page);
  await fake.send(
    { type: 'process.set', daemon: 'local', process: 'api', logRate: 0 },
    { type: 'log.history', daemon: 'local', process: 'api', lines: ['before pause'] },
    { type: 'log.history', daemon: 'local', process: 'api', channel: 'err', lines: [] }
  );
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Logs');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await fake.send({
    type: 'log.emit',
    daemon: 'local',
    process: 'api',
    lines: ['repeated message'],
  });
  const resume = page.getByRole('button', { name: 'Resume', exact: true });
  await expect(resume.locator('..')).toContainText('1');
  await page.getByRole('link', { name: 'Info', exact: true }).click();
  await fake.send({
    type: 'log.emit',
    daemon: 'local',
    process: 'api',
    lines: ['repeated message', 'while hidden'],
  });
  const reconnected = page.waitForResponse(response => response.url().includes('logs.stream'));
  await page.getByRole('link', { name: 'Logs', exact: true }).click();
  await reconnected;
  await expect(page.getByTitle('Loaded lines')).toHaveText('1');
  expect(await downloadLogLines(page)).toEqual(['before pause']);
  const resumedStream = page.waitForResponse(response => response.url().includes('logs.stream'));
  await resume.click();
  await expect(page.getByTitle('Loaded lines')).toHaveText('4');
  await resumedStream;
  expect(await downloadLogLines(page)).toEqual([
    'before pause',
    'repeated message',
    'repeated message',
    'while hidden',
  ]);
  await fake.send({ type: 'log.emit', daemon: 'local', process: 'api', lines: ['after resume'] });
  await expect(page.getByTitle('Loaded lines')).toHaveText('5');
  expectNoPageError();
});

test('preserves older loaded pages and reading position until explicitly jumping to latest', async ({
  page,
  fake,
}) => {
  const expectNoPageError = failOnPageError(page);
  await fake.send(
    { type: 'process.set', daemon: 'local', process: 'api', logRate: 0 },
    {
      type: 'log.history',
      daemon: 'local',
      process: 'api',
      lines: Array.from({ length: 900 }, (_, index) => `history ${index}`),
    },
    { type: 'log.history', daemon: 'local', process: 'api', channel: 'err', lines: [] }
  );
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Logs');
  await page.getByRole('button', { name: 'Out', exact: true }).click();
  await expect(page.getByTitle('Loaded lines')).toHaveText('500');
  const scroller = page.locator('[data-component="LogsPage"] .overflow-auto');
  await scroller.evaluate(element => {
    element.scrollTop = 0;
  });
  await expect(page.getByTitle('Loaded lines')).toHaveText('900');
  await scroller.evaluate(element => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByText('history 899', { exact: true })).toBeInViewport();
  await page.getByRole('link', { name: 'Info', exact: true }).click();
  const unchangedRefresh = page.waitForResponse(response => response.url().includes('logs.page'));
  await page.getByRole('link', { name: 'Logs', exact: true }).click();
  await unchangedRefresh;
  await expect(page.getByTitle('Loaded lines')).toHaveText('900');
  await scroller.evaluate(element => {
    element.scrollTop = element.scrollHeight / 2;
  });
  await expect(page.getByText('history 450', { exact: true })).toBeInViewport();
  const previousOffset = await scroller.evaluate(element => element.scrollTop);
  const previousLines = await downloadLogLines(page);
  await page.getByRole('link', { name: 'Info', exact: true }).click();
  await fake.send({
    type: 'log.emit',
    daemon: 'local',
    process: 'api',
    lines: ['written while reading elsewhere'],
  });
  await page.getByRole('link', { name: 'Logs', exact: true }).click();
  await expect(page.getByTitle('Loaded lines')).toHaveText('900');
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(previousOffset);
  expect(await downloadLogLines(page)).toEqual(previousLines);
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  await expect(page.getByTitle('Loaded lines')).toHaveText('500');
  await expect(page.getByText('written while reading elsewhere', { exact: true })).toBeInViewport();
  expectNoPageError();
});

test('retries a failed catch-up on Resume to recover output missed while disconnected', async ({
  page,
  fake,
}) => {
  const expectNoPageError = failOnPageError(page);
  await fake.send(
    { type: 'process.set', daemon: 'local', process: 'api', logRate: 0 },
    { type: 'log.history', daemon: 'local', process: 'api', lines: ['before pause'] },
    { type: 'log.history', daemon: 'local', process: 'api', channel: 'err', lines: [] }
  );
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Logs');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await fake.send({
    type: 'log.emit',
    daemon: 'local',
    process: 'api',
    lines: ['buffered before catch-up'],
  });
  const resume = page.getByRole('button', { name: 'Resume', exact: true });
  await expect(resume.locator('..')).toContainText('1');
  const held = createSignal();
  const released = createSignal();
  let hasFailedOnce = false;
  await page.route('**/api/trpc/**', async route => {
    if (!route.request().url().includes('logs.page') || hasFailedOnce) {
      await route.continue();
      return;
    }
    hasFailedOnce = true;
    held.resolve();
    await released.promise;
    await route.abort('failed');
  });
  try {
    await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
    await held.promise;
    await fake.send({
      type: 'log.emit',
      daemon: 'local',
      process: 'api',
      lines: ['missed during catch-up'],
    });
    released.resolve();
    await expect(resume).toBeEnabled();
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(1);
    await resume.click();
    await expect(page.getByTitle('Loaded lines')).toHaveText('3');
    expect(await downloadLogLines(page)).toEqual([
      'before pause',
      'buffered before catch-up',
      'missed during catch-up',
    ]);
    expectNoPageError();
  } finally {
    released.resolve();
  }
});

test('cancels older history when hidden and ignores its response after catch-up', async ({
  page,
  fake,
}) => {
  const expectNoPageError = failOnPageError(page);
  await fake.send(
    { type: 'process.set', daemon: 'local', process: 'api', logRate: 0 },
    {
      type: 'log.history',
      daemon: 'local',
      process: 'api',
      lines: Array.from({ length: 700 }, (_, index) => `old history ${index}`),
    },
    { type: 'log.history', daemon: 'local', process: 'api', channel: 'err', lines: [] }
  );
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Logs');
  await page.getByRole('button', { name: 'Out', exact: true }).click();
  await expect(page.getByTitle('Loaded lines')).toHaveText('500');
  const held = createSignal();
  const released = createSignal();
  const finished = createSignal();
  let hasHeldResponse = false;
  await page.route('**/api/trpc/**', async route => {
    const url = new URL(route.request().url());
    const input = JSON.parse(url.searchParams.get('input') ?? '{}') as Record<
      string,
      { cursor?: string | null }
    >;
    const isOlder =
      url.pathname.includes('logs.page') &&
      Object.values(input).some(value => typeof value.cursor === 'string');
    if (!isOlder || hasHeldResponse) {
      await route.continue();
      return;
    }
    hasHeldResponse = true;
    const response = await route.fetch();
    held.resolve();
    await released.promise;
    // The browser may already have aborted this request when Activity hid it.
    if (!route.request().failure()) {
      await route.fulfill({ response });
    }
    finished.resolve();
  });
  try {
    const scroller = page.locator('[data-component="LogsPage"] .overflow-auto');
    await scroller.evaluate(element => {
      element.scrollTop = 0;
    });
    await held.promise;
    await page.getByRole('link', { name: 'Info', exact: true }).click();
    await fake.send({
      type: 'log.history',
      daemon: 'local',
      process: 'api',
      lines: ['fresh snapshot'],
    });
    await page.getByRole('link', { name: 'Logs', exact: true }).click();
    await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
    await expect(page.getByTitle('Loaded lines')).toHaveText('1');
    released.resolve();
    await finished.promise;
    await page.waitForTimeout(200);
    expect(await downloadLogLines(page)).toEqual(['fresh snapshot']);
    await expect(page.getByText('fresh snapshot', { exact: true })).toBeInViewport();
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
    expectNoPageError();
  } finally {
    released.resolve();
  }
});

test('refreshes cached environment after a process action and keeps polling Info', async ({
  page,
  fake,
}) => {
  await fake.send({
    type: 'process.set',
    daemon: 'local',
    process: 'api',
    env: { REVISION: 'first' },
  });
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Env');
  const environment = page.locator('[data-component="EnvPanel"]');
  await expect(environment.getByText('first', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Info', exact: true }).click();
  await fake.send({
    type: 'process.set',
    daemon: 'local',
    process: 'api',
    env: { REVISION: 'second' },
  });
  await page
    .getByRole('button', { name: 'Restart', exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.getByText('App "api" was restarted')).toBeVisible();
  await page.getByRole('link', { name: 'Env', exact: true }).click();
  await expect(environment.getByText('second', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Info', exact: true }).click();
  await fake.send({ type: 'process.set', daemon: 'local', process: 'api', restarts: 87 });
  await expect(
    page.locator('[data-component="InfoPage"]').getByText('87', { exact: true })
  ).toHaveCount(2);
});

test('bounds retained tabs to the current process and isolates cached environment', async ({
  page,
  fake,
}) => {
  await fake.send(
    { type: 'process.set', daemon: 'local', process: 'api', env: { OWNER: 'api-only' } },
    { type: 'process.set', daemon: 'local', process: 'worker', env: { OWNER: 'worker-only' } }
  );
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Env');
  await expect(page.getByText('api-only', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Info', exact: true }).click();
  await expect(page.locator('[data-component="EnvPanel"]')).toBeAttached();
  const info = page.locator('[data-component="InfoPage"]');
  const sidebar = page.getByRole('navigation', { name: 'Processes' });
  // Reusing the Info DOM applies when the target's details are already cached.
  await sidebar.getByRole('link', { name: 'worker', exact: true }).click();
  await expect(info).toContainText('worker');
  await sidebar.getByRole('link', { name: 'api', exact: true }).click();
  await expect(info).toContainText('api');
  await info.evaluate(element => element.setAttribute('data-retained', 'yes'));
  await page
    .getByRole('navigation', { name: 'Processes' })
    .getByRole('link', { name: 'worker' })
    .click();
  await expect(page.getByRole('heading', { name: 'worker', exact: true })).toBeVisible();
  await expect(info).toHaveAttribute('data-retained', 'yes');
  await expect(page.locator('[data-component="EnvPanel"]')).toHaveCount(0);
  await page.getByRole('link', { name: 'Env', exact: true }).click();
  await expect(page.getByText('worker-only', { exact: true })).toBeVisible();
  await expect(page.getByText('api-only', { exact: true })).toHaveCount(0);
  await page
    .getByRole('navigation', { name: 'Processes' })
    .getByRole('link', { name: 'api', exact: true })
    .click();
  await expect(page.getByText('api-only', { exact: true })).toBeVisible();
  await expect(page.getByText('worker-only', { exact: true })).toHaveCount(0);
});

test('restores the remembered single-process tab when leaving a multi-selection', async ({
  page,
}) => {
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Logs');
  const worker = page
    .getByRole('navigation', { name: 'Processes' })
    .getByRole('link', { name: 'worker', exact: true });
  await worker.click({ modifiers: ['Control'] });
  await expect(page).toHaveURL(/\/processes\/0,1\/info$/);
  await expect(worker).toHaveAttribute('href', /\/processes\/1\/logs$/);
  await worker.click();
  await expect(page).toHaveURL(/\/processes\/1\/logs$/);
  await expect(page.locator('[data-component="LogsPage"]')).toBeVisible();
});

test('resolves process addresses entered by hand', async ({ page }) => {
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Env');
  const base = new URL(page.url()).pathname.replace(/\/processes\/.*$/, '/processes');
  const notFound = page.getByRole('heading', { name: 'Page not found' });

  // A process without a tab opens the remembered one.
  await page.goto(`${base}/0`);
  await expect(page).toHaveURL(new RegExp(`${base}/0/env$`));

  // Several processes have no Logs tab.
  await page.goto(`${base}/1,0/logs`);
  await expect(page).toHaveURL(new RegExp(`${base}/0,1/info$`));
  await expect(page.locator('[data-component="ProcessMatrix"]').first()).toBeVisible();

  // One selection has one address, so its tab shows as active.
  for (const [path, canonical, tab] of [
    [`${base}/1,0,1/env`, `${base}/0,1/env`, 'Env'],
    [`${base}/00/info`, `${base}/0/info`, 'Info'],
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${canonical}$`));
    await expect(page.getByRole('link', { name: tab, exact: true })).toHaveAttribute(
      'aria-current',
      'page'
    );
  }

  for (const path of [`${base}/0/bogus`, `${base}/abc/info`, `${base}/0,,1/info`]) {
    await page.goto(path);
    await expect(notFound, path).toBeVisible();
  }
});
