import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAnalyticsAudit } from "../src/analytics";
import { normalizeAudit } from "../src/audit";

const KEY = "kh_testkeytestkeytestkey";
process.env.KEEPERHUB_API_KEY = KEY;

const EXECUTION_ID = "no623hdfsrun2vzv3b25r";

type Route = { match: RegExp; status: number; body: unknown; headers?: Record<string, string> };

/**
 * Simule `fetch` et enregistre les URL appelées, pour vérifier la mécanique de
 * curseur. Assure au passage que la clé voyage en Bearer et jamais dans l'URL.
 */
function stubFetch(routes: Route[]): string[] {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    seen.push(String(url));
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    expect(auth).toBe(`Bearer ${KEY}`);
    expect(String(url)).not.toContain(KEY);

    const route = routes.find((r) => r.match.test(String(url)));
    if (!route) throw new Error(`route non simulée : ${url}`);
    return {
      status: route.status,
      headers: new Headers(route.headers ?? {}),
      json: async () => route.body,
    } as unknown as Response;
  });
  return seen;
}

const NO_STEPS: Route = { match: /\/steps$/, status: 200, body: { data: [] } };

afterEach(() => vi.unstubAllGlobals());

describe("pagination par curseur", () => {
  it("premier appel sans cursor, second avec le nextCursor reçu", async () => {
    const seen = stubFetch([
      {
        match: /\/api\/analytics\/runs\?(?!.*cursor=)/,
        status: 200,
        body: { runs: [{ executionId: "other-1" }], nextCursor: "cur-2" },
      },
      {
        match: /cursor=cur-2/,
        status: 200,
        body: { runs: [{ executionId: EXECUTION_ID, status: "completed" }] },
      },
      NO_STEPS,
    ]);

    const audit = await fetchAnalyticsAudit(EXECUTION_ID);
    const listCalls = seen.filter((u) => u.includes("/runs?"));

    expect(listCalls[0]).not.toContain("cursor=");
    expect(listCalls[1]).toContain("cursor=cur-2");
    expect(listCalls.some((u) => u.includes("page="))).toBe(false);
    expect(audit.run.found).toBe(true);
    expect(audit.run.pagesScanned).toBe(2);
  });

  it("run trouvé en deuxième page : conserve ses métadonnées", async () => {
    stubFetch([
      {
        match: /\/api\/analytics\/runs\?(?!.*cursor=)/,
        status: 200,
        body: { runs: [{ executionId: "other" }], nextCursor: "c2" },
      },
      {
        match: /cursor=c2/,
        status: 200,
        body: { runs: [{ executionId: EXECUTION_ID, status: "completed", source: "direct" }] },
      },
      NO_STEPS,
    ]);
    const audit = await fetchAnalyticsAudit(EXECUTION_ID);
    expect(audit.run.metadata?.status).toBe("completed");
  });

  it("absence de nextCursor : arrêt après une page", async () => {
    const seen = stubFetch([
      { match: /\/api\/analytics\/runs\?/, status: 200, body: { runs: [{ executionId: "x" }] } },
      NO_STEPS,
    ]);
    const audit = await fetchAnalyticsAudit(EXECUTION_ID, { maxPages: 5 });
    expect(audit.run.pagesScanned).toBe(1);
    expect(audit.run.found).toBe(false);
    expect(seen.filter((u) => u.includes("/runs?")).length).toBe(1);
  });

  it("s'arrête à maxPages même si le fournisseur pagine indéfiniment", async () => {
    stubFetch([
      {
        match: /\/api\/analytics\/runs\?/,
        status: 200,
        body: { runs: [{ executionId: "x" }], nextCursor: "always" },
      },
      NO_STEPS,
    ]);
    const audit = await fetchAnalyticsAudit(EXECUTION_ID, { maxPages: 3 });
    expect(audit.run.pagesScanned).toBe(3);
    expect(audit.run.found).toBe(false);
  });
});

