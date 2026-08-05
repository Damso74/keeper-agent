#!/usr/bin/env node
import { normalizeAudit } from "./audit";
import { fetchChainEvidence } from "./chain-evidence";
import { ADDRESSES, CHAIN_ID, RECIPIENT } from "./config";
import { KeeperHubClient } from "./keeperhub";
import { reconcile } from "./reconcile";

/**
 * Audit en lecture seule d'une exécution KeeperHub.
 *
 *   npm run audit -- <executionId>
 *
 * Récupère le journal d'audit du fournisseur, lit les preuves on-chain
 * indépendamment, puis réconcilie les deux. Aucune diffusion, aucune écriture,
 * aucun changement d'état. La clé API n'est jamais écrite dans la sortie.
 */
async function main(): Promise<void> {
  const executionId = process.argv[2];
  if (!executionId || executionId.startsWith("-")) {
    throw new Error("Usage : npm run audit -- <executionId>");
  }

  const client = new KeeperHubClient();
  await client.connect();

  let directStatus: unknown = null;
  let workflowExecution = {
    attempted: false,
    available: false,
    note: "",
  };

  try {
    const status = await client.executionStatus(executionId);
    directStatus = status.json;

    // `get_execution` cible les exécutions de workflow. On la tente pour
    // documenter honnêtement ce que KeeperHub expose — ou n'expose pas — pour
    // une exécution directe, plutôt que d'affirmer sans avoir demandé.
    workflowExecution = { attempted: true, available: false, note: "" };
    try {
      const workflow = await client.call("get_execution", { executionId });
      const hasPayload = workflow.json !== null;
      workflowExecution = {
        attempted: true,
        available: hasPayload,
        note: hasPayload
          ? "Journal de workflow également disponible."
          : "Aucun journal de workflow : attendu pour une exécution directe.",
      };
    } catch (error) {
      workflowExecution = {
        attempted: true,
        available: false,
        note: `Non exposé pour une exécution directe (${String(error).slice(0, 90)}).`,
      };
    }
  } finally {
    await client.close();
  }

  const audit = normalizeAudit({ directStatus, workflowExecution });

  if (!audit.transactionHash) {
    console.warn(
      JSON.stringify(
        {
          executionId,
          keeperHubAudit: audit,
          chainEvidence: null,
          reconciliation: {
            verdict: "EVIDENCE_MISSING",
            reason: "Le journal d'audit ne porte aucun hash de transaction à vérifier.",
          },
        },
        null,
        2,
      ),
    );
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
  });

  console.warn(
    JSON.stringify({ executionId, keeperHubAudit: audit, chainEvidence: chain, reconciliation }, null, 2),
  );

  if (reconciliation.verdict === "MISMATCH" || reconciliation.verdict === "EVIDENCE_MISSING") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
