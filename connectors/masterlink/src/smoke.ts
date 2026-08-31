import { createRuntime } from './runtime.js';

async function main(): Promise<void> {
  const runtime = createRuntime();
  try {
    await runtime.repository.ping();
    await runtime.api.ping();
    process.stdout.write('OK: baza READ ONLY i MasterLink API są dostępne. Nie wykonano zapisu.\n');
  } finally {
    await runtime.close();
  }
}

main().catch(() => {
  process.stderr.write('ERROR: test połączenia nie powiódł się. Sekrety nie zostały wypisane.\n');
  process.exit(1);
});
