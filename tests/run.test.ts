import { describe, expect, it } from "vitest";

import { ADDRESSES, CHAIN_ID, RECIPIENT } from "../src/config";
import type { ChainObservation } from "../src/chain";
import type { ChainEvidence } from "../src/reconcile";
import {
  type AgentReport,
  type ExecutionClient,
  exitCodeFor,
  runAgent,
  type RunDeps,
} from "../src/run";

/**
 * Tests du véritable moteur de l'agent : la boucle exécuter → attendre →
 * vérifier. Aucun réseau. Le client KeeperHub et les lectures RPC sont injectés,
 * ce qui permet de prouver les invariants qui comptent vraiment :
 *
 * - exactement un appel d'exécution non simulé, jamais réémis pendant l'attente ;
 * - `EXECUTED_VERIFIED` seulement si la CHAÎNE le montre ;
 * - un timeout ou une divergence ne devient jamais un succès.
 */

const TX = "0xe7e67b3ab83e1af1f5d130d3c33dbe945cf015da8fb082020b24c253a8eb5062";
const AMOUNT_RAW = "100000"; // 0,1 USDC
const SECRET = "kh_super_secret_key_do_not_leak";

const observation: ChainObservation = {
  chainId: CHAIN_ID,
  blockNumber: 11_424_015,
  safeTokenBalanceRaw: 19_000_000n,
  remainingAllowanceRaw: 4_000_000n,
  observedAt: "2026-08-05T00:00:00.000Z",
};

/** Preuve on-chain complète et cohérente : tous les contrôles passent. */
function goodEvidence(): ChainEvidence {
  return {
    chainId: CHAIN_ID,
    transactionHash: TX,
    receiptStatusOk: true,
    blockNumber: 11_424_015,
    gasUsed: "119267",
    sender: ADDRESSES.delegateEoa,
    topLevelTo: ADDRESSES.rolesModifier,
    transferToken: ADDRESSES.token,
    transferFrom: ADDRESSES.safe,
    transferTo: RECIPIENT,
    transferValueRaw: AMOUNT_RAW,
    moduleExecutionSuccess: true,
    allowanceConsumedRaw: AMOUNT_RAW,
    allowanceRemainingRaw: "3900000",
    moduleSuccessEmitter: ADDRESSES.safe,
    allowanceEmitter: ADDRESSES.rolesModifier,
  };
}

type Call = { kind: "execute" | "simulate" | "status" };

/**
 * Client factice. `statuses` est la suite de réponses de statut renvoyées, une
 * par appel ; la dernière est répétée si l'agent interroge davantage.
 */
function makeClient(statuses: unknown[], executeBody: unknown = { executionId: "exec_1" }) {
  const calls: Call[] = [];
  let statusIndex = 0;

  const client: ExecutionClient = {
    connect: async () => undefined,
    close: async () => undefined,
    executeTransfer: async (input) => {
      calls.push({ kind: input.simulate ? "simulate" : "execute" });
      const json = input.simulate ? { wouldRevert: false } : executeBody;
      return { raw: null, text: JSON.stringify(json), json };
    },
    executionStatus: async () => {
      calls.push({ kind: "status" });
      const json = statuses[Math.min(statusIndex, statuses.length - 1)];
      statusIndex += 1;
      return { raw: null, text: JSON.stringify(json), json };
    },
  };

  return { client, calls };
}

function deps(overrides: Partial<RunDeps> = {}): Partial<RunDeps> {
  return {
    observe: async () => observation,
    fetchChainEvidence: async () => goodEvidence(),
    sleep: async () => undefined,
    nowMs: () => 0,
    pollIntervalMs: 0,
    pollTimeoutMs: 60_000,
    ...overrides,
  };
}

const completed = { status: "completed", transactionHash: TX, receipts: [{ receiptStatus: "success", verified: true, gasUsed: "119267" }] };

async function run(extra: Partial<RunDeps>): Promise<AgentReport> {
  return runAgent({ dryRun: false, now: new Date("2026-08-05T12:00:00Z"), deps: deps(extra) });
}

