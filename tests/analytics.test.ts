import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAnalyticsAudit } from "../src/analytics";
import { normalizeAudit } from "../src/audit";

const KEY = "kh_testkeytestkeytestkey";
process.env.KEEPERHUB_API_KEY = KEY;

const EXECUTION_ID = "no623hdfsrun2vzv3b25r";

/** Réponses simulées, indexées par fragment d'URL. */
function stubFetch(routes: Array<{ match: RegExp; status: number; body: unknown }>) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    seen.push(String(url));
    // La clé doit voyager en Bearer, jamais en clair dans l'URL.
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    expect(auth).toBe(`Bearer ${KEY}`);
    expect(String(url)).not.toContain(KEY);
    const route = routes.find((r) => r.match.test(String(url)));
    if (!route) throw new Error(`route non simulée : ${url}`);
    return {
      status: route.status,
      json: async () => route.body,
    } as unknown as Response;
  });
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("Analytics — run présent", () => {
  it("retrouve le run et conserve ses métadonnées", async () => {
    stubFetch([
      {
        match: /\/api\/analytics\/runs\?/,
        status: 200,
        body: { runs: [{ executionId: EXECUTION_ID, status: "completed", source: "direct" }] },
      },
      { match: /\/steps$/, status: 200, body: { data: [{ step: "submit" }] } },
    ]);

    const audit = await fetchAnalyticsAudit(EXECUTION_ID);
    expect(audit.run.found).toBe(true);
    expect(audit.run.metadata?.status).toBe("completed");
    expect(audit.run.probe.httpStatus).toBe(200);
    expect(audit.run.pagesScanned).toBe(1);
  });
});

describe("Analytics — run absent", () => {
  it("parcourt les pages puis signale l'absence sans la transformer en succès", async () => {
    stubFetch([
      { match: /\/api\/analytics\/runs\?/, status: 200, body: { runs: [] } },
      { match: /\/steps$/, status: 200, body: { data: [] } },
    ]);

    const audit = await fetchAnalyticsAudit(EXECUTION_ID);
    expect(audit.run.found).toBe(false);
    expect(audit.run.probe.available).toBe(true); // l'endpoint répond
    expect(audit.run.probe.note).toContain("absent");
  });

  it("s'arrête à maxPages sur une pagination pleine", async () => {
    const page = { runs: Array.from({ length: 50 }, (_, i) => ({ executionId: `other-${i}` })) };
    stubFetch([
      { match: /\/api\/analytics\/runs\?/, status: 200, body: page },
      { match: /\/steps$/, status: 200, body: { data: [] } },
    ]);

    const audit = await fetchAnalyticsAudit(EXECUTION_ID, { maxPages: 3, pageSize: 50 });
    expect(audit.run.found).toBe(false);
    expect(audit.run.pagesScanned).toBe(3);
  });
});

describe("Analytics — step logs", () => {
  it("compte les étapes présentes", async () => {
    stubFetch([
      { match: /\/api\/analytics\/runs\?/, status: 200, body: { runs: [] } },
      { match: /\/steps$/, status: 200, body: [{ step: "simulate" }, { step: "submit" }] },
    ]);
    const audit = await fetchAnalyticsAudit(EXECUTION_ID);
    expect(audit.steps.available).toBe(true);
    expect(audit.steps.count).toBe(2);
  });

  it("distingue « disponible mais vide » de « indisponible »", async () => {
    stubFetch([
      { match: /\/api\/analytics\/runs\?/, status: 200, body: { runs: [] } },
      { match: /\/steps$/, status: 200, body: { data: [] } },
    ]);
    const empty = await fetchAnalyticsAudit(EXECUTION_ID);
    expect(empty.steps.available).toBe(true);
    expect(empty.steps.count).toBe(0);
    expect(empty.steps.probe.note).toContain("aucune étape");

    vi.unstubAllGlobals();
    stubFetch([
      { match: /\/api\/analytics\/runs\?/, status: 401, body: { error: "Authentication required" } },
      { match: /\/steps$/, status: 403, body: { error: "Organization not found" } },
    ]);
    const denied = await fetchAnalyticsAudit(EXECUTION_ID);
    expect(denied.steps.available).toBe(false);
    expect(denied.steps.count).toBeNull();
    expect(denied.steps.probe.httpStatus).toBe(403);
  });

  it("une indisponibilité réseau reste une indisponibilité", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNRESET");
    });
    const audit = await fetchAnalyticsAudit(EXECUTION_ID);
    expect(audit.run.probe.available).toBe(false);
    expect(audit.steps.available).toBe(false);
    expect(audit.run.probe.note).toContain("Injoignable");
  });
});

describe("Analytics dans les sources d'audit", () => {
  it("apparaît comme couverture, jamais comme validation", async () => {
    stubFetch([
      { match: /\/api\/analytics\/runs\?/, status: 401, body: { error: "Authentication required" } },
      { match: /\/steps$/, status: 403, body: { error: "Organization not found" } },
    ]);
    const analytics = await fetchAnalyticsAudit(EXECUTION_ID);
    const audit = normalizeAudit({ directStatus: null, analytics });

    const surfaces = audit.sources.map((s) => s.surface);
    expect(surfaces.some((s) => s.includes("analytics/runs"))).toBe(true);
    expect(surfaces.some((s) => s.includes("steps"))).toBe(true);
    expect(audit.sources.filter((s) => s.surface.startsWith("rest:")).every((s) => !s.available)).toBe(
      true,
    );
    // Aucune donnée de vérité ne provient d'Analytics.
    expect(audit.transactionHash).toBeNull();
  });
});

describe("sortie CLI", () => {
  it("la charge est du JSON parseable et ne contient aucune clé", async () => {
    stubFetch([
      { match: /\/api\/analytics\/runs\?/, status: 401, body: { error: "Authentication required" } },
      { match: /\/steps$/, status: 403, body: { error: "Organization not found" } },
    ]);
    const analytics = await fetchAnalyticsAudit(EXECUTION_ID);
    const payload = {
      executionId: EXECUTION_ID,
      keeperHubAudit: normalizeAudit({ directStatus: null, analytics }),
      analytics,
    };

    const serialized = JSON.stringify(payload, null, 2);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toMatch(/kh_[A-Za-z0-9]{10}/);
  });
});
