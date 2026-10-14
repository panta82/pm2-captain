import { type CDPSession, chromium } from '@playwright/test';
import { promises as fs } from 'node:fs';

import { FAKE_LAUNCH_PATH, test as base, expect, failOnPageError } from '../support/fake_fixture';

/** The trace fields used to select this tab's renderer and count frame outcomes. */
interface ITraceEvent {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  args?: {
    name?: string;
    hasPartialUpdate?: boolean;
    frame_reporter?: { state: string; has_high_latency?: boolean };
  };
}

// Connect to Chrome launched by the isolated desktop's profile launcher.
// Test contexts stay temporary; the persistent desktop/profile stays open.
const test = base.extend({
  browser: async ({}, use) => {
    if (process.env.DISPLAY !== ':199' && process.env.DISPLAY !== ':199.0') {
      throw new Error('Run test:frames through computer-use-linux-isolated desktop run.');
    }
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9339');
    await use(browser);
  },
});
test.skip(!process.env.CAPTAIN_FRAMES, 'Run with npm run test:frames in the isolated desktop.');
// Playwright DOM snapshots themselves walk the retained trees and force layout.
// Only Chrome's Performance recorder should run during these measurements.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

async function startTrace(session: CDPSession) {
  await session.send('Tracing.start', {
    categories:
      'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,disabled-by-default-v8.cpu_profiler,v8.execute,blink.user_timing,cc,benchmark',
    options: 'sampling-frequency=1000',
    transferMode: 'ReturnAsStream',
  });
}

async function stopTrace(session: CDPSession) {
  const completed = new Promise<{ stream?: string }>(resolve =>
    session.once('Tracing.tracingComplete', resolve)
  );
  await session.send('Tracing.end');
  const { stream } = await completed;
  if (!stream) {
    throw new Error('Chrome did not return a trace stream');
  }
  let json = '';
  try {
    while (true) {
      const chunk: { data: string; base64Encoded?: boolean; eof: boolean } = await session.send(
        'IO.read',
        { handle: stream }
      );
      json += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data;
      if (chunk.eof) {
        return json;
      }
    }
  } finally {
    await session.send('IO.close', { handle: stream });
  }
}

