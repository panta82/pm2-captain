import type { Page } from '@playwright/test';

import { FAKE_LAUNCH_PATH, expect, processRow, test } from '../support/fake_fixture';

/** Elements that reach past the right edge of the window, by the component they belong to. */
const elementsPastTheEdge = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('body *'))
      .filter(element => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.right > window.innerWidth + 1;
      })
      .map(
        element =>
          `${element.closest('[data-component]')?.getAttribute('data-component')}: <${element.tagName.toLowerCase()}>`
      )
  );

for (const scenario of ['basic', 'busy', 'edge', 'multi']) {
  test(`fits a phone screen in the "${scenario}" scenario`, async ({ page, fake }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await fake.send({ type: 'world.reset', scenario });
    await page.goto(FAKE_LAUNCH_PATH);
    await expect(page.locator('article').first()).toBeVisible();
    expect(await elementsPastTheEdge(page)).toEqual([]);

    // The last card has the longest names in "edge".
    for (const card of [page.locator('article').first(), page.locator('article').last()]) {
      await card.getByRole('button', { name: /^Open / }).click();
      for (const tab of ['Info', 'Env', 'Logs']) {
        await page.getByRole('link', { name: tab }).click();
        await expect(page.getByRole('button', { name: /^(Restart|Start)$/ })).toBeInViewport();
        expect(await elementsPastTheEdge(page), `${tab} tab`).toEqual([]);
      }
      await page.goto('/');
      await expect(page.locator('article').first()).toBeVisible();
    }
  });
}

test('keeps the action buttons on screen next to a very long process name', async ({
  page,
  fake,
}) => {
  await fake.send({ type: 'world.reset', scenario: 'edge' });
  await page.goto(FAKE_LAUNCH_PATH);
  const row = processRow(page, 'status-online');
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: 'Restart' })).toBeInViewport();
});

test('fits the tree in the menu of a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(FAKE_LAUNCH_PATH);
  await page
    .locator('article')
    .first()
    .getByRole('button', { name: /^Open / })
    .click();
  await page.locator('button:has(svg.lucide-menu)').click();
  await expect(page.getByRole('checkbox', { name: 'Select api' })).toBeInViewport({ ratio: 1 });
});