describe("boucle d'exécution", () => {
  it("n'émet qu'un seul execute non simulé et ne le réémet jamais pendant l'attente", async () => {
    // Deux tours non terminaux avant le statut final : l'agent doit attendre en
    // interrogeant le statut, pas en relançant l'exécution.
    const { client, calls } = makeClient([
      { status: "queued" },
      { status: "unconfirmed", transactionHash: TX },
      completed,
    ]);

    const report = await run({ createClient: () => client });

    const executes = calls.filter((c) => c.kind === "execute");
    expect(executes).toHaveLength(1);
    expect(report.execution?.executeCalls).toBe(1);
    expect(calls.filter((c) => c.kind === "status").length).toBeGreaterThan(1);
    expect(report.execution?.pollAttempts).toBe(3);
  });

  it("traite unconfirmed comme non terminal puis vérifie sur la chaîne", async () => {
    const { client } = makeClient([
      { status: "unconfirmed", transactionHash: TX },
      completed,
    ]);

    const report = await run({ createClient: () => client });

    expect(report.outcome).toBe("EXECUTED_VERIFIED");
    expect(report.verification?.verified).toBe(true);
    expect(report.execution?.timedOut).toBe(false);
  });

  it("rend PENDING quand le délai expire sans statut terminal", async () => {
    const { client, calls } = makeClient([{ status: "unconfirmed" }]);
    // L'horloge dépasse immédiatement l'échéance : un seul tour, puis abandon.
    let t = 0;
    const report = await run({
      createClient: () => client,
      nowMs: () => (t += 100_000),
      pollTimeoutMs: 1_000,
    });

    expect(report.outcome).toBe("EXECUTED_PENDING_VERIFICATION");
    expect(report.execution?.timedOut).toBe(true);
    // Invariant : le timeout ne déclenche aucune réémission.
    expect(calls.filter((c) => c.kind === "execute")).toHaveLength(1);
    expect(report.notes.join(" ")).toContain("aucune réémission");
  });

  it("ne déclare jamais verified si la transaction on-chain diverge", async () => {
    const { client } = makeClient([completed]);
    const wrong = goodEvidence();
    wrong.transferTo = "0x000000000000000000000000000000000000dead";
    wrong.transferValueRaw = "999999";

    const report = await run({ createClient: () => client, fetchChainEvidence: async () => wrong });

    expect(report.outcome).toBe("EXECUTED_PENDING_VERIFICATION");
    expect(report.verification?.verified).toBe(false);
    expect(report.verification?.failed).toContain("TRANSFER_TO_RECIPIENT");
    expect(report.verification?.failed).toContain("TRANSFER_AMOUNT");
  });

  it("suit la chaîne, pas le fournisseur, quand les deux se contredisent", async () => {
    // Le fournisseur affirme verified: true ; la chaîne montre un receipt échoué.
    const { client } = makeClient([completed]);
    const reverted = goodEvidence();
    reverted.receiptStatusOk = false;

    const report = await run({
      createClient: () => client,
      fetchChainEvidence: async () => reverted,
    });

    expect(report.execution?.providerVerified).toBe(true);
    expect(report.outcome).toBe("FAILED");
    expect(report.notes.join(" ")).toContain("Le rapport suit la chaîne");
  });

  it("ne déclare pas verified si une preuve on-chain est absente", async () => {
    const { client } = makeClient([completed]);
    const partial = goodEvidence();
    partial.allowanceConsumedRaw = null;
    partial.moduleExecutionSuccess = false;

    const report = await run({ createClient: () => client, fetchChainEvidence: async () => partial });

    expect(report.outcome).toBe("EXECUTED_PENDING_VERIFICATION");
    expect(report.verification?.missing).toContain("ALLOWANCE_CONSUMED_MATCHES_AMOUNT");
    expect(report.verification?.missing).toContain("MODULE_EXECUTION_SUCCESS");
  });

  it("échoue proprement sans executionId, sans réémettre", async () => {
    const { client, calls } = makeClient([completed], { ok: true });

    const report = await run({ createClient: () => client });

    expect(report.outcome).toBe("FAILED");
    expect(report.execution?.executionId).toBeNull();
    expect(calls.filter((c) => c.kind === "execute")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "status")).toHaveLength(0);
  });

  it("survit à une réponse MCP malformée", async () => {
    // Statut illisible : ni objet exploitable, ni hash. Aucun succès déclaré.
    const { client } = makeClient(["pas du json", null, 42]);

    const report = await run({ createClient: () => client, pollTimeoutMs: 0 });

    expect(report.outcome).toBe("EXECUTED_PENDING_VERIFICATION");
    expect(report.verification).toBeNull();
    expect(report.notes.join(" ")).toContain("Aucun hash de transaction");
  });

  it("ne déclare pas verified si la lecture RPC échoue", async () => {
    const { client } = makeClient([completed]);

    const report = await run({
      createClient: () => client,
      fetchChainEvidence: async () => {
        throw new Error("RPC eth_getTransactionReceipt HTTP 503");
      },
    });

    expect(report.outcome).toBe("EXECUTED_PENDING_VERIFICATION");
    expect(report.verification).toBeNull();
    expect(report.notes.join(" ")).toContain("Preuve on-chain illisible");
  });

  it("n'expose aucun secret dans le rapport", async () => {
    process.env.KEEPERHUB_API_KEY = SECRET;
    try {
      const { client } = makeClient([completed]);
      const report = await run({ createClient: () => client });
      expect(JSON.stringify(report)).not.toContain(SECRET);
      expect(JSON.stringify(report)).not.toContain("kh_");
    } finally {
      delete process.env.KEEPERHUB_API_KEY;
    }
  });

  it("compte réellement les appels d'exécution, sans valeur figée", async () => {
    // Le compteur doit refléter les appels observés : si `executeCalls` était
    // codé en dur, ce test ne pourrait pas distinguer un client instrumenté.
    const { client, calls } = makeClient([completed]);
    const report = await run({ createClient: () => client });
    const observed = calls.filter((c) => c.kind === "execute").length;
    expect(report.execution?.executeCalls).toBe(observed);
    expect(observed).toBe(1);
  });

  it("n'appelle jamais executeTransfer pendant une longue attente non terminale", async () => {
    // Sept réponses non terminales de formes variées, puis expiration du délai.
    // Aucune réponse ne porte de hash : rien n'est vérifiable, donc l'issue
    // reste PENDING et le test porte bien sur l'absence de réémission.
    const { client, calls } = makeClient([
      { status: "queued" },
      { status: "pending" },
      { status: "running" },
      { status: "unconfirmed" },
      { status: "unknown_future_status" },
      {},
      { status: null },
    ]);
    let t = 0;
    const report = await run({
      createClient: () => client,
      nowMs: () => (t += 1_000),
      pollTimeoutMs: 5_000,
    });

    const executes = calls.filter((c) => c.kind === "execute");
    const statuses = calls.filter((c) => c.kind === "status");
    expect(executes).toHaveLength(1);
    expect(statuses.length).toBeGreaterThan(1);
    // Tous les appels après le premier execute sont des lectures de statut.
    const afterExecute = calls.slice(calls.findIndex((c) => c.kind === "execute") + 1);
    expect(afterExecute.every((c) => c.kind === "status")).toBe(true);
    expect(report.execution?.timedOut).toBe(true);
    expect(report.outcome).toBe("EXECUTED_PENDING_VERIFICATION");
  });

  it("conserve le hash vu une fois, même si une réponse ultérieure l'omet", async () => {
    const { client } = makeClient([
      { status: "unconfirmed", transactionHash: TX },
      { status: "unconfirmed" }, // le hash disparaît de la réponse
      { status: "completed", receipts: [{ receiptStatus: "success", verified: true }] },
    ]);

    const report = await run({ createClient: () => client });

    expect(report.execution?.transactionHash).toBe(TX);
    expect(report.outcome).toBe("EXECUTED_VERIFIED");
  });

  it("traite un statut inconnu comme non terminal plutôt que comme un succès", async () => {
    const { client } = makeClient([{ status: "some_new_status", transactionHash: TX }]);
    let t = 0;
    const report = await run({
      createClient: () => client,
      nowMs: () => (t += 10_000),
      pollTimeoutMs: 1_000,
    });
    expect(report.execution?.timedOut).toBe(true);
    expect(report.outcome).toBe("EXECUTED_VERIFIED"); // la chaîne, elle, confirme
    expect(report.execution?.providerStatus).toBe("some_new_status");
  });

  it("distingue vérifié, indéterminé et échec par le code de sortie", () => {
    // Un appelant qui teste `exit 0` ne doit jamais confondre « je ne sais pas
    // encore » avec « c'est vérifié ».
    expect(exitCodeFor("EXECUTED_VERIFIED")).toBe(0);
    expect(exitCodeFor("NO_ACTION")).toBe(0);
    expect(exitCodeFor("DRY_RUN")).toBe(0);
    expect(exitCodeFor("EXECUTED_PENDING_VERIFICATION")).toBe(2);
    expect(exitCodeFor("FAILED")).toBe(1);
  });

  it("ne diffuse rien en dry-run", async () => {
    const { client, calls } = makeClient([completed]);
    const report = await runAgent({
      dryRun: true,
      now: new Date("2026-08-05T12:00:00Z"),
      deps: deps({ createClient: () => client }),
    });

    expect(report.outcome).toBe("DRY_RUN");
    expect(calls).toHaveLength(0);
  });
});
