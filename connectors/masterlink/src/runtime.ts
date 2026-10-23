import { loadConfig } from './config.js';
import { IdempotencyStore } from './idempotency.js';
import { HttpMasterLinkApi } from './masterlink/http-client.js';
import { ApiReadRepository } from './masterlink/api-read-repository.js';
import { PostgresReadRepository } from './masterlink/read-repository.js';
import { MutationService } from './mutations.js';
import { AuditLogger } from './security/audit.js';
import { ConnectorService } from './service.js';

export function createReadRepository(
  config: ReturnType<typeof loadConfig>,
  api: HttpMasterLinkApi,
): ApiReadRepository | PostgresReadRepository {
  return config.readBackend === 'api' ? new ApiReadRepository(api) : new PostgresReadRepository(config);
}

export function createRuntime() {
  const config = loadConfig();
  const api = new HttpMasterLinkApi(config);
  const repository = createReadRepository(config, api);
  const audit = new AuditLogger(config.auditPath, config.auditHashKey);
  const idempotency = new IdempotencyStore(config.idempotencyDbPath);
  const reads = new ConnectorService(repository, api, config);
  const mutations = new MutationService(repository, api, config, idempotency);
  return {
    config,
    repository,
    api,
    audit,
    idempotency,
    reads,
    mutations,
    async close() {
      await repository.close();
      idempotency.close();
      audit.close();
    },
  };
}
