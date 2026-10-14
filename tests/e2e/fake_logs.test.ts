import { promises as fs } from 'node:fs';

import {
  FAKE_LAUNCH_PATH,
  downloadLogLines,
  expect,
  failOnPageError,
  logLines,
  openProcessTab,
  test,
} from '../support/fake_fixture';

/** A log line stamped `second` seconds after a fixed moment. */
const stamp = (second: number) => new Date(Date.UTC(2026, 0, 1, 10, 0, second)).toISOString();
const line = (second: number, text: string) => `${stamp(second)} ${text}`;

test('virtualizes wrapped rows without overlap after scrolling, resizing and toggling wrap', async ({
  page,
  fake,
}, testInfo) => {
  const expectNoPageError = failOnPageError(page);
  await fake.send({
    type: 'log.history',
    daemon: 'local',
    process: 'api',
    lines: Array.from({ length: 400 }, (_, index) =>
      line(
        index,
        index % 3 === 0 && index < 399
          ? `long-${index} ${'payload '.repeat(250)}`
          : `short-${index}`
      )
    ),
  });
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Logs');
  await page.getByRole('button', { name: 'Out', exact: true }).click();
  await expect(page.getByTitle('Loaded lines')).toHaveText('400');
  const rows = page.locator('[data-component="LogRow"]');
  const scroller = page.locator('[data-component="LogsPage"] .overflow-auto');
  const expectMeasuredRows = async () => {
    await expect.poll(() => rows.count()).toBeGreaterThan(0);
    expect(await rows.count()).toBeLessThan(100);
    await expect
      .poll(() =>
        rows.evaluateAll(elements => {
          const boxes = elements.map(element => element.getBoundingClientRect());
          return boxes.every((box, index) => index === 0 || box.top >= boxes[index - 1].bottom - 1);
        })
      )
      .toBe(true);
  };
  await expect(page.getByText(line(399, 'short-399'), { exact: true })).toBeInViewport();
  await expectMeasuredRows();
  await scroller.evaluate(element => {
    element.scrollTop = element.scrollHeight / 2;
  });
  await expectMeasuredRows();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectMeasuredRows();
  await page.getByRole('button', { name: 'Wrap lines', exact: true }).click();
  await expectMeasuredRows();
  await page.getByRole('button', { name: 'Wrap lines', exact: true }).click();
  await scroller.evaluate(element => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByText(line(399, 'short-399'), { exact: true })).toBeInViewport();
  await expectMeasuredRows();
  await page.screenshot({ path: testInfo.outputPath('wrapped-logs-mobile.png') });
  expectNoPageError();
});

test.beforeEach(async ({ fake }) => {
  // Only what a test writes may show up while it counts lines.
  await fake.send(
    { type: 'process.set', daemon: 'local', process: 'api', logRate: 0 },
    { type: 'log.history', daemon: 'local', process: 'api', channel: 'out', lines: [] },
    { type: 'log.history', daemon: 'local', process: 'api', channel: 'err', lines: [] }
  );
});

test('keeps the newest 20,000 lines of a flood and stays usable', async ({ page, fake }) => {
  const expectNoPageError = failOnPageError(page);
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Logs');
  const loaded = page.getByTitle('Loaded lines');
  await expect(loaded).toHaveText('0');

  await fake.send({
    type: 'log.emit',
    daemon: 'local',
    process: 'api',
    lines: ['flood line {n}'],
    repeat: 30_000,
  });
  await expect(loaded).toHaveText('20000', { timeout: 20_000 });
  const lines = await downloadLogLines(page);
  expect([lines[0], lines.at(-1)]).toEqual(['flood line 10001', 'flood line 30000']);

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  expectNoPageError();
});

test('keeps following new lines once 20,000 are loaded', async ({ page, fake }) => {
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Logs');
  const emit = (text: string, repeat: number) =>
    fake.send({ type: 'log.emit', daemon: 'local', process: 'api', lines: [text], repeat });

  // Up to the limit, the newest line is followed.
  await emit('fill line {n}', 20_000);
  await expect(page.getByTitle('Loaded lines')).toHaveText('20000', { timeout: 20_000 });
  await expect(page.getByText('fill line 20000', { exact: true })).toBeInViewport();

  await emit('line {n} past the limit', 30);
  const newest = page.getByText('line 30 past the limit', { exact: true });
  await expect(newest).toBeAttached();
  await expect(newest).toBeInViewport({ timeout: 3_000 });
});

test('says how many lines it dropped while paused', async ({ page, fake }) => {
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Logs');
  await page.getByRole('button', { name: 'Pause' }).click();
  const resume = page.getByRole('button', { name: 'Resume', exact: true });

  await fake.send({
    type: 'log.emit',
    daemon: 'local',
    process: 'api',
    lines: ['paused line {n}'],
    repeat: 6_000,
  });
  // The pause buffer holds 5,000 lines and keeps the newest.
  await expect(resume.locator('..').getByText('5000', { exact: true })).toBeVisible();
  await expect(page.getByText('1000 paused events were dropped from memory.')).toBeVisible();
  await expect(page.getByTitle('Loaded lines')).toHaveText('0');

  await resume.click();
  await expect(page.getByTitle('Loaded lines')).toHaveText('5000');
  const lines = await downloadLogLines(page);
  expect([lines[0], lines.at(-1)]).toEqual(['paused line 1001', 'paused line 6000']);
});

