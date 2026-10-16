// Appends daemons to a registry from a separate process, as a second Captain would.
// Usage: node --import tsx registry_writer.ts <configDir> <count> <prefix>
import { randomUUID } from 'node:crypto';

import { createDaemonStore } from '../../src/backend/lib/daemon_store';

const [configDir, count, prefix] = process.argv.slice(2);
const log = { warn: () => undefined, debug: () => undefined, info: () => undefined };
const store = createDaemonStore({ settings: { configDir }, log } as never);

async function main() {
  for (let index = 0; index < Number(count); index++) {
    await store.mutate(current => [
      ...(current ?? []),
      { daemonId: randomUUID(), kind: 'local', pm2Home: `/srv/${prefix}-${index}` },
    ]);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