for (const processCount of [14, 180]) {
  for (const cpuThrottle of [1, 4]) {
    test(`traces frames with ${processCount} processes at ${cpuThrottle}x CPU`, async ({
      page,
      fake,
    }, testInfo) => {
      test.setTimeout(90_000);
      const expectNoPageError = failOnPageError(page);
      await fake.send({
        type: 'world.reset',
        scenario: {
          daemons: [
            {
              key: 'frames',
              processes: Array.from({ length: processCount }, (_, index) => ({
                name: `frame-process-${index}`,
                script: `/srv/frame-process-${index}.cjs`,
                env: Object.fromEntries(
                  Array.from({ length: 200 }, (_, variable) => [
                    `FRAME_VARIABLE_${variable}`,
                    `process-${index}-value-${variable}`,
                  ])
                ),
                history: index < 3 ? 500 : 0,
                logRate: 0,
                metricJitter: 0.1,
              })),
            },
          ],
        },
      });
      await page.goto(FAKE_LAUNCH_PATH);
      await expect(page.getByRole('row')).toHaveCount(processCount + 1);
      await page
        .getByRole('row')
        .filter({ hasText: 'frame-process-0' })
        .getByText('frame-process-0', { exact: true })
        .click();
      const sidebar = page.getByRole('navigation', { name: 'Processes' });
      // Warm each process/tab before measuring retained rendering.
      for (let processId = 0; processId < 3; processId++) {
        await sidebar
          .getByRole('link', { name: `frame-process-${processId}`, exact: true })
          .click();
        for (const tab of ['Env', 'Logs', 'Info']) {
          await page.getByRole('link', { name: tab, exact: true }).click();
          await expect(page).toHaveURL(new RegExp(`/processes/${processId}/${tab.toLowerCase()}$`));
          if (tab === 'Env') {
            await expect(
              page.getByText(`process-${processId}-value-199`, { exact: true })
            ).toBeAttached();
          } else if (tab === 'Logs') {
            await expect(page.getByTitle('Loaded lines')).not.toHaveText('0');
          } else {
            await expect(
              page.getByText(`/srv/frame-process-${processId}.cjs`, { exact: true })
            ).toBeVisible();
          }
        }
      }
      const session = await page.context().newCDPSession(page);
      const tabPositions = new Map<string, { x: number; y: number }>();
      for (const tab of ['Info', 'Env', 'Logs']) {
        const box = await page.getByRole('link', { name: tab, exact: true }).boundingBox();
        if (!box) {
          throw new Error(`Missing ${tab} tab`);
        }
        tabPositions.set(tab, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      }
      const processPositions: Array<{ x: number; y: number }> = [];
      for (let processId = 0; processId < 3; processId++) {
        const box = await sidebar
          .getByRole('link', { name: `frame-process-${processId}`, exact: true })
          .boundingBox();
        if (!box) {
          throw new Error(`Missing process ${processId}`);
        }
        processPositions.push({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
      }
      await session.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
      await startTrace(session);
      try {
        // Exclude profiler startup and warm the trace machinery before the marker.
        await page.waitForTimeout(600);
        await page.evaluate(() => performance.mark('captain-frames-start'));
        // Includes two-second polls, so an idle Env tab exercises background renders.
        // Native input avoids measuring Playwright's accessibility/text scans
        // over the retained DOM as though they were application rendering.
        const environmentPosition = tabPositions.get('Env')!;
        await page.mouse.click(environmentPosition.x, environmentPosition.y);
        await page.waitForTimeout(4_500);
        await page.evaluate(() => performance.mark('captain-navigation-start'));
        for (let round = 0; round < 3; round++) {
          for (let processId = 0; processId < 3; processId++) {
            const position = processPositions[processId];
            await page.mouse.click(position.x, position.y);
            await expect(page).toHaveURL(new RegExp(`/processes/${processId}/env$`));
            for (const tab of ['Info', 'Logs', 'Env']) {
              const position = tabPositions.get(tab)!;
              await page.mouse.click(position.x, position.y);
              await expect(page).toHaveURL(
                new RegExp(`/processes/${processId}/${tab.toLowerCase()}$`)
              );
              await page.waitForTimeout(100);
            }
          }
        }
        await page.waitForTimeout(250);
        await page.evaluate(() => performance.mark('captain-frames-end'));
      } finally {
        const json = await stopTrace(session);
        const { traceEvents } = JSON.parse(json) as { traceEvents: ITraceEvent[] };
        const marker = (name: string) => {
          const event = traceEvents.find(event => event.name === name);
          if (!event) {
            throw new Error(`Missing trace marker ${name}`);
          }
          return event;
        };
        const startMarker = marker('captain-frames-start');
        const endMarker = marker('captain-frames-end');
        const navigationMarker = marker('captain-navigation-start');
        if (endMarker.pid !== startMarker.pid || navigationMarker.pid !== startMarker.pid) {
          throw new Error('Captain trace markers came from different renderers');
        }
        const started = startMarker.ts;
        const ended = endMarker.ts;
        const navigationStarted = navigationMarker.ts;
        const rendererThread = traceEvents.find(
          event =>
            event.pid === startMarker.pid &&
            event.name === 'thread_name' &&
            event.args?.name === 'CrRendererMain'
        );
        if (!rendererThread) {
          throw new Error('Trace omitted the renderer main thread');
        }
        const events = traceEvents.filter(
          event => event.pid === startMarker.pid && event.ts >= started && event.ts <= ended
        );
        const summarize = (events: ITraceEvent[]) => {
          const tasks = events.filter(
            event =>
              event.tid === rendererThread.tid && event.name === 'RunTask' && event.ph === 'X'
          );
          const frames = events
            .filter(event => event.name === 'PipelineReporter' && event.ph === 'b')
            .map(event => event.args?.frame_reporter)
            .filter(frame => frame && frame.state !== 'STATE_NO_UPDATE_DESIRED');
          const durations = tasks
            .map(task => (task.dur ?? 0) / 1000)
            .sort((left, right) => left - right);
          const droppedFrames = events.filter(event => event.name === 'DroppedFrame');
          return {
            drawnFrames: events.filter(event => event.name === 'DrawFrame').length,
            missedUpdateFrames: frames.filter(frame => frame?.state === 'STATE_DROPPED').length,
            droppedFrames: droppedFrames.length,
            partiallyUpdatedDroppedFrames: droppedFrames.filter(
              event => event.args?.hasPartialUpdate
            ).length,
            lateFrames: frames.filter(frame => frame?.has_high_latency).length,
            tasksOverBudget: durations.filter(duration => duration > 1000 / 60).length,
            longTasks: durations.filter(duration => duration > 50).length,
            maxTaskMs: Math.round(durations.at(-1) ?? 0),
            mainThreadMs: Math.round(durations.reduce((total, duration) => total + duration, 0)),
          };
        };
        const report = {
          display: process.env.DISPLAY,
          processCount,
          cpuThrottle,
          durationMs: Math.round((ended - started) / 1000),
          // This window includes the initial Env activation, followed by polling.
          environmentAndPolling: summarize(events.filter(event => event.ts < navigationStarted)),
          navigation: summarize(events.filter(event => event.ts >= navigationStarted)),
        };
        console.log(JSON.stringify(report));
        const outputDirectory = process.env.CAPTAIN_FRAMES_OUTPUT ?? testInfo.outputDir;
        await fs.mkdir(outputDirectory, { recursive: true });
        const prefix = `${outputDirectory}/${processCount}-processes-${cpuThrottle}x`;
        await fs.writeFile(`${prefix}.trace.json`, json);
        await fs.writeFile(`${prefix}.summary.json`, JSON.stringify(report, null, 2));
        await testInfo.attach('chrome-performance-trace', {
          path: `${prefix}.trace.json`,
          contentType: 'application/json',
        });
        await session.detach();
      }
      expectNoPageError();
    });
  }
}