test('filters the loaded lines and jumps from a match to its surroundings', async ({
  page,
  fake,
}) => {
  await fake.send({
    type: 'log.history',
    daemon: 'local',
    process: 'api',
    // One page of the combined view. With more history, a filter that leaves
    // few lines scrolls to the top, and that loads the page before.
    lines: Array.from({ length: 250 }, (_, index) =>
      line(index + 1, (index + 1) % 50 === 0 ? `needle ${index + 1}` : `hay ${index + 1}`)
    ),
  });
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Logs');
  await expect(page.getByTitle('Loaded lines')).toHaveText('250');

  const filter = page.getByPlaceholder('Filter loaded logs…');
  await filter.fill('needle');
  const count = page.getByTitle('Filtered / loaded lines');
  await expect(count).toHaveText('5/250');
  expect(await logLines(page)).toEqual([50, 100, 150, 200, 250].map(n => line(n, `needle ${n}`)));

  await page.getByRole('main').getByRole('button', { name: 'Regular expression' }).click();
  await filter.fill('needle [12]00$');
  await expect(count).toHaveText('2/250');
  await filter.fill('needle [');
  await expect(page.getByText(/Invalid regular expression/)).toBeVisible();
  await filter.fill('needle [12]00$');
  await expect(count).toHaveText('2/250');

  // The timestamp of a match clears the filter and shows the line among its neighbours.
  await page
    .locator('[data-component="LogRow"]')
    .filter({ hasText: 'needle 200' })
    .getByTitle('Clear filter and show surrounding log context')
    .click();
  await expect(filter).toHaveValue('');
  await expect(page.getByTitle('Loaded lines')).toHaveText('250');
  await expect(page.getByText(line(199, 'hay 199'))).toBeInViewport();
  await expect(page.getByText(line(200, 'needle 200'))).toBeInViewport();
  await expect(page.getByText(line(201, 'hay 201'))).toBeInViewport();
});

test('downloads exactly the lines the filter shows', async ({ page, fake }) => {
  await fake.send(
    {
      type: 'log.history',
      daemon: 'local',
      process: 'api',
      channel: 'out',
      lines: [line(1, 'keep this'), line(2, 'drop this'), line(4, 'keep this as well')],
    },
    {
      type: 'log.history',
      daemon: 'local',
      process: 'api',
      channel: 'err',
      lines: [line(3, 'keep this error')],
    }
  );
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Logs');
  await page.getByPlaceholder('Filter loaded logs…').fill('keep');
  await expect(page.getByTitle('Filtered / loaded lines')).toHaveText('3/4');

  const downloadStarted = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download filtered logs' }).click();
  const download = await downloadStarted;

  expect(download.suggestedFilename()).toMatch(/^pm2-0-combined-filtered-.+\.log$/);
  expect(await fs.readFile(await download.path(), 'utf8')).toBe(
    [
      `${stamp(1)} [OUT] ${line(1, 'keep this')}`,
      `${stamp(3)} [ERR] ${line(3, 'keep this error')}`,
      `${stamp(4)} [OUT] ${line(4, 'keep this as well')}`,
      '',
    ].join('\n')
  );
});

test('orders stdout and stderr by time, and splits them by channel', async ({ page, fake }) => {
  const out = [line(1, 'out one'), line(3, 'out three')];
  const err = [line(2, 'err two'), line(4, 'err four')];
  await fake.send(
    { type: 'log.history', daemon: 'local', process: 'api', channel: 'out', lines: out },
    { type: 'log.history', daemon: 'local', process: 'api', channel: 'err', lines: err }
  );
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Logs');

  await expect.poll(() => logLines(page)).toEqual([out[0], err[0], out[1], err[1]]);
  await page.getByRole('button', { name: 'Out', exact: true }).click();
  await expect.poll(() => logLines(page)).toEqual(out);
  await page.getByRole('button', { name: 'Err', exact: true }).click();
  await expect.poll(() => logLines(page)).toEqual(err);
});

test('says when the daemon is lost, and carries on when it is back', async ({ page, fake }) => {
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Logs');
  await expect(page.getByText('No log lines in the active file yet.')).toBeVisible();

  await fake.send({ type: 'daemon.set', daemon: 'local', isUp: false });
  await expect(page.getByText('PM2 event bus disconnected')).toBeVisible();

  await fake.send(
    { type: 'daemon.set', daemon: 'local', isUp: true },
    { type: 'log.emit', daemon: 'local', process: 'api', lines: ['back in business'] }
  );
  await expect(page.getByText('back in business')).toBeVisible();
});

test('shows a JSON log line the same way live as after a reload', async ({ page, fake }) => {
  await page.goto(FAKE_LAUNCH_PATH);
  await openProcessTab(page, 'api', 'Logs');
  await expect(page.getByText('No log lines in the active file yet.')).toBeVisible();

  await fake.send({
    type: 'log.emit',
    daemon: 'local',
    process: 'api',
    lines: [JSON.stringify({ level: 'info', time: stamp(1), message: 'Order 42 was shipped' })],
  });
  await expect(page.getByTitle('Loaded lines')).toHaveText('1');
  const [live] = await logLines(page);
  await page.reload();
  await expect(page.getByTitle('Loaded lines')).toHaveText('1');
  const [reloaded] = await logLines(page);

  expect(reloaded).toBe('Order 42 was shipped');
  test.fail(
    true,
    'Known bug: logManager.page() shows the "message" of a JSON line, logManager.stream() shows the raw JSON.'
  );
  expect(live).toBe(reloaded);
});
