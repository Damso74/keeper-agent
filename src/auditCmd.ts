#!/usr/bin/env node
import { fetchAnalyticsAudit } from "./analytics";
import { normalizeAudit } from "./audit";
import { fetchChainEvidence } from "./chain-evidence";
import { ADDRESSES, CHAIN_ID, DRIP_AMOUNT_RAW, RECIPIENT } from "./config";
import { KeeperHubClient } from "./keeperhub";
import { reconcile } from "./reconcile";

/**
 * Audit en lecture seule d'une exécution Treasury Drip.
 *
 *   npm --silent run audit -- <executionId> | jq
 *
 * Récupère le journal MCP `get_direct_execution_status`, interroge l'API
 * Analytics REST, lit les preuves on-chain indépendamment, puis réconcilie.
 *
 * Le JSON part sur **stdout**, les diagnostics sur **stderr** : la sortie reste
 * pipeable. La clé API n'apparaît jamais dans le résultat.
 *
 * Aucune diffusion, aucune écriture, aucun changement d'état.
 *
 * Portée : cette commande réconcilie les exécutions Treasury Drip correspondant
 * à la configuration attendue (Safe, Roles Modifier, token et destinataire de
 * `config.ts`). Une exécution d'une autre configuration produira des divergences
 * légitimes — ce n'est pas un auditeur générique.
 */

const out = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

async function main(): Promise<void> {
  const executionId = process.argv[2];
  if (!executionId || executionId.startsWith("-")) {
    throw new Error("Usage : npm --silent run audit -- <executionId>");
  }

  const client = new KeeperHubClient();
  await client.connect();
  let directStatus: unknown = null;
  try {
    directStatus = (await client.executionStatus(executionId)).json;
  } finally {
    await client.close();
  }

  // L'API Analytics est un service REST distinct du serveur MCP.
  const analytics = await fetchAnalyticsAudit(executionId);
  for (const probe of [analytics.run.probe, analytics.steps.probe]) {
    if (!probe.available) process.stderr.write(`analytics ${probe.endpoint} : ${probe.note}\n`);
  }

  const audit = normalizeAudit({ directStatus, analytics });

  if (!audit.transactionHash) {
    out({
      executionId,
      keeperHubAudit: audit,
      analytics,
      chainEvidence: null,
      reconciliation: {
        verdict: "EVIDENCE_MISSING",
        checks: [],
        mismatches: [],
        missing: ["TRANSACTION_HASH"],
        warnings: [],
        reason: "Le journal d'audit ne porte aucun hash de transaction à vérifier.",
      },
    });
    process.exitCode = 1;
    return;
  }

  const chain = await fetchChainEvidence(audit.transactionHash);
  const reconciliation = reconcile(audit, chain, {
    safe: ADDRESSES.safe,
    rolesModifier: ADDRESSES.rolesModifier,
    delegateEoa: ADDRESSES.delegateEoa,
    token: ADDRESSES.token,
    recipient: RECIPIENT,
    chainId: CHAIN_ID,
    amountRaw: DRIP_AMOUNT_RAW,
  });

  out({ executionId, keeperHubAudit: audit, analytics, chainEvidence: chain, reconciliation });

  // MATCH et MATCH_WITH_PROVIDER_WARNINGS sortent en 0 : la chaîne concorde.
  if (reconciliation.verdict === "MISMATCH" || reconciliation.verdict === "EVIDENCE_MISSING") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
