import { NETWORK_TIMEOUT_MS, requireApiKey } from "./config";

/**
 * Client de l'API Analytics KeeperHub.
 *
 * Deux endpoints REST, distincts du serveur MCP :
 *   GET /api/analytics/runs?source=direct   (paginé par curseur)
 *   GET /api/analytics/runs/:id/steps
 *
 * Interrogés avec la clé d'organisation en Bearer. La clé n'est jamais
 * journalisée ni recopiée dans la sortie.
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
  /** Identifiant de requête renvoyé par le fournisseur, utile pour un ticket. */
  requestId: string | null;
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

type FetchOutcome = {
  status: number | null;
  body: unknown;
  error: string | null;
  requestId: string | null;
};

/** Extrait un identifiant de requête, d'en-tête ou de corps. Jamais la clé. */
function readRequestId(headers: Headers | undefined, body: unknown): string | null {
  const fromHeader = headers?.get("x-request-id") ?? headers?.get("request-id") ?? null;
  if (fromHeader) return fromHeader;
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const fromBody = record?.request_id ?? record?.requestId;
  return typeof fromBody === "string" ? fromBody : null;
}

async function get(path: string): Promise<FetchOutcome> {
  const apiKey = requireApiKey();
  try {
    const response = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return {
      status: response.status,
      body,
      error: null,
      requestId: readRequestId(response.headers, body),
    };
  } catch (error) {
    return { status: null, body: null, error: String(error).slice(0, 160), requestId: null };
  }
}

/**
 * Note de couverture. Reste factuelle : on rapporte ce qui a été observé, sans
 * conclure sur la cause du rejet — elle n'est pas établie.
 */
function describe(outcome: FetchOutcome): string {
  if (outcome.error) return `Unreachable: ${outcome.error}`;
  if (outcome.status === 401 || outcome.status === 403) {
    return (
      `HTTP ${outcome.status}. The organization API key used by this agent was rejected by ` +
      "the documented Analytics endpoints. The underlying cause remains unresolved."
    );
  }
  return `HTTP ${outcome.status}.`;
}

function rows(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) {
    return body.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  }
  const container = body as Record<string, unknown> | null;
  for (const key of ["runs", "data", "items", "results"]) {
    const value = container?.[key];
    if (Array.isArray(value)) {
      return value.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
    }
  }
  return [];
}

/** Curseur de page suivante, à la racine ou sous un objet de pagination. */
function nextCursor(body: unknown): string | null {
  const container = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const direct = container?.nextCursor;
  if (typeof direct === "string" && direct.length > 0) return direct;
  for (const key of ["pagination", "page", "meta"]) {
    const nested = container?.[key];
    const value =
      nested && typeof nested === "object"
        ? (nested as Record<string, unknown>).nextCursor
        : undefined;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function matchesExecution(row: Record<string, unknown>, executionId: string): boolean {
  for (const key of ["executionId", "id", "execution_id", "runId"]) {
    if (row[key] === executionId) return true;
  }
  return false;
}

/**
 * Cherche un run par identifiant en suivant les curseurs de `source=direct`.
 *
 * Premier appel sans `cursor`, appels suivants avec le `nextCursor` reçu. On
 * s'arrête dès que le run est trouvé, qu'aucun `nextCursor` n'est renvoyé, ou
 * que `maxPages` est atteint.
 */
export async function fetchAnalyticsAudit(
  executionId: string,
  options: { maxPages?: number; pageSize?: number } = {},
): Promise<AnalyticsAudit> {
  const maxPages = options.maxPages ?? 5;
  const pageSize = options.pageSize ?? 50;

  let found: Record<string, unknown> | null = null;
  let pagesScanned = 0;
  let cursor: string | null = null;
  let lastOutcome: FetchOutcome = {
    status: null,
    body: null,
    error: "no call made",
    requestId: null,
  };
  let listPath = "";

  for (let page = 1; page <= maxPages; page += 1) {
    listPath =
      `/api/analytics/runs?source=direct&limit=${pageSize}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    lastOutcome = await get(listPath);
    pagesScanned = page;
    if (lastOutcome.status !== 200) break;

    found = rows(lastOutcome.body).find((row) => matchesExecution(row, executionId)) ?? null;
    if (found) break;

    cursor = nextCursor(lastOutcome.body);
    if (!cursor) break;
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
        requestId: lastOutcome.requestId,
        note:
          lastOutcome.status === 200
            ? found
              ? "Run found in the Analytics log."
              : `Run absent from the ${pagesScanned} page(s) scanned.`
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
        requestId: stepsOutcome.requestId,
        note:
          stepsOutcome.status === 200
            ? stepEntries && stepEntries.length > 0
              ? `${stepEntries.length} step(s) logged.`
              : "Endpoint available but no steps logged."
            : describe(stepsOutcome),
      },
    },
  };
}
