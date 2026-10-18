import {
  FAKE_LAUNCH_PATH,
  expect,
  failOnPageError,
  processRow,
  test,
} from '../support/fake_fixture';

test('shows a downloaded update, a failed installation, and nothing after a reset', async ({
  page,
  fake,
}) => {
  const expectNoPageError = failOnPageError(page);
  await page.goto(FAKE_LAUNCH_PATH);
  await expect(processRow(page, 'api')).toBeVisible();
  const updateToast = page.locator('[data-component="UpdateToast"]');
  await expect(updateToast).toHaveCount(0);

  await fake.send({ type: 'update.set', status: 'downloaded', version: '9.9.9' });
  await expect(updateToast).toContainText('PM2 Captain 9.9.9 is ready to install.');

  // The simulated installation fails unless told otherwise; nothing is installed.
  await updateToast.getByRole('button', { name: 'Restart to update' }).click();
  await expect(updateToast).toContainText('The simulated installation failed.');
  expect((await fake.state()).update).toMatchObject({
    status: 'downloaded',
    error: { phase: 'install' },
  });

  await fake.send({ type: 'update.install-outcome', outcome: 'stay' });
  await updateToast.getByRole('button', { name: 'Restart to update' }).click();
  await expect(updateToast.getByRole('button', { name: 'Restart to update' })).toBeDisabled();

  await fake.send({ type: 'update.reset' });
  await expect(updateToast).toHaveCount(0);
  expectNoPageError();
});

test('says that a package installation asks for the password', async ({ page, fake }) => {
  await page.goto(FAKE_LAUNCH_PATH);
  await fake.send({
    type: 'update.set',
    status: 'downloaded',
    version: '9.9.9',
    installKind: 'deb',
  });

  await expect(
    page.getByRole('button', { name: 'Install update (asks for your password)' })
  ).toBeVisible();
});

test('keeps one persistent update toast and remembers skipped versions across reloads', async ({
  page,
  fake,
}) => {
  await page.clock.install();
  await fake.send({ type: 'update.set', status: 'downloaded', version: '9.9.9' });
  await page.goto(FAKE_LAUNCH_PATH);
  const updateToast = page.locator('[data-component="UpdateToast"]');
  await expect(updateToast).toBeVisible();

  // Past the ordinary toast timeout, with route changes too.
  await page.clock.fastForward(10_000);
  await processRow(page, 'api').getByText('api', { exact: true }).click();
  await page.getByRole('link', { name: 'Env' }).click();
  await expect(updateToast).toHaveCount(1);
  await expect(updateToast).toBeVisible();

  await updateToast.getByRole('button', { name: 'Skip this version' }).click();
  await expect.poll(async () => (await fake.state()).update.skippedVersion).toBe('9.9.9');
  await expect(updateToast).toHaveCount(0);
  await page.clock.fastForward(10_000);
  await expect(updateToast).toHaveCount(0);

  // Repeated state updates and a page reload keep the skipped version hidden.
  await fake.send({
    type: 'update.set',
    status: 'downloaded',
    version: '9.9.9',
    errorPhase: 'install',
    errorMessage: 'Try installing again.',
  });
  await page.reload();
  await expect(page.getByRole('link', { name: 'Env' })).toBeVisible();
  await expect(updateToast).toHaveCount(0);

  await fake.send({ type: 'update.set', status: 'downloaded', version: '9.9.10' });
  await expect(updateToast).toContainText('PM2 Captain 9.9.10 is ready to install.');
  await expect(updateToast).toHaveCount(1);
  await updateToast.getByRole('button', { name: 'Skip this version' }).click();
  await expect.poll(async () => (await fake.state()).update.skippedVersion).toBe('9.9.10');
  await expect(updateToast).toHaveCount(0);
});
