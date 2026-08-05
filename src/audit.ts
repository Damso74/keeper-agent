import type { AnalyticsAudit } from "./analytics";

/**
 * Journal d'audit KeeperHub, normalisé.
 *
 * `normalizeAudit` est une fonction pure : elle transforme la charge brute du
 * fournisseur en une forme stable, sans réseau. Toute absence est représentée
 * par `null` — jamais comblée par une valeur plausible.
 */

export type SponsoredRecord = {
  root: boolean | null;
  executedCall: boolean | null;
  /** `true` si les deux niveaux se contredisent. */
  inconsistent: boolean;
};

export type KeeperHubAudit = {
  executionId: string | null;
  type: string | null;
  status: string | null;
  transactionHash: string | null;
  transactionLink: string | null;
  receipt: {
    verified: boolean | null;
    receiptStatus: string | null;
    blockNumber: number | null;
    gasUsed: string | null;
    verifiedAt: string | null;
    chainId: number | null;
  } | null;
  gasUsedWei: string | null;
  gasPriceWei: string | null;
  createdAt: string | null;
  completedAt: string | null;
  retryCount: number | null;
  sponsored: SponsoredRecord;
  simulation: { reverted: boolean | null; revertReason: string | null } | null;
  idempotentReplay: boolean | null;
  /**
   * `true` si la charge brute du fournisseur mentionne la consommation de
   * policy. Se juge sur la réponse d'origine, pas sur cet objet normalisé qui
   * ne retient que des champs connus.
   */
  disclosesPolicy: boolean;
  executedCall: {
    topLevelTo: string | null;
    contractAddress: string | null;
    functionName: string | null;
    recipient: string | null;
    valueRaw: string | null;
    reverted: boolean | null;
  } | null;
  /** Surfaces KeeperHub effectivement interrogées, et ce qu'elles ont rendu. */
  sources: Array<{ surface: string; available: boolean; note: string }>;
};

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Quantité normalisée en chaîne décimale — jamais de Number, jamais d'arrondi. */
function amount(value: unknown): string | null {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return String(value);
  return null;
}

export type AuditSources = {
  /** Réponse de `get_direct_execution_status` (MCP). */
  directStatus: unknown;
  /** Résultat de l'API Analytics REST, si interrogée. */
  analytics?: AnalyticsAudit;
  /** Réponse de simulation si l'agent en a conservé une. */
  simulation?: unknown;
};

export function normalizeAudit(input: AuditSources): KeeperHubAudit {
  const status = rec(input.directStatus);
  const result = rec(status?.result);
  const executedCall = rec(result?.executedCall);
  const receipts = Array.isArray(status?.receipts)
    ? (status.receipts as unknown[]).map(rec).filter((r): r is Record<string, unknown> => r !== null)
    : [];
  const firstReceipt = receipts[0] ?? null;

  const sponsoredRoot = bool(status?.sponsored);
  const sponsoredNested = bool(executedCall?.sponsored);

  const simulation = rec(input.simulation);

  const sources: KeeperHubAudit["sources"] = [
    {
      surface: "mcp:get_direct_execution_status",
      available: status !== null,
      note: status
        ? "Journal d'exécution directe récupéré."
        : "Aucune charge exploitable renvoyée.",
    },
  ];
  if (input.analytics) {
    sources.push({
      surface: `rest:${input.analytics.run.probe.endpoint.split("?")[0]}`,
      available: input.analytics.run.found,
      note: input.analytics.run.probe.note,
    });
    sources.push({
      surface: "rest:/api/analytics/runs/:id/steps",
      available: input.analytics.steps.available,
      note: input.analytics.steps.probe.note,
    });
  }
  if (input.simulation !== undefined) {
    sources.push({
      surface: "mcp:execute_transfer(simulate)",
      available: simulation !== null,
      note: simulation ? "Résultat de simulation conservé." : "Aucun résultat de simulation.",
    });
  }

  return {
    executionId: str(status?.executionId),
    type: str(status?.type),
    status: str(status?.status),
    transactionHash: str(status?.transactionHash),
    transactionLink: str(status?.transactionLink),
    receipt: firstReceipt
      ? {
          verified: bool(firstReceipt.verified),
          receiptStatus: str(firstReceipt.receiptStatus),
          blockNumber: num(firstReceipt.blockNumber),
          gasUsed: amount(firstReceipt.gasUsed),
          verifiedAt: str(firstReceipt.verifiedAt),
          chainId: num(firstReceipt.chainId),
        }
      : null,
    gasUsedWei: amount(status?.gasUsedWei),
    gasPriceWei: amount(status?.gasPriceWei),
    createdAt: str(status?.createdAt),
    completedAt: str(status?.completedAt),
    retryCount: num(status?.retryCount),
    sponsored: {
      root: sponsoredRoot,
      executedCall: sponsoredNested,
      inconsistent:
        sponsoredRoot !== null && sponsoredNested !== null && sponsoredRoot !== sponsoredNested,
    },
    simulation: simulation
      ? {
          reverted: bool(simulation.wouldRevert),
          revertReason: str(simulation.revertReason),
        }
      : null,
    // Le fournisseur signale un rejeu idempotent sous des noms variables ;
    // on ne retient que ce qui est explicitement booléen.
    idempotentReplay:
      bool(status?.idempotentReplay) ?? bool(status?.idempotent) ?? bool(result?.idempotentReplay),
    disclosesPolicy: /allowance|spendinglimit|policy/i.test(
      JSON.stringify(input.directStatus ?? null),
    ),
    executedCall: executedCall
      ? {
          topLevelTo: str(executedCall.topLevelTo),
          contractAddress: str(executedCall.contractAddress),
          functionName: str(executedCall.functionName),
          recipient: str(rec(executedCall.args)?.to),
          valueRaw: amount(rec(executedCall.args)?.value),
          reverted: bool(executedCall.reverted),
        }
      : null,
    sources,
  };
}
