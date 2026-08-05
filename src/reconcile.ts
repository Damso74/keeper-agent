import type { KeeperHubAudit } from "./audit";

/**
 * Réconciliation entre le journal d'audit KeeperHub et les preuves RPC
 * indépendantes.
 *
 * Fonction pure et totale. Règle cardinale : **une absence ou une divergence ne
 * devient jamais un succès.** Le journal du fournisseur ne peut jamais valider à
 * lui seul ; seule la chaîne fait autorité.
 */

export type ChainEvidence = {
  chainId: number | null;
  transactionHash: string | null;
  receiptStatusOk: boolean | null;
  blockNumber: number | null;
  gasUsed: string | null;
  sender: string | null;
  topLevelTo: string | null;
  transferToken: string | null;
  transferFrom: string | null;
  transferTo: string | null;
  transferValueRaw: string | null;
  moduleExecutionSuccess: boolean;
  allowanceConsumedRaw: string | null;
  allowanceRemainingRaw: string | null;
};

export type Expectations = {
  safe: string;
  rolesModifier: string;
  delegateEoa: string;
  token: string;
  recipient: string;
  chainId: number;
};

export type CheckStatus = "MATCH" | "MISMATCH" | "MISSING" | "WARNING" | "NOT_APPLICABLE";

export type ReconciliationCheck = {
  id: string;
  /** `authoritative` : la chaîne tranche. `provider` : ne peut qu'avertir. */
  kind: "authoritative" | "provider";
  status: CheckStatus;
  audit: string | null;
  chain: string | null;
  note: string | null;
};

export type ReconciliationVerdict =
  | "MATCH"
  | "MATCH_WITH_PROVIDER_WARNINGS"
  | "MISMATCH"
  | "EVIDENCE_MISSING";

export type Reconciliation = {
  verdict: ReconciliationVerdict;
  checks: ReconciliationCheck[];
  mismatches: string[];
  missing: string[];
  warnings: string[];
};

const same = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

function compare(
  id: string,
  kind: ReconciliationCheck["kind"],
  auditValue: string | null,
  chainValue: string | null,
  matches: (a: string, b: string) => boolean = (a, b) => a.toLowerCase() === b.toLowerCase(),
  note: string | null = null,
): ReconciliationCheck {
  if (chainValue === null || auditValue === null) {
    return { id, kind, status: "MISSING", audit: auditValue, chain: chainValue, note };
  }
  return {
    id,
    kind,
    status: matches(auditValue, chainValue) ? "MATCH" : "MISMATCH",
    audit: auditValue,
    chain: chainValue,
    note,
  };
}

