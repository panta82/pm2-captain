import type { CDPSession, Page } from '@playwright/test';
import { promises as fs } from 'node:fs';

import { FAKE_LAUNCH_PATH, expect, failOnPageError, test } from '../support/fake_fixture';

/** A browser-measured click through the detail view, including the first painted frame. */
interface INavigationSample {
  phase: 'cold' | 'warm';
  target: string;
  paintedMs: number;
  scriptMs: number;
  layoutMs: number;
  detailRequests: number;
  historyRequests: number;
}

const STEPS = ['process', 'env', 'logs', 'info', 'env', 'logs', 'info'] as const;
const PROCESS_NAMES = ['perf-api', 'perf-worker', 'perf-queue'];

async function metrics(session: CDPSession) {
  const result: { metrics: Array<{ name: string; value: number }> } =
    await session.send('Performance.getMetrics');
  return new Map(result.metrics.map(metric => [metric.name, metric.value]));
}

async function measureNavigation(
  page: Page,
  href: string,
  marker: string,
  expectedContent: string
) {
  return page.evaluate(
    async ({ href, marker, expectedContent }) => {
      const link = document.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
      if (!link) {
        throw new Error(`Missing navigation link: ${href}`);
      }
      const started = performance.now();
      link.click();
      await new Promise<void>((resolve, reject) => {
        const isReady = () => {
          const component = document.querySelector<HTMLElement>(`[data-component="${marker}"]`);
          return Boolean(
            location.pathname === href &&
            component &&
            component.getClientRects().length > 0 &&
            component.textContent?.includes(expectedContent) &&
            (marker !== 'LogsPage' ||
              (Number(component.querySelector('[title="Loaded lines"]')?.textContent) > 0 &&
                Array.from(component.querySelectorAll('[data-component="LogRow"]')).some(row =>
                  row.textContent?.includes(expectedContent)
                )))
          );
        };
        const check = () => {
          if (isReady()) {
            // A second animation frame includes the paint following React's DOM commit.
            requestAnimationFrame(() => (isReady() ? resolve() : check()));
          } else if (performance.now() - started > 10_000) {
            reject(new Error(`Navigation did not render: ${href}`));
          } else {
            requestAnimationFrame(check);
          }
        };
        requestAnimationFrame(check);
      });
      return performance.now() - started;
    },
    { href, marker, expectedContent }
  );
}

