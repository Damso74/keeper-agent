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
import { type ChainObservation, observe as observeChain, rpcCallsMade } from "./chain";
import { fetchChainEvidence as fetchEvidence } from "./chain-evidence";
import { decide, type Decision } from "./decide";
import { KeeperHubClient, type ToolResult } from "./keeperhub";
import type { ChainEvidence } from "./reconcile";
import { type Verification, verifyExecution } from "./verify";

/**
 * Boucle de l'agent : observer → décider → exécuter → attendre → vérifier.
 *
 * En mode `dryRun` (défaut) rien n'est diffusé : l'agent observe et décide, et
 * s'arrête là. La diffusion demande un choix explicite de l'opérateur.
 *
 * Deux invariants gouvernent la fin de la boucle :
 *
 * 1. **Un seul `execute_transfer` non simulé, jamais réémis.** L'attente se fait
 *    en interrogeant le statut ; réémettre l'exécution pour « relancer » est
 *    exactement le geste qui double un transfert.
 * 2. **`EXECUTED_VERIFIED` ne vient que de la chaîne.** Le champ `verified` du
 *    fournisseur est enregistré comme signal, jamais comme preuve.
 */

/** Statuts terminaux côté fournisseur. Tout le reste demande d'attendre. */
const TERMINAL_STATUSES = new Set(["completed", "failed"]);

/**
 * `unconfirmed` est explicitement non terminal : KeeperHub l'utilise pour une
 * transaction diffusée dont le receipt n'est pas encore lisible. La traiter
 * comme un échec est ce qui pousse un appelant à réémettre.
 */
const NON_TERMINAL_STATUSES = new Set(["queued", "pending", "running", "unconfirmed"]);

export const POLL_INTERVAL_MS = 3_000;
export const POLL_TIMEOUT_MS = 120_000;

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
    /** Nombre d'appels d'exécution non simulés. Doit valoir 1, jamais plus. */
    executeCalls: number;
    executionId: string | null;
    transactionHash: string | null;
    /** Statut déclaré par le fournisseur. Signal, pas preuve. */
    providerStatus: string | null;
    providerReceiptStatus: string | null;
    /** `receipts[0].verified` du fournisseur, conservé pour comparaison. */
    providerVerified: boolean | null;
    gasUsed: string | null;
    explorerUrl: string | null;
    pollAttempts: number;
    timedOut: boolean;
  } | null;
  /** Vérification RPC indépendante. `null` si aucun hash n'a pu être vérifié. */
  verification: Verification | null;
  /** Le rapport n'affirme jamais un succès sur la seule parole du fournisseur. */
  outcome:
    | "NO_ACTION"
    | "DRY_RUN"
    | "EXECUTED_PENDING_VERIFICATION"
    | "EXECUTED_VERIFIED"
    | "FAILED";
  notes: string[];
};

/**
 * Code de sortie du CLI, distinct par issue.
 *
 * `EXECUTED_PENDING_VERIFICATION` ne peut pas partager le code de succès : un
 * appelant qui teste `exit 0` traiterait alors « je ne sais pas encore » comme
 * « c'est vérifié », ce qui est précisément la confusion que cet agent refuse.
 *
 * 0 = issue établie et non problématique · 1 = échec constaté · 2 = indéterminé.
 */
export function exitCodeFor(outcome: AgentReport["outcome"]): 0 | 1 | 2 {
  if (outcome === "FAILED") return 1;
  if (outcome === "EXECUTED_PENDING_VERIFICATION") return 2;
  return 0;
}

/** Surface minimale du client d'exécution, pour pouvoir l'injecter en test. */
export type ExecutionClient = {
  connect(): Promise<void>;
  executeTransfer(input: {
    chainId: number;
    tokenAddress: string;
    toAddress: string;
    amount: string;
    idempotencyKey: string;
    simulate?: boolean;
  }): Promise<ToolResult>;
  executionStatus(executionId: string): Promise<ToolResult>;
  close(): Promise<void>;
};

