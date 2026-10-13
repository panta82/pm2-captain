import type { IFakeCommandInput } from '../../src/backend/fake/fake_commands';
import { createRandom } from '../../src/backend/fake/fake_logs';
import { FAKE_LAUNCH_PATH, expect, failOnPageError, test } from '../support/fake_fixture';

const STATUSES = [
  'online',
  'stopping',
  'stopped',
  'launching',
  'errored',
  'one-launch-status',
  'unknown',
] as const;

/** A reproducible series of changes to the "basic" scenario's daemon. It ends with the daemon up. */
function churn(seed: number, steps: number): IFakeCommandInput[] {
  const random = createRandom(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  const names = ['api', 'worker', 'scheduler', 'mailer'];
  const commands: IFakeCommandInput[] = [];
  for (let step = 0; step < steps; step++) {
    const roll = random();
    if (roll < 0.15 && names.length < 14) {
      const name = `churn-${step}`;
      names.push(name);
      commands.push({
        type: 'process.add',
        daemon: 'local',
        process: name,
        namespace: pick(['default', 'jobs', 'web']),
        status: pick(STATUSES),
        mode: pick(['fork', 'cluster']),
      });
    } else if (roll < 0.25 && names.length > 1) {
      const [name] = names.splice(Math.floor(random() * names.length), 1);
      commands.push({ type: 'process.remove', daemon: 'local', process: name });
    } else if (roll < 0.32) {
      commands.push({ type: 'daemon.set', daemon: 'local', isUp: random() < 0.5 });
    } else {
      commands.push({
        type: 'process.set',
        daemon: 'local',
        process: pick(names),
        status: pick(STATUSES),
        cpu: Math.round(random() * 1_000) / 10,
        restarts: Math.floor(random() * 5_000),
        version: pick(['1.0.0', '2.3.4-beta.1', null]),
      });
    }
  }
  commands.push({ type: 'daemon.set', daemon: 'local', isUp: true });
  return commands;
}

for (const seed of [1, 2, 3]) {
  test(`the status table ends up matching the world after random changes (seed ${seed})`, async ({
    page,
    fake,
  }) => {
    const expectNoPageError = failOnPageError(page);
    await page.goto(FAKE_LAUNCH_PATH);
    await expect(page.locator('tbody tr')).toHaveCount(4);

    // The changes arrive in bursts while the page keeps polling and re-sorting.
    const commands = churn(seed, 90);
    const sortable = ['ID', 'NAME', 'CPU', 'PID'];
    for (let start = 0; start < commands.length; start += 6) {
      await fake.send(...commands.slice(start, start + 6));
      await page
        .getByRole('button', { name: sortable[(start / 6) % sortable.length], exact: true })
        .click();
      await page.waitForTimeout(120);
    }

    const [daemon] = (await fake.state()).daemons;
    const expected = daemon.processes
      .map(process => ({
        id: String(process.pmId),
        name: process.name,
        namespace: process.namespace,
        mode: process.mode,
        restarts: String(process.restarts),
        cpu: `${(process.status === 'online' ? process.cpu : 0).toFixed(1)}%`,
        pid: process.pid === null ? '—' : String(process.pid),
        version: process.version ?? '—',
        action: process.status === 'online' ? 'Restart' : 'Start',
        isActionEnabled: true,
      }))
      .sort((left, right) => Number(left.id) - Number(right.id));

    const readTable = async () =>
      (
        await page.locator('tbody tr').evaluateAll(rows =>
          rows.map(row => {
            const cells = Array.from((row as HTMLTableRowElement).cells);
            const text = (index: number) => cells[index]?.innerText.trim() ?? '';
            const primary = cells[10]?.querySelector('button');
            return {
              id: text(0),
              name: text(1),
              namespace: text(2),
              mode: text(3),
              restarts: text(4),
              cpu: text(5),
              pid: text(8),
              version: text(9),
              action: primary?.textContent?.trim() ?? '',
              isActionEnabled: primary ? !primary.disabled : false,
            };
          })
        )
      ).sort((left, right) => Number(left.id) - Number(right.id));

    await expect.poll(readTable, { timeout: 10_000 }).toEqual(expected);
    expectNoPageError();
  });
}
