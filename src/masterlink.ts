const REQUIRED_SECTIONS = new Set(["totals", "perMarket", "paczki", "dataQuality", "freshness"]);
const FORBIDDEN_KEYS = new Set(
  [
    "address",
    "billing_address",
    "billing_email",
    "billing_phone",
    "customer_email",
    "customer_id",
    "customer_name",
    "email",
    "first_name",
    "ip_address",
    "last_name",
    "order_id",
    "order_number",
    "external_order_id",
    "tracking_number",
    "return_tracking_number",
    "payer_name",
    "pickup_point_name",
    "label_data",
    "notes",
    "raw",
    "phone",
    "shipping_address",
  ].map(normalizeKey),
);

export interface MasterLinkReportClientOptions {
  endpointUrl: string;
  token: string;
  timeoutMs: number;
  fetcher?: typeof fetch;
  cacheTtlMs?: number;
}

export class MasterLinkReportClient {
  private readonly endpointUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;
  private readonly cacheTtlMs: number;
  private cached: { at: number; prompt: string } | null = null;

  constructor(options: MasterLinkReportClientOptions) {
    this.endpointUrl = options.endpointUrl;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
    this.fetcher = options.fetcher ?? fetch;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
  }

  async snapshot(): Promise<string> {
    if (this.cached && Date.now() - this.cached.at < this.cacheTtlMs) return this.cached.prompt;
    try {
      const response = await this.fetcher(this.endpointUrl, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          "user-agent": "Paryskie-BOK-Agent/0.1",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const report = validateMasterLinkReport(await response.json());
      const prompt = formatReport(report);
      this.cached = { at: Date.now(), prompt };
      return prompt;
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).replaceAll(
        this.token,
        "[REDACTED]",
      );
      return `MasterLink: ERROR — ${detail.slice(0, 500)}`;
    }
  }
}

export function validateMasterLinkReport(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Raport MasterLink nie jest obiektem JSON");
  }
  const report = value as Record<string, unknown>;
  const contract = report.kontrakt;
  const version =
    contract && typeof contract === "object" && !Array.isArray(contract)
      ? String((contract as Record<string, unknown>).wersja ?? (contract as Record<string, unknown>).version ?? "")
      : String(contract ?? "");
  if (!version.toLowerCase().includes("v1")) throw new Error("Brak kontraktu raportu v1");

  const scope = report.zakres;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new Error("Brak zakresu raportu MasterLink");
  }
  const scopeRecord = scope as Record<string, unknown>;
  const timezone = scopeRecord.strefa ?? scopeRecord.strefa_czasowa ?? scopeRecord.timezone;
  if (timezone !== "Europe/Warsaw") {
    throw new Error(`Nieprawidłowa strefa raportu MasterLink: ${String(timezone)}`);
  }

  const missing = [...REQUIRED_SECTIONS].filter((key) => !(key in report));
  if (missing.length > 0) throw new Error(`Brak sekcji raportu: ${missing.join(", ")}`);

  const forbidden = findForbiddenKeys(report);
  if (forbidden.size > 0) {
    throw new Error(`Raport zawiera niedozwolone pola PII: ${[...forbidden].sort().join(", ")}`);
  }
  return report;
}

function formatReport(report: Record<string, unknown>): string {
  const json = JSON.stringify(report);
  const limited = json.length > 30_000 ? `${json.slice(0, 30_000)}…[limit]` : json;
  return `MasterLink: OK — raport zbiorczy PII-free\n${limited}`;
}

function findForbiddenKeys(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) findForbiddenKeys(item, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(normalizeKey(key))) found.add(key);
    findForbiddenKeys(nested, found);
  }
  return found;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}
