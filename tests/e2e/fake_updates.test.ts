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
  const banner = page.locator('[data-component="UpdateBanner"]');
  await expect(banner).toHaveCount(0);

  await fake.send({ type: 'update.set', status: 'downloaded', version: '9.9.9' });
  await expect(banner).toContainText('PM2 Captain 9.9.9 is ready to install.');

  // The simulated installation fails unless told otherwise; nothing is installed.
  await banner.getByRole('button', { name: 'Restart to update' }).click();
  await expect(banner).toContainText('The simulated installation failed.');
  expect((await fake.state()).update).toMatchObject({
    status: 'downloaded',
    error: { phase: 'install' },
  });

  await fake.send({ type: 'update.install-outcome', outcome: 'stay' });
  await banner.getByRole('button', { name: 'Restart to update' }).click();
  await expect(banner.getByRole('button', { name: 'Restart to update' })).toBeDisabled();

  await fake.send({ type: 'update.reset' });
  await expect(banner).toHaveCount(0);
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
