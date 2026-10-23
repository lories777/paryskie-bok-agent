import { loadConfig } from './config.js';
import { HttpMasterLinkApi } from './masterlink/http-client.js';
import { createReadRepository } from './runtime.js';

/**
 * Sonda gotowości dla runtime BOK: jeden odczyt przez skonfigurowany backend.
 * `db`: `SELECT 1` na bazie READ ONLY. `api`: logowanie, `GET /api/auth/me`, wylogowanie.
 * Bez audytu i bez zapisów. Kod wyjścia 0 = odczyt działa; 1 = źródło niedostępne.
 * Sekretów nie wypisuje.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const repository = createReadRepository(config, new HttpMasterLinkApi(config));
  try {
    await repository.ping();
    process.stdout.write(`OK: odczyt MasterLink (${config.readBackend}) działa. Nie wykonano zapisu.\n`);
  } finally {
    await repository.close();
  }
}

main().catch(() => {
  process.stderr.write('ERROR: odczyt MasterLink niedostępny. Sekrety nie zostały wypisane.\n');
  process.exit(1);
});