export type RunDeps = {
  observe: (upperBound: bigint, now: Date) => Promise<ChainObservation>;
  createClient: () => ExecutionClient;
  fetchChainEvidence: (transactionHash: string) => Promise<ChainEvidence>;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
};

export type RunOptions = {
  dryRun: boolean;
  now?: Date;
  deps?: Partial<RunDeps>;
};

const defaultDeps: RunDeps = {
  observe: observeChain,
  createClient: () => new KeeperHubClient(),
  fetchChainEvidence: fetchEvidence,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowMs: () => Date.now(),
  pollIntervalMs: POLL_INTERVAL_MS,
  pollTimeoutMs: POLL_TIMEOUT_MS,
};

function pick(json: unknown, path: string[]): unknown {
  let current: unknown = json;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current ?? null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

type StatusSnapshot = {
  providerStatus: string | null;
  transactionHash: string | null;
  receiptStatus: string | null;
  gasUsed: string | null;
  providerVerified: boolean | null;
};

function readStatus(json: unknown): StatusSnapshot {
  const receipts = pick(json, ["receipts"]);
  const first = Array.isArray(receipts) ? (receipts[0] as Record<string, unknown> | undefined) : undefined;
  const verified = first?.verified;
  return {
    providerStatus: asString(pick(json, ["status"])),
    transactionHash: asString(pick(json, ["transactionHash"])),
    receiptStatus: asString(first?.receiptStatus),
    gasUsed: typeof first?.gasUsed === "string" ? first.gasUsed : null,
    providerVerified: typeof verified === "boolean" ? verified : null,
  };
}

export async function runAgent(options: RunOptions): Promise<AgentReport> {
  const deps: RunDeps = { ...defaultDeps, ...options.deps };
  const now = options.now ?? new Date();
  const notes: string[] = [];
  const window = currentWindow(now);
  const key = idempotencyKey(window, DRIP_AMOUNT_RAW);

  // 1. OBSERVER — état lu en direct sur la chaîne, jamais depuis un rapport.
  // La borne haute de la recherche dichotomique est le plafond hebdomadaire.
  const observation = await deps.observe(5_000_000n, now);

  // 2. DÉCIDER — fonction pure, rejouable par un tiers.
  const decision: Decision = decide({
    remainingAllowanceRaw: observation.remainingAllowanceRaw,
    safeTokenBalanceRaw: observation.safeTokenBalanceRaw,
    dripAmountRaw: DRIP_AMOUNT_RAW,
    safetyMarginRaw: SAFETY_MARGIN_RAW,
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
    verification: null,
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
  const keeperhub = deps.createClient();
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
    const executeCalls = 1;

    const executionId = asString(pick(executed.json, ["executionId"]));
    if (executionId === null) {
      notes.push(
        "Aucun executionId renvoyé : impossible de réconcilier. Aucune réémission automatique.",
      );
      return {
        ...base,
        simulation,
        execution: {
          attempted: true,
          executeCalls,
          executionId: null,
          transactionHash: null,
          providerStatus: null,
          providerReceiptStatus: null,
          providerVerified: null,
          gasUsed: null,
          explorerUrl: null,
          pollAttempts: 0,
          timedOut: false,
        },
        verification: null,
        outcome: "FAILED",
      };
    }

    // 4. ATTENDRE — on interroge le statut, on ne réémet jamais l'exécution.
    const deadline = deps.nowMs() + deps.pollTimeoutMs;
    let snapshot: StatusSnapshot = {
      providerStatus: null,
      transactionHash: null,
      receiptStatus: null,
      gasUsed: null,
      providerVerified: null,
    };
    let pollAttempts = 0;
    let timedOut = false;

    for (;;) {
      const status = await keeperhub.executionStatus(executionId);
      pollAttempts += 1;
      const next = readStatus(status.json);
      snapshot = {
        ...next,
        // Un hash déjà vu ne doit pas disparaître d'une réponse à l'autre.
        transactionHash: next.transactionHash ?? snapshot.transactionHash,
      };

      if (snapshot.providerStatus !== null && TERMINAL_STATUSES.has(snapshot.providerStatus)) break;
      if (deps.nowMs() >= deadline) {
        timedOut = true;
        break;
      }
      await deps.sleep(deps.pollIntervalMs);
    }

    if (timedOut) {
      notes.push(
        `Statut non terminal après ${deps.pollTimeoutMs} ms (${snapshot.providerStatus ?? "inconnu"}). ` +
          "L'exécution n'est ni confirmée ni infirmée : aucune réémission.",
      );
    }
    if (snapshot.providerStatus !== null && NON_TERMINAL_STATUSES.has(snapshot.providerStatus)) {
      notes.push(
        `Statut fournisseur '${snapshot.providerStatus}' : non terminal, la transaction peut encore atterrir.`,
      );
    }

    // 5. VÉRIFIER — preuve RPC indépendante, décodée depuis le receipt.
    let verification: Verification | null = null;
    if (snapshot.transactionHash !== null) {
      try {
        const evidence = await deps.fetchChainEvidence(snapshot.transactionHash);
        verification = verifyExecution({
          evidence,
          expected: {
            safe: ADDRESSES.safe,
            rolesModifier: ADDRESSES.rolesModifier,
            delegateEoa: ADDRESSES.delegateEoa,
            token: ADDRESSES.token,
            recipient: RECIPIENT,
            chainId: CHAIN_ID,
          },
          amountRaw: decision.amountRaw,
          expectedTransactionHash: snapshot.transactionHash,
        });
      } catch (error) {
        notes.push(
          `Preuve on-chain illisible (${String(error).slice(0, 120)}) : succès non déclaré.`,
        );
      }
    } else {
      notes.push("Aucun hash de transaction : rien à vérifier sur la chaîne.");
    }

    if (verification !== null && !verification.verified) {
      if (verification.failed.length > 0) {
        notes.push(`Divergence on-chain : ${verification.failed.join(", ")}.`);
      }
      if (verification.missing.length > 0) {
        notes.push(`Preuves absentes : ${verification.missing.join(", ")}.`);
      }
    }
    if (snapshot.providerVerified === true && verification?.verified !== true) {
      notes.push(
        "Le fournisseur déclare la transaction vérifiée ; la chaîne ne le confirme pas. " +
          "Le rapport suit la chaîne.",
      );
    }
    if (simulation?.wouldRevert === true && verification?.verified === true) {
      notes.push(
        "Faux négatif de simulation confirmé : échec prédit, exécution vérifiée sur la chaîne.",
      );
    }

    const chainSaysReverted =
      verification !== null &&
      verification.checks.some((c) => c.id === "RECEIPT_STATUS_SUCCESS" && c.observed === "failed");

    let outcome: AgentReport["outcome"];
    if (verification?.verified === true) outcome = "EXECUTED_VERIFIED";
    else if (chainSaysReverted) outcome = "FAILED";
    else outcome = "EXECUTED_PENDING_VERIFICATION";

    return {
      ...base,
      simulation,
      execution: {
        attempted: true,
        executeCalls,
        executionId,
        transactionHash: snapshot.transactionHash,
        providerStatus: snapshot.providerStatus,
        providerReceiptStatus: snapshot.receiptStatus,
        providerVerified: snapshot.providerVerified,
        gasUsed: snapshot.gasUsed,
        explorerUrl:
          snapshot.transactionHash !== null
            ? `https://sepolia.etherscan.io/tx/${snapshot.transactionHash}`
            : null,
        pollAttempts,
        timedOut,
      },
      verification,
      outcome,
    };
  } finally {
    await keeperhub.close();
  }
}
