import { loadConfig } from './config.js';
import { PostgresReadRepository } from './masterlink/read-repository.js';

/**
 * Sonda gotowości dla runtime BOK: wyłącznie `SELECT 1` na bazie READ ONLY.
 * Bez logowania do API MasterLink (sonda chodzi co minutę) i bez audytu.
 * Kod wyjścia 0 = odczyt działa; 1 = źródło niedostępne. Sekretów nie wypisuje.
 */
async function main(): Promise<void> {
  const repository = new PostgresReadRepository(loadConfig());
  try {
    await repository.ping();
    process.stdout.write('OK: odczyt bazy MasterLink działa. Nie wykonano zapisu.\n');
  } finally {
    await repository.close();
  }
}

main().catch(() => {
  process.stderr.write('ERROR: odczyt bazy MasterLink niedostępny. Sekrety nie zostały wypisane.\n');
  process.exit(1);
});