for (const latencyMs of [0, 150]) {
  test(`measures detail navigation with ${latencyMs} ms daemon latency`, async ({
    page,
    fake,
  }, testInfo) => {
    test.skip(!process.env.CAPTAIN_PERFORMANCE, 'Run with npm run test:performance.');
    test.setTimeout(120_000);
    const expectNoPageError = failOnPageError(page);
    await fake.send({
      type: 'world.reset',
      scenario: {
        daemons: [
          {
            key: 'performance',
            latencyMs,
            processes: Array.from({ length: 52 }, (_, index) => ({
              name: PROCESS_NAMES[index] ?? `other-${index}`,
              script: `/srv/${PROCESS_NAMES[index] ?? `other-${index}`}.cjs`,
              env: Object.fromEntries(
                Array.from({ length: 200 }, (_, variable) => [
                  `PERF_VARIABLE_${String(variable).padStart(3, '0')}`,
                  `fixture-${index}-${variable}`,
                ])
              ),
              history: index < 3 ? 500 : 0,
              logRate: 0,
              metricJitter: 0,
            })),
          },
        ],
      },
    });
    // Fixed timestamps and process-specific markers let readiness distinguish
    // the destination's populated content from the previous process's DOM.
    for (const name of PROCESS_NAMES) {
      for (const channel of ['out', 'err'] as const) {
        await fake.send({
          type: 'log.history',
          daemon: 'performance',
          process: name,
          channel,
          lines: Array.from(
            { length: 250 },
            (_, index) =>
              `${new Date(Date.UTC(2026, 9, 14, 12, 0, index)).toISOString()} PERF_LOG_${name} ${channel}-${index}`
          ),
        });
      }
    }
    const [{ daemonId }] = (await fake.state()).daemons;
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await session.send('Performance.enable');
    let detailRequests = 0;
    let historyRequests = 0;
    page.on('request', request => {
      if (request.url().includes('processes.detail')) {
        detailRequests++;
      }
      if (request.url().includes('logs.page')) {
        historyRequests++;
      }
    });
    await page.goto(FAKE_LAUNCH_PATH);
    await expect(page.getByRole('row')).toHaveCount(53);
    const samples: INavigationSample[] = [];
    for (let round = 0; round < 4; round++) {
      for (const [pmId, name] of PROCESS_NAMES.entries()) {
        for (const [stepIndex, step] of STEPS.entries()) {
          if (round === 0 && pmId === 0 && step === 'process') {
            await page.getByRole('row').filter({ hasText: name }).getByText(name).click();
            await expect(page.locator('[data-component="InfoPage"]')).toBeVisible();
            continue;
          }
          // A realistic reading pause also exercises the previous 500 ms cache expiry.
          await page.waitForTimeout(600);
          const before = await metrics(session);
          const previousDetailRequests = detailRequests;
          const previousHistoryRequests = historyRequests;
          // A sidebar process link retains the current tab. First select the
          // process, then measure the remaining tab clicks for that process.
          const href =
            step === 'process'
              ? await page
                  .getByRole('navigation', { name: 'Processes' })
                  .getByRole('link', { name, exact: true })
                  .getAttribute('href')
              : `/daemons/${daemonId}/processes/${pmId}/${step}`;
          expect(href).toBeTruthy();
          if (!href) {
            throw new Error('The process link has no URL.');
          }
          const activeTab = href.split('/').at(-1);
          const paintedMs = await measureNavigation(
            page,
            href,
            activeTab === 'info' ? 'InfoPage' : activeTab === 'env' ? 'EnvPanel' : 'LogsPage',
            activeTab === 'info'
              ? `/srv/${name}.cjs`
              : activeTab === 'env'
                ? `fixture-${pmId}-199`
                : `PERF_LOG_${name}`
          );
          const after = await metrics(session);
          const elapsed = (metric: string) =>
            ((after.get(metric) ?? 0) - (before.get(metric) ?? 0)) * 1_000;
          samples.push({
            phase: round === 0 ? 'cold' : 'warm',
            target: `${step === 'process' ? 'process' : stepIndex > 3 ? 'revisit' : 'tab'}:${activeTab}`,
            paintedMs,
            scriptMs: elapsed('ScriptDuration'),
            layoutMs: elapsed('LayoutDuration') + elapsed('RecalcStyleDuration'),
            detailRequests: detailRequests - previousDetailRequests,
            historyRequests: historyRequests - previousHistoryRequests,
          });
        }
      }
    }
    const report = { latencyMs, cpuThrottle: 4, processes: 52, variables: 200, samples };
    const json = JSON.stringify(report, null, 2);
    await testInfo.attach(`navigation-${latencyMs}ms.json`, {
      body: json,
      contentType: 'application/json',
    });
    if (process.env.CAPTAIN_PERFORMANCE_OUTPUT) {
      await fs.mkdir(process.env.CAPTAIN_PERFORMANCE_OUTPUT, { recursive: true });
      await fs.writeFile(`${process.env.CAPTAIN_PERFORMANCE_OUTPUT}/${latencyMs}ms.json`, json);
    }
    for (const target of [...new Set(samples.map(sample => sample.target))]) {
      const warm = samples.filter(sample => sample.phase === 'warm' && sample.target === target);
      const median = (key: 'paintedMs' | 'scriptMs' | 'layoutMs') => {
        const values = warm.map(sample => sample[key]).sort((left, right) => left - right);
        return Math.round(values[Math.floor(values.length / 2)]);
      };
      console.log(
        JSON.stringify({
          latencyMs,
          target,
          samples: warm.length,
          paintedMs: median('paintedMs'),
          scriptMs: median('scriptMs'),
          layoutMs: median('layoutMs'),
          detailRequests: warm.reduce((total, sample) => total + sample.detailRequests, 0),
          historyRequests: warm.reduce((total, sample) => total + sample.historyRequests, 0),
        })
      );
    }
    expectNoPageError();
    await session.detach();
  });
}
