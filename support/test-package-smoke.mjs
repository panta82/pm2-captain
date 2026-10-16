// Runs the installed npm package from outside the checkout, in fake mode with
// a temporary config directory, and checks that it serves the UI and API behind
// its launch token. Usage: node test-package-smoke.mjs <installed pm2-captain bin> <temp dir>
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import libPath from 'node:path';

const [binary, tempDir] = process.argv.slice(2);
const configHome = libPath.join(tempDir, 'config');

const freePort = () =>
  new Promise(resolve => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const fail = message => {
  throw new Error(message);
};

const port = await freePort();
const baseURL = `http://127.0.0.1:${port}`;
const captain = spawn(binary, ['--fake', 'basic', '--port', String(port), '--no-open'], {
  cwd: tempDir,
  env: { ...process.env, XDG_CONFIG_HOME: configHome, HOME: libPath.join(tempDir, 'home') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
captain.stdout.on('data', chunk => (output += chunk));
captain.stderr.on('data', chunk => (output += chunk));

try {
  let health = null;
  for (let attempt = 0; attempt < 100 && !health; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    health = await fetch(`${baseURL}/health`)
      .then(response => response.json())
      .catch(() => null);
  }
  if (health?.name !== 'pm2-captain' || health.runtime !== 'cli' || health.fake !== true) {
    fail(`The installed Captain did not report healthy: ${JSON.stringify(health)}\n${output}`);
  }

  const list = headers => fetch(`${baseURL}/api/trpc/processes.list`, { headers });
  if ((await list()).status !== 401) {
    fail('The API answered without a session.');
  }
  const token = readFileSync(libPath.join(configHome, 'pm2-captain/launch-token'), 'utf8').trim();
  const launch = await fetch(`${baseURL}/launch?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
  });
  const cookie = launch.headers.get('set-cookie')?.split(';', 1)[0];
  if (launch.status !== 302 || !cookie) {
    fail(`The launch token was not exchanged for a session (${launch.status}).`);
  }
  const page = await fetch(`${baseURL}/`, { headers: { cookie, accept: 'text/html' } });
  if (page.status !== 200 || !(await page.text()).includes('<div id="root">')) {
    fail('The installed package did not serve the frontend.');
  }
  const processes = await list({ cookie, origin: baseURL });
  if (processes.status !== 200 || !(await processes.text()).includes('"api"')) {
    fail('The API did not list the simulated processes.');
  }
  if ((await list({ cookie, origin: 'http://evil.example.com' })).status !== 403) {
    fail('A cross-origin request was accepted.');
  }
  console.log('Installed package served the UI and API behind its launch token.');
} finally {
  const exited = new Promise(resolve => captain.once('exit', resolve));
  captain.kill('SIGTERM');
  await exited;
}
