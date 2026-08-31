import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((value) => value === 'true');

const envSchema = z.object({
  ML_API_BASE_URL: z.url().transform((value) => value.replace(/\/+$/, '')),
  ML_USERNAME: z.string().min(1),
  ML_PASSWORD: z.string().min(1),
  ML_READ_DATABASE_URL: z.string().min(1),
  ML_DB_SSL: bool.default(true),
  ML_DB_SSL_CA_FILE: z.string().min(1).optional(),
  ML_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  ML_MAX_RESULTS: z.coerce.number().int().min(1).max(100).default(25),
  ML_AUDIT_PATH: z.string().min(1).default('./var/masterlink-audit.jsonl'),
  ML_IDEMPOTENCY_DB_PATH: z.string().min(1).default('./var/idempotency.sqlite'),
  ML_AUDIT_HASH_KEY: z.string().min(32),
  ML_MUTATIONS_ENABLED: bool.default(false),
  ML_REQUIRE_ENV_FILE_MODE_600: bool.default(true),
});

export interface AppConfig {
  apiBaseUrl: string;
  username: string;
  password: string;
  databaseUrl: string;
  databaseSsl: boolean;
  databaseSslCa: string | undefined;
  timeoutMs: number;
  maxResults: number;
  auditPath: string;
  idempotencyDbPath: string;
  auditHashKey: string;
  mutationsEnabled: boolean;
}

function loadConfiguredEnvFile(): void {
  const path = process.env.ML_ENV_FILE;
  if (!path) return;

  const absolute = resolve(path);
  const requireMode600 = process.env.ML_REQUIRE_ENV_FILE_MODE_600 !== 'false';
  const stat = statSync(absolute);
  if (!stat.isFile()) throw new Error('ML_ENV_FILE nie wskazuje zwykłego pliku.');
  if (requireMode600 && (stat.mode & 0o077) !== 0) {
    throw new Error('Plik ML_ENV_FILE musi mieć uprawnienia 600.');
  }
  dotenv.config({ path: absolute, override: false, quiet: true });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) loadConfiguredEnvFile();
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).filter(Boolean);
    throw new Error(`Nieprawidłowa konfiguracja connectora: ${[...new Set(fields)].join(', ')}`);
  }
  const value = parsed.data;
  return {
    apiBaseUrl: value.ML_API_BASE_URL,
    username: value.ML_USERNAME,
    password: value.ML_PASSWORD,
    databaseUrl: value.ML_READ_DATABASE_URL,
    databaseSsl: value.ML_DB_SSL,
    databaseSslCa: value.ML_DB_SSL_CA_FILE
      ? readFileSync(resolve(value.ML_DB_SSL_CA_FILE), 'utf8')
      : undefined,
    timeoutMs: value.ML_TIMEOUT_MS,
    maxResults: value.ML_MAX_RESULTS,
    auditPath: resolve(value.ML_AUDIT_PATH),
    idempotencyDbPath: resolve(value.ML_IDEMPOTENCY_DB_PATH),
    auditHashKey: value.ML_AUDIT_HASH_KEY,
    mutationsEnabled: value.ML_MUTATIONS_ENABLED,
  };
}