export function reconcile(
  audit: KeeperHubAudit,
  chain: ChainEvidence,
  expected: Expectations,
): Reconciliation {
  const checks: ReconciliationCheck[] = [];

  checks.push(
    compare(
      "CHAIN_ID",
      "authoritative",
      audit.receipt?.chainId != null ? String(audit.receipt.chainId) : null,
      chain.chainId != null ? String(chain.chainId) : null,
    ),
  );

  checks.push(
    compare("TRANSACTION_HASH", "authoritative", audit.transactionHash, chain.transactionHash),
  );

  checks.push(
    compare(
      "RECEIPT_STATUS",
      "authoritative",
      audit.receipt?.receiptStatus ?? null,
      chain.receiptStatusOk === null ? null : chain.receiptStatusOk ? "success" : "failed",
    ),
  );

  checks.push(
    compare(
      "BLOCK_NUMBER",
      "authoritative",
      audit.receipt?.blockNumber != null ? String(audit.receipt.blockNumber) : null,
      chain.blockNumber != null ? String(chain.blockNumber) : null,
    ),
  );

  checks.push(compare("GAS_USED", "authoritative", audit.receipt?.gasUsed ?? null, chain.gasUsed));

  // Le sender et la cible de premier niveau ne sont pas déclarés par le
  // fournisseur : ils sont vérifiés contre les attentes de configuration.
  checks.push({
    id: "SENDER_IS_DELEGATE",
    kind: "authoritative",
    status:
      chain.sender === null ? "MISSING" : same(chain.sender, expected.delegateEoa) ? "MATCH" : "MISMATCH",
    audit: null,
    chain: chain.sender,
    note: "Attendu : l'EOA délégué.",
  });

  checks.push(
    compare(
      "TOP_LEVEL_TARGET",
      "authoritative",
      audit.executedCall?.topLevelTo ?? null,
      chain.topLevelTo,
      (a, b) => a.toLowerCase() === b.toLowerCase(),
      "Doit être le Roles Modifier, pas le Safe.",
    ),
  );

  checks.push({
    id: "TOP_LEVEL_IS_ROLES_MODIFIER",
    kind: "authoritative",
    status:
      chain.topLevelTo === null
        ? "MISSING"
        : same(chain.topLevelTo, expected.rolesModifier)
          ? "MATCH"
          : "MISMATCH",
    audit: null,
    chain: chain.topLevelTo,
    note: "Attendu : le Zodiac Roles Modifier.",
  });

  checks.push(
    compare(
      "TOKEN",
      "authoritative",
      audit.executedCall?.contractAddress ?? null,
      chain.transferToken,
    ),
  );

  checks.push({
    id: "TRANSFER_FROM_SAFE",
    kind: "authoritative",
    status:
      chain.transferFrom === null
        ? "MISSING"
        : same(chain.transferFrom, expected.safe)
          ? "MATCH"
          : "MISMATCH",
    audit: null,
    chain: chain.transferFrom,
    note: "Le Safe doit être l'émetteur du transfert ERC20.",
  });

  checks.push(
    compare("RECIPIENT", "authoritative", audit.executedCall?.recipient ?? null, chain.transferTo),
  );

  checks.push(
    compare(
      "AMOUNT",
      "authoritative",
      audit.executedCall?.valueRaw ?? null,
      chain.transferValueRaw,
      (a, b) => BigInt(a) === BigInt(b),
    ),
  );

  checks.push({
    id: "MODULE_EXECUTION_SUCCESS",
    kind: "authoritative",
    status: chain.moduleExecutionSuccess ? "MATCH" : "MISSING",
    audit: null,
    chain: chain.moduleExecutionSuccess ? "ExecutionFromModuleSuccess" : null,
    note: "Événement émis par le Safe.",
  });

  checks.push({
    id: "POLICY_ALLOWANCE_CONSUMED",
    kind: "authoritative",
    status:
      chain.allowanceConsumedRaw === null
        ? "MISSING"
        : chain.transferValueRaw !== null &&
            BigInt(chain.allowanceConsumedRaw) === BigInt(chain.transferValueRaw)
          ? "MATCH"
          : "MISMATCH",
    audit: null,
    chain:
      chain.allowanceConsumedRaw === null
        ? null
        : `consumed=${chain.allowanceConsumedRaw} remaining=${chain.allowanceRemainingRaw ?? "?"}`,
    note: "ConsumeAllowance doit correspondre au montant transféré.",
  });

  // --- Signaux fournisseur : ils avertissent, ils ne valident jamais. ---

  checks.push({
    id: "PROVIDER_STATUS",
    kind: "provider",
    status:
      audit.status === null
        ? "MISSING"
        : audit.status === "completed" && chain.receiptStatusOk === true
          ? "MATCH"
          : "MISMATCH",
    audit: audit.status,
    chain: chain.receiptStatusOk === null ? null : chain.receiptStatusOk ? "success" : "failed",
    note: null,
  });

  checks.push({
    id: "SPONSORED_CONSISTENCY",
    kind: "provider",
    status: audit.sponsored.inconsistent
      ? "WARNING"
      : audit.sponsored.root === null && audit.sponsored.executedCall === null
        ? "NOT_APPLICABLE"
        : "MATCH",
    audit: `root=${audit.sponsored.root} executedCall=${audit.sponsored.executedCall}`,
    chain: null,
    note: audit.sponsored.inconsistent
      ? "Le fournisseur se contredit entre deux niveaux de la même réponse."
      : null,
  });

  checks.push({
    id: "SIMULATION_FALSE_NEGATIVE",
    kind: "provider",
    status:
      audit.simulation === null || audit.simulation.reverted === null
        ? "NOT_APPLICABLE"
        : audit.simulation.reverted && chain.receiptStatusOk === true
          ? "WARNING"
          : "MATCH",
    audit: audit.simulation ? `wouldRevert=${audit.simulation.reverted}` : null,
    chain: chain.receiptStatusOk === null ? null : chain.receiptStatusOk ? "success" : "failed",
    note:
      audit.simulation?.reverted && chain.receiptStatusOk === true
        ? "Échec prédit, exécution réussie : le simulateur modélise un autre chemin."
        : null,
  });

  checks.push({
    id: "POLICY_DISCLOSED_BY_PROVIDER",
    kind: "provider",
    status: audit.disclosesPolicy ? "MATCH" : "WARNING",
    audit: null,
    chain: chain.allowanceConsumedRaw,
    note: "La consommation d'allocation n'apparaît que dans les preuves on-chain.",
  });

  checks.push({
    id: "IDEMPOTENT_REPLAY",
    kind: "provider",
    status:
      audit.idempotentReplay === null
        ? "NOT_APPLICABLE"
        : audit.idempotentReplay
          ? "WARNING"
          : "MATCH",
    audit: audit.idempotentReplay === null ? null : String(audit.idempotentReplay),
    chain: null,
    note: audit.idempotentReplay
      ? "Le fournisseur a rejoué un résultat existant : aucune nouvelle transaction."
      : null,
  });

  const authoritative = checks.filter((check) => check.kind === "authoritative");
  const mismatches = authoritative.filter((c) => c.status === "MISMATCH").map((c) => c.id);
  const missing = authoritative.filter((c) => c.status === "MISSING").map((c) => c.id);
  const warnings = checks
    .filter((check) => check.status === "WARNING" || (check.kind === "provider" && check.status === "MISMATCH"))
    .map((c) => c.id);

  // Ordre strict : une divergence prime, puis une absence. Jamais l'inverse.
  let verdict: ReconciliationVerdict;
  if (mismatches.length > 0) verdict = "MISMATCH";
  else if (missing.length > 0) verdict = "EVIDENCE_MISSING";
  else if (warnings.length > 0) verdict = "MATCH_WITH_PROVIDER_WARNINGS";
  else verdict = "MATCH";

  return { verdict, checks, mismatches, missing, warnings };
}