describe("rejets 401 / 403", () => {
  it("consigne le statut sans spéculer sur la cause", async () => {
    stubFetch([
      { match: /\/api\/analytics\/runs\?/, status: 401, body: { error: "Authentication required" } },
      { match: /\/steps$/, status: 403, body: { error: "Organization not found" } },
    ]);
    const audit = await fetchAnalyticsAudit(EXECUTION_ID);

    for (const note of [audit.run.probe.note, audit.steps.probe.note]) {
      expect(note).toContain("The organization API key used by this agent was rejected");
      expect(note).toContain("The underlying cause remains unresolved");
      // Aucune affirmation non établie.
      expect(note).not.toMatch(/browser session|does not accept|session navigateur/i);
    }
    expect(audit.run.probe.available).toBe(false);
    expect(audit.steps.available).toBe(false);
  });
});

describe("request id", () => {
  it("conserve x-request-id d'en-tête", async () => {
    stubFetch([
      {
        match: /\/api\/analytics\/runs\?/,
        status: 401,
        body: { error: "Authentication required" },
        headers: { "x-request-id": "req-header-123" },
      },
      NO_STEPS,
    ]);
    const audit = await fetchAnalyticsAudit(EXECUTION_ID);
    expect(audit.run.probe.requestId).toBe("req-header-123");
  });

  it("retombe sur request_id du corps", async () => {
    stubFetch([
      {
        match: /\/api\/analytics\/runs\?/,
        status: 404,
        body: { error: "not_found", request_id: "req-body-456" },
      },
      NO_STEPS,
    ]);
    const audit = await fetchAnalyticsAudit(EXECUTION_ID);
    expect(audit.run.probe.requestId).toBe("req-body-456");
  });

  it("vaut null quand le fournisseur n'en fournit pas", async () => {
    stubFetch([{ match: /\/api\/analytics\/runs\?/, status: 200, body: { runs: [] } }, NO_STEPS]);
    const audit = await fetchAnalyticsAudit(EXECUTION_ID);
    expect(audit.run.probe.requestId).toBeNull();
  });
});

describe("step logs", () => {
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
    stubFetch([{ match: /\/api\/analytics\/runs\?/, status: 200, body: { runs: [] } }, NO_STEPS]);
    const empty = await fetchAnalyticsAudit(EXECUTION_ID);
    expect(empty.steps.available).toBe(true);
    expect(empty.steps.count).toBe(0);

    vi.unstubAllGlobals();
    stubFetch([
      { match: /\/api\/analytics\/runs\?/, status: 401, body: {} },
      { match: /\/steps$/, status: 403, body: {} },
    ]);
    const denied = await fetchAnalyticsAudit(EXECUTION_ID);
    expect(denied.steps.available).toBe(false);
    expect(denied.steps.count).toBeNull();
  });

  it("une panne réseau reste une indisponibilité", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNRESET");
    });
    const audit = await fetchAnalyticsAudit(EXECUTION_ID);
    expect(audit.run.probe.available).toBe(false);
    expect(audit.run.probe.note).toContain("Unreachable");
  });
});

describe("Analytics dans les sources d'audit", () => {
  it("apparaît comme couverture, jamais comme validation", async () => {
    stubFetch([
      { match: /\/api\/analytics\/runs\?/, status: 401, body: {} },
      { match: /\/steps$/, status: 403, body: {} },
    ]);
    const analytics = await fetchAnalyticsAudit(EXECUTION_ID);
    const audit = normalizeAudit({ directStatus: null, analytics });

    const rest = audit.sources.filter((s) => s.surface.startsWith("rest:"));
    expect(rest.length).toBe(2);
    expect(rest.every((s) => !s.available)).toBe(true);
    // Aucune donnée de vérité ne provient d'Analytics.
    expect(audit.transactionHash).toBeNull();
  });
});

describe("sortie CLI", () => {
  it("la charge est du JSON parseable et ne contient aucune clé", async () => {
    stubFetch([
      {
        match: /\/api\/analytics\/runs\?/,
        status: 401,
        body: {},
        headers: { "x-request-id": "req-1" },
      },
      { match: /\/steps$/, status: 403, body: {} },
    ]);
    const analytics = await fetchAnalyticsAudit(EXECUTION_ID);
    const payload = {
      executionId: EXECUTION_ID,
      keeperHubAudit: normalizeAudit({ directStatus: null, analytics }),
      analytics,
    };

    const serialized = JSON.stringify(payload, null, 2);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(JSON.parse(serialized).analytics.run.probe.requestId).toBe("req-1");
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toMatch(/kh_[A-Za-z0-9]{10}/);
  });
});
