import { requireApiKey } from "./config";

/**
 * Client de l'API Analytics KeeperHub.
 *
 * Deux endpoints REST, distincts du serveur MCP :
 *   GET /api/analytics/runs?source=direct   (paginé)
 *   GET /api/analytics/runs/:id/steps
 *
 * Ils sont interrogés avec la même clé d'organisation en Bearer. La clé n'est
 * jamais journalisée ni recopiée dans la sortie.
 *
 * Une indisponibilité est une **information de couverture fournisseur** : elle
 * est consignée telle quelle et ne peut ni valider ni invalider une exécution.
 */

const BASE = process.env.KEEPERHUB_API_BASE ?? "https://app.keeperhub.com";

export type AnalyticsProbe = {
  endpoint: string;
  httpStatus: number | null;
  available: boolean;
  note: string;
};

export type AnalyticsAudit = {
  run: {
    found: boolean;
    metadata: Record<string, unknown> | null;
    pagesScanned: number;
    probe: AnalyticsProbe;
  };
  steps: {
    available: boolean;
    count: number | null;
    entries: unknown[] | null;
    probe: AnalyticsProbe;
  };
};

type FetchOutcome = { status: number | null; body: unknown; error: string | null };

async function get(path: string): Promise<FetchOutcome> {
  const apiKey = requireApiKey();
  try {
    const response = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body, error: null };
  } catch (error) {
    return { status: null, body: null, error: String(error).slice(0, 160) };
  }
}

/** Message de couverture, sans jamais refléter la clé. */
function describe(outcome: FetchOutcome): string {
  if (outcome.error) return `Injoignable : ${outcome.error}`;
  if (outcome.status === 401) {
    return "401 — l'API Analytics n'accepte pas les clés d'organisation (session navigateur attendue).";
  }
  if (outcome.status === 403) {
    return "403 — organisation non résolue depuis une clé d'API.";
  }
  if (outcome.status && outcome.status >= 400) return `HTTP ${outcome.status}.`;
  return `HTTP ${outcome.status}.`;
}

function rows(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  const container = body as Record<string, unknown> | null;
  for (const key of ["runs", "data", "items", "results"]) {
    const value = container?.[key];
    if (Array.isArray(value)) {
      return value.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
    }
  }
  return [];
}

function matchesExecution(row: Record<string, unknown>, executionId: string): boolean {
  for (const key of ["executionId", "id", "execution_id", "runId"]) {
    if (row[key] === executionId) return true;
  }
  return false;
}

/**
 * Cherche un run par identifiant en parcourant les pages `source=direct`.
 * S'arrête dès qu'il est trouvé, ou après `maxPages`.
 */
export async function fetchAnalyticsAudit(
  executionId: string,
  options: { maxPages?: number; pageSize?: number } = {},
): Promise<AnalyticsAudit> {
  const maxPages = options.maxPages ?? 5;
  const pageSize = options.pageSize ?? 50;

  let found: Record<string, unknown> | null = null;
  let pagesScanned = 0;
  let lastOutcome: FetchOutcome = { status: null, body: null, error: "aucun appel effectué" };
  let listPath = "";

  for (let page = 1; page <= maxPages; page += 1) {
    listPath = `/api/analytics/runs?source=direct&limit=${pageSize}&page=${page}`;
    lastOutcome = await get(listPath);
    pagesScanned = page;
    if (lastOutcome.status !== 200) break;
    const batch = rows(lastOutcome.body);
    found = batch.find((row) => matchesExecution(row, executionId)) ?? null;
    if (found || batch.length < pageSize) break;
  }

  const stepsPath = `/api/analytics/runs/${encodeURIComponent(executionId)}/steps`;
  const stepsOutcome = await get(stepsPath);
  const stepEntries = stepsOutcome.status === 200 ? rows(stepsOutcome.body) : null;

  return {
    run: {
      found: found !== null,
      metadata: found,
      pagesScanned,
      probe: {
        endpoint: listPath,
        httpStatus: lastOutcome.status,
        available: lastOutcome.status === 200,
        note:
          lastOutcome.status === 200
            ? found
              ? "Run retrouvé dans le journal Analytics."
              : `Run absent des ${pagesScanned} page(s) parcourue(s).`
            : describe(lastOutcome),
      },
    },
    steps: {
      available: stepsOutcome.status === 200,
      count: stepEntries ? stepEntries.length : null,
      entries: stepEntries,
      probe: {
        endpoint: stepsPath,
        httpStatus: stepsOutcome.status,
        available: stepsOutcome.status === 200,
        note:
          stepsOutcome.status === 200
            ? stepEntries && stepEntries.length > 0
              ? `${stepEntries.length} étape(s) journalisée(s).`
              : "Endpoint disponible mais aucune étape journalisée."
            : describe(stepsOutcome),
      },
    },
  };
}
