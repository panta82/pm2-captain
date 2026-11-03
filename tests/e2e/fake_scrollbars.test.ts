import { FAKE_LAUNCH_PATH, expect, processRow, test } from '../support/fake_fixture';

// Playwright hides scrollbars in a headless browser, and these tests are about them.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

test('keeps the side menu the same between the table and an open process', async ({
  page,
  fake,
}) => {
  await fake.send({
    type: 'world.reset',
    scenario: {
      daemons: [
        {
          key: 'local',
          processes: Array.from({ length: 30 }, (_, index) => ({ name: `app-${index}` })),
        },
      ],
    },
  });
  await page.setViewportSize({ width: 1500, height: 600 });
  await page.goto(FAKE_LAUNCH_PATH);
  await expect(processRow(page, 'app-1')).toBeVisible();
  const positions = () =>
    page.evaluate(() => {
      const right = (selector: string) =>
        document.querySelector(selector)!.getBoundingClientRect().right;
      const line = (selector: string) => {
        const { borderBottomWidth, borderBottomColor } = getComputedStyle(
          document.querySelector(selector)!
        );
        return `${borderBottomWidth} ${borderBottomColor}`;
      };
      return {
        checkBox: right('[data-tree-process] [role="checkbox"]'),
        counts: right('[data-tree-daemon] [data-component="ProcessCounts"]'),
        daemonLine: line('[data-tree-daemon]'),
        processLine: line('[data-tree-process]'),
      };
    });
  const table = await positions();

  await processRow(page, 'app-1').getByText('app-1', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'app-1', exact: true })).toBeVisible();

  // The list is long enough for the side menu to have a scrollbar of its own.
  const scroller = page.locator('[data-tree-scroller]');
  const widths = await scroller.evaluate(element => ({
    outer: (element as HTMLElement).offsetWidth,
    inner: element.clientWidth,
    left: element.getBoundingClientRect().left,
  }));
  expect(widths.outer - widths.inner).toBeGreaterThan(1);

  expect(await positions()).toEqual(table);
  // It lies over the empty margin, not over the check boxes.
  expect(table.checkBox).toBeLessThan(widths.left + widths.inner);
});
