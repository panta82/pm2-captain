import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readDevLaunch } from '../dev_options.mjs';

const launch = await readDevLaunch('web');
const child = spawn(
  process.execPath,
  [
    fileURLToPath(import.meta.resolve('tsx/cli')),
    'watch',
    ...launch.debugArgs,
    'src/backend/app.ts',
    ...launch.args,
  ],
  { cwd: fileURLToPath(new URL('../..', import.meta.url)), stdio: 'inherit', env: launch.env }
);

// Forward shutdown to the watcher so it also releases the backend and Vite.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', error => {
  console.error(`Could not start the web development server: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
});
