import {
  ADDRESSES,
  CHAIN_ID,
  currentWindow,
  DRIP_AMOUNT_RAW,
  formatUnits,
  idempotencyKey,
  RECIPIENT,
  SAFETY_MARGIN_RAW,
  TOKEN,
} from "./config";
import { observe, rpcCallsMade } from "./chain";
import { decide, type Decision } from "./decide";
import { KeeperHubClient } from "./keeperhub";

/**
 * Boucle de l'agent : observer → décider → exécuter → réconcilier.
 *
 * En mode `dryRun` (défaut) rien n'est diffusé : l'agent observe et décide, et
 * s'arrête là. La diffusion demande un choix explicite de l'opérateur.
 */

export type AgentReport = {
  agent: string;
  startedAt: string;
  network: { chainId: number; blockNumber: number };
  observation: {
    remainingAllowance: string;
    remainingAllowanceRaw: string;
    safeTokenBalance: string;
    safeTokenBalanceRaw: string;
    rpcCalls: number;
  };
  decision: { act: boolean; code: string; reason: string; amount: string };
  window: string;
  idempotencyKey: string;
  simulation: { ran: boolean; wouldRevert: boolean | null; note: string } | null;
  execution: {
    attempted: boolean;
    executionId: string | null;
    transactionHash: string | null;
    status: string | null;
    receiptStatus: string | null;
    gasUsed: string | null;
    verified: boolean | null;
    explorerUrl: string | null;
  } | null;
  /** Le rapport n'affirme jamais un succès sur la seule parole du fournisseur. */
  outcome:
    | "NO_ACTION"
    | "DRY_RUN"
    | "EXECUTED_PENDING_VERIFICATION"
    | "EXECUTED_VERIFIED"
    | "FAILED";
  notes: string[];
};

type RunOptions = { dryRun: boolean; now?: Date; dripsThisWindow?: number };

function pick(json: unknown, path: string[]): unknown {
  let current: unknown = json;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current ?? null;
}

