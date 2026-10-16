// Starts a desktop-mode backend in fake mode and prints how to reach it, for
// tests that need a real container. Stops when stdin closes.
// Usage: node --import tsx desktop_runtime_server.ts <configDir>
import { createDesktopBackendSettings } from '../../src/backend/backend_settings';
import { createAppContainer } from '../../src/backend/container';

async function main() {
  const container = createAppContainer(
    createDesktopBackendSettings({
      configDir: process.argv[2],
      environmentPm2Home: null,
      fakeScenario: 'basic',
      fakeControlFile: null,
      debug: false,
      serverDevMode: false,
    })
  );
  await container.app.start();
  process.stdout.write(
    `${JSON.stringify({
      baseURL: container.webServer.baseURL,
      token: await container.sessionAuth.ensureToken(),
      identifiers: container.identifiers,
    })}\n`
  );
  process.stdin.resume();
  process.stdin.on('end', () => void container.app.kill(0));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
