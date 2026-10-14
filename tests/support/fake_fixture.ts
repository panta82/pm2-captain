import { type Page, test as base, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';

import type { IFakeCommandInput } from '../../src/backend/fake/fake_commands';
import type { IFakeWorld } from '../../src/backend/fake/fake_world';

export const FAKE_TOKEN = 'pm2-captain-e2e-token';
export const FAKE_LAUNCH_PATH = `/launch?token=${FAKE_TOKEN}`;
/** Where tests/support/start-fake-e2e-server.sh keeps the launch token. */
export const FAKE_XDG_CONFIG_HOME = '/tmp/pm2-captain-e2e-fake-xdg';

/** Sets up situations in the fake world of the Captain under test. */
export interface IFakeControl {
  send(...commands: IFakeCommandInput[]): Promise<void>;
  state(): Promise<ReturnType<IFakeWorld['state']>>;
}

export const test = base.extend<{ fake: IFakeControl }>({
  fake: [
    async ({ request }, use) => {
      const headers = { authorization: `Bearer ${FAKE_TOKEN}` };
      const send = async (...commands: IFakeCommandInput[]) => {
        const response = await request.post('/api/fake/commands', { data: commands, headers });
        expect(response.ok(), await response.text()).toBe(true);
      };
      // Every test starts from the scenario the server was started with.
      await send({ type: 'world.reset' });
      await use({
        send,
        state: async () => (await request.get('/api/fake/state', { headers })).json(),
      });
    },
    { auto: true },
  ],
});

export { expect };

/** The status table row of a process. Only for names that are unique on the page. */
export const processRow = (page: Page, name: string) =>
  page.getByRole('row').filter({ has: page.getByText(name, { exact: true }) });

/**
 * Goes from the status page to a tab of a process. For the logs it waits until
 * the history has loaded and the live stream is open: a line that is printed
 * before that would be missed, or counted as history.
 */
export async function openProcessTab(page: Page, name: string, tab: 'Info' | 'Env' | 'Logs') {
  await processRow(page, name).getByText(name, { exact: true }).click();
  const logsReady =
    tab === 'Logs'
      ? Promise.all(
          ['logs.page', 'logs.stream'].map(procedure =>
            page.waitForResponse(response => response.url().includes(procedure))
          )
        )
      : null;
  await page.getByRole('link', { name: tab }).click();
  await logsReady;
}

/** The text of every loaded log line, oldest first. */
export const logLines = (page: Page) =>
  page
    .locator('[data-component="LogRow"]')
    .evaluateAll(rows => rows.map(row => row.lastElementChild?.textContent ?? ''));

/** Reads all loaded lines through the export, including rows outside the virtual viewport. */
export async function downloadLogLines(page: Page) {
  const downloadStarted = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download filtered logs' }).click();
  const download = await downloadStarted;
  const content = await fs.readFile(await download.path(), 'utf8');
  return content
    .split('\n')
    .slice(0, -1)
    .map(line => line.replace(/^.*?\[(?:OUT|ERR|SHARED)\] /, ''));
}

/** Fails the test on an uncaught error in the page, which no assertion on the DOM would notice. */
export function failOnPageError(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  return () => expect(errors).toEqual([]);
}