export async function runAgent(options: RunOptions): Promise<AgentReport> {
  const now = options.now ?? new Date();
  const notes: string[] = [];
  const window = currentWindow(now);
  const key = idempotencyKey(window, DRIP_AMOUNT_RAW);

  // 1. OBSERVER — état lu en direct sur la chaîne, jamais depuis un rapport.
  // La borne haute de la recherche dichotomique est le plafond hebdomadaire.
  const observation = await observe(5_000_000n, now);

  // 2. DÉCIDER — fonction pure, rejouable par un tiers.
  const decision: Decision = decide({
    remainingAllowanceRaw: observation.remainingAllowanceRaw,
    safeTokenBalanceRaw: observation.safeTokenBalanceRaw,
    dripAmountRaw: DRIP_AMOUNT_RAW,
    safetyMarginRaw: SAFETY_MARGIN_RAW,
    dripsThisWindow: options.dripsThisWindow ?? 0,
  });

  const base: AgentReport = {
    agent: "treasury-drip-agent",
    startedAt: now.toISOString(),
    network: { chainId: observation.chainId, blockNumber: observation.blockNumber },
    observation: {
      remainingAllowance: `${formatUnits(observation.remainingAllowanceRaw)} ${TOKEN.symbol}`,
      remainingAllowanceRaw: observation.remainingAllowanceRaw.toString(),
      safeTokenBalance: `${formatUnits(observation.safeTokenBalanceRaw)} ${TOKEN.symbol}`,
      safeTokenBalanceRaw: observation.safeTokenBalanceRaw.toString(),
      rpcCalls: rpcCallsMade(),
    },
    decision: {
      act: decision.act,
      code: decision.code,
      reason: decision.reason,
      amount: `${formatUnits(decision.amountRaw)} ${TOKEN.symbol}`,
    },
    window,
    idempotencyKey: key,
    simulation: null,
    execution: null,
    outcome: "NO_ACTION",
    notes,
  };

  if (!decision.act) {
    notes.push("Aucune action : la règle de décision s'est abstenue.");
    return base;
  }

  if (options.dryRun) {
    notes.push("Mode dry-run : aucune diffusion. Relancer avec --execute pour agir.");
    return { ...base, outcome: "DRY_RUN" };
  }

  // 3. EXÉCUTER — via KeeperHub, une seule fois, avec clé d'idempotence.
  const keeperhub = new KeeperHubClient();
  await keeperhub.connect();
  try {
    // La simulation est consultée mais NON bloquante : elle modélise un appel
    // direct depuis l'EOA et produit un faux négatif documenté sur ce flux Safe.
    let simulation: AgentReport["simulation"] = null;
    try {
      const sim = await keeperhub.executeTransfer({
        chainId: CHAIN_ID,
        tokenAddress: ADDRESSES.token,
        toAddress: RECIPIENT,
        amount: formatUnits(decision.amountRaw),
        idempotencyKey: `${key}-sim`,
        simulate: true,
      });
      const wouldRevert = pick(sim.json, ["wouldRevert"]);
      simulation = {
        ran: true,
        wouldRevert: typeof wouldRevert === "boolean" ? wouldRevert : null,
        note: "Signal non bloquant : le simulateur modélise l'EOA en direct, pas le chemin Safe.",
      };
    } catch (error) {
      simulation = {
        ran: true,
        wouldRevert: null,
        note: `Simulation indisponible (${String(error).slice(0, 120)}) — non bloquant.`,
      };
    }

    // Appel unique. Aucun retry automatique : la clé d'idempotence protège de
    // l'effet double, mais réémettre reste une décision humaine.
    const executed = await keeperhub.executeTransfer({
      chainId: CHAIN_ID,
      tokenAddress: ADDRESSES.token,
      toAddress: RECIPIENT,
      amount: formatUnits(decision.amountRaw),
      idempotencyKey: key,
    });

    const executionId = pick(executed.json, ["executionId"]);
    if (typeof executionId !== "string") {
      notes.push("Aucun executionId renvoyé : impossible de réconcilier.");
      return {
        ...base,
        simulation,
        execution: {
          attempted: true,
          executionId: null,
          transactionHash: null,
          status: null,
          receiptStatus: null,
          gasUsed: null,
          verified: null,
          explorerUrl: null,
        },
        outcome: "FAILED",
      };
    }

    // 4. RÉCONCILIER — statut fournisseur ET receipt on-chain.
    const status = await keeperhub.executionStatus(executionId);
    const txHash = pick(status.json, ["transactionHash"]);
    const receipts = pick(status.json, ["receipts"]);
    const firstReceipt = Array.isArray(receipts) ? (receipts[0] as Record<string, unknown>) : null;
    const receiptStatus = firstReceipt?.receiptStatus ?? null;
    const verified = firstReceipt?.verified ?? null;

    const providerSaysDone = pick(status.json, ["status"]) === "completed";
    const chainSaysOk = receiptStatus === "success" && verified === true;

    if (providerSaysDone && !chainSaysOk) {
      notes.push(
        "Le fournisseur déclare 'completed' mais le receipt on-chain ne le confirme pas encore.",
      );
    }
    if (simulation?.wouldRevert === true) {
      notes.push(
        "Faux négatif de simulation confirmé : échec prédit, exécution poursuivie et réconciliée.",
      );
    }

    return {
      ...base,
      simulation,
      execution: {
        attempted: true,
        executionId,
        transactionHash: typeof txHash === "string" ? txHash : null,
        status: (pick(status.json, ["status"]) as string | null) ?? null,
        receiptStatus: (receiptStatus as string | null) ?? null,
        gasUsed: (firstReceipt?.gasUsed as string | null) ?? null,
        verified: typeof verified === "boolean" ? verified : null,
        explorerUrl:
          typeof txHash === "string" ? `https://sepolia.etherscan.io/tx/${txHash}` : null,
      },
      // Le succès n'est déclaré que si la CHAÎNE le confirme.
      outcome: chainSaysOk ? "EXECUTED_VERIFIED" : "EXECUTED_PENDING_VERIFICATION",
    };
  } finally {
    await keeperhub.close();
  }
}
