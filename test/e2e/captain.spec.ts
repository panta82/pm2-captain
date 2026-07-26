import { expect, test } from '@playwright/test';

const launchPath = '/launch?token=pm2-captain-e2e-token';

test('requires a launch session for APIs', async ({ request }) => {
  const response = await request.get('/api/trpc/processes.list?batch=1&input=%7B%7D');
  expect(response.status()).toBe(401);
});

test('navigates status, info, and streaming logs', async ({ page }) => {
  await page.goto(launchPath);
  await expect(page.getByText('captain-fixture', { exact: true }).first()).toBeVisible();

  await page.getByText('captain-fixture', { exact: true }).first().click();
  await expect(page).toHaveURL(/\/processes\/0\/info$/);
  await expect(page.getByRole('heading', { name: 'CONFIGURATION' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'EXECUTION' })).toBeVisible();
  const processHeading = page.getByRole('heading', {
    name: 'captain-fixture',
    exact: true,
  });
  const processHeadingBox = await processHeading.boundingBox();
  expect(processHeadingBox?.y).toBeLessThan(60);
  await expect(page.getByRole('navigation', { name: 'Processes' })).not.toContainText('%');
  await expect(page.getByText('Environment values are never shown')).toBeVisible();

  await page.getByRole('link', { name: 'Logs' }).click();
  await expect(page.getByText('fixture output').first()).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: /Resume [1-9]/ })).toBeVisible({
    timeout: 5_000,
  });
  await page.getByRole('button', { name: /Resume/ }).click();

  await page.getByPlaceholder('search loaded logs…').fill('fixture error');
  await expect(page.getByText('fixture error').first()).toBeVisible();
  await page.getByRole('button', { name: 'Regular expression' }).click();
  await page.getByPlaceholder('search loaded logs…').fill('fixture error \\d+');
  await expect(page.getByText('fixture error').first()).toBeVisible();
  await page.getByRole('button', { name: 'err', exact: true }).click();
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
  await expect(page).toHaveURL(/\/processes\/0\/info$/);
  await expect(page.getByRole('button', { name: 'Restart' })).toBeVisible();
});

test('redirects a stale process route back to status', async ({ page }) => {
  await page.goto(launchPath);
  await page.goto('/processes/99999/info');
  await expect(page).toHaveURL('http://127.0.0.1:3214/');
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
