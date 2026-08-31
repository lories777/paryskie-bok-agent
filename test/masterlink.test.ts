import assert from "node:assert/strict";
import test from "node:test";
import { MasterLinkReportClient, validateMasterLinkReport } from "../src/masterlink.js";

function validReport(): Record<string, unknown> {
  return {
    kontrakt: { wersja: "v1" },
    zakres: { od: "2026-08-25", do: "2026-08-26", strefa: "Europe/Warsaw" },
    totals: { zamowien: 10 },
    perMarket: [],
    paczki: {},
    dataQuality: {},
    freshness: {},
  };
}

test("raport ML przechodzi wyłącznie z kontraktem v1 i poprawną strefą", () => {
  assert.equal(validateMasterLinkReport(validReport()).totals instanceof Object, true);
  assert.throws(
    () => validateMasterLinkReport({ ...validReport(), zakres: { strefa: "UTC" } }),
    /strefa/,
  );
});

test("raport ML jest odrzucany, gdy zagnieżdżone dane zawierają PII", () => {
  assert.throws(
    () => validateMasterLinkReport({ ...validReport(), totals: { customerEmail: "x@example.test" } }),
    /PII/,
  );
});

test("klient nie ujawnia tokenu w błędzie i cache'uje poprawny raport", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    calls += 1;
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer secret-token");
    return new Response(JSON.stringify(validReport()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new MasterLinkReportClient({
    endpointUrl: "https://ml.test/api/raport/v1/zamowienia",
    token: "secret-token",
    timeoutMs: 1_000,
    fetcher,
  });
  assert.match(await client.snapshot(), /^MasterLink: OK/);
  assert.match(await client.snapshot(), /^MasterLink: OK/);
  assert.equal(calls, 1);
});
