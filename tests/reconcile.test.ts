import { describe, expect, it } from "vitest";

import { normalizeAudit } from "../src/audit";
import { ADDRESSES, CHAIN_ID, RECIPIENT } from "../src/config";
import { reconcile, type ChainEvidence, type Expectations } from "../src/reconcile";

/**
 * Fixtures dérivées de l'exécution autonome réelle du 2026-08-05
 * (executionId no623hdfsrun2vzv3b25r).
 */

const TX = "0xe7e67b3ab83e1af1f5d130d3c33dbe945cf015da8fb082020b24c253a8eb5062";

const EXPECTED: Expectations = {
  safe: ADDRESSES.safe,
  rolesModifier: ADDRESSES.rolesModifier,
  delegateEoa: ADDRESSES.delegateEoa,
  token: ADDRESSES.token,
  recipient: RECIPIENT,
  chainId: CHAIN_ID,
};

function directStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    executionId: "no623hdfsrun2vzv3b25r",
    status: "completed",
    type: "transfer",
    transactionHash: TX,
    transactionLink: `https://sepolia.etherscan.io/tx/${TX}`,
    sponsored: false,
    receipts: [
      {
        hash: TX,
        chainId: 11155111,
        gasUsed: "119267",
        verified: true,
        verifiedAt: "2026-08-05T11:25:40.000Z",
        blockNumber: 11424015,
        receiptStatus: "success",
      },
    ],
    result: {
      amount: "0.1",
      symbol: "USDC",
      chainId: 11155111,
      success: true,
      executedCall: {
        args: { to: ADDRESSES.delegateEoa, value: "100000" },
        reverted: false,
        sponsored: false,
        topLevelTo: ADDRESSES.rolesModifier,
        functionName: "transfer",
        contractAddress: ADDRESSES.token,
      },
    },
    gasUsedWei: "137539000000000",
    gasPriceWei: "1152433672",
    retryCount: 0,
    createdAt: "2026-08-05T11:25:20.000Z",
    completedAt: "2026-08-05T11:25:40.000Z",
    ...overrides,
  };
}

function chainEvidence(overrides: Partial<ChainEvidence> = {}): ChainEvidence {
  return {
    chainId: 11155111,
    transactionHash: TX,
    receiptStatusOk: true,
    blockNumber: 11424015,
    gasUsed: "119267",
    sender: ADDRESSES.delegateEoa,
    topLevelTo: ADDRESSES.rolesModifier,
    transferToken: ADDRESSES.token,
    transferFrom: ADDRESSES.safe,
    transferTo: ADDRESSES.delegateEoa,
    transferValueRaw: "100000",
    moduleExecutionSuccess: true,
    allowanceConsumedRaw: "100000",
    allowanceRemainingRaw: "3900000",
    ...overrides,
  };
}

const run = (status: unknown, chain: ChainEvidence, simulation?: unknown) =>
  reconcile(normalizeAudit({ directStatus: status, simulation }), chain, EXPECTED);

describe("1 — correspondance complète", () => {
  it("rend MATCH_WITH_PROVIDER_WARNINGS : la chaîne concorde, le fournisseur n'expose pas la policy", () => {
    const result = run(directStatus(), chainEvidence());
    expect(result.mismatches).toEqual([]);
    expect(result.missing).toEqual([]);
    // Le journal fournisseur ne mentionne jamais l'allocation : avertissement légitime.
    expect(result.warnings).toContain("POLICY_DISCLOSED_BY_PROVIDER");
    expect(result.verdict).toBe("MATCH_WITH_PROVIDER_WARNINGS");
  });

  it("atteint MATCH quand le fournisseur expose aussi l'allocation", () => {
    const withAllowance = directStatus({ allowanceConsumed: "100000" });
    const result = run(withAllowance, chainEvidence());
    expect(result.verdict).toBe("MATCH");
    expect(result.warnings).toEqual([]);
  });
});

describe("2 — hash de transaction différent", () => {
  it("rend MISMATCH", () => {
    const result = run(directStatus(), chainEvidence({ transactionHash: `0x${"a".repeat(64)}` }));
    expect(result.mismatches).toContain("TRANSACTION_HASH");
    expect(result.verdict).toBe("MISMATCH");
  });
});

describe("3 — receipt non vérifié", () => {
  it("un receipt en échec on-chain contredit le statut fournisseur", () => {
    const result = run(directStatus(), chainEvidence({ receiptStatusOk: false }));
    expect(result.mismatches).toContain("RECEIPT_STATUS");
    expect(result.verdict).toBe("MISMATCH");
  });

  it("un receipt absent ne devient jamais un succès", () => {
    const result = run(
      directStatus(),
      chainEvidence({ receiptStatusOk: null, blockNumber: null, gasUsed: null }),
    );
    expect(result.verdict).toBe("EVIDENCE_MISSING");
    expect(result.verdict).not.toBe("MATCH");
  });
});

describe("4 — audit indisponible ou incomplet", () => {
  it("un journal vide donne EVIDENCE_MISSING", () => {
    const result = run(null, chainEvidence());
    expect(result.verdict).toBe("EVIDENCE_MISSING");
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it("un journal sans receipt donne EVIDENCE_MISSING", () => {
    const result = run(directStatus({ receipts: [] }), chainEvidence());
    expect(result.verdict).toBe("EVIDENCE_MISSING");
  });

  it("un journal partiel ne peut pas produire MATCH", () => {
    const result = run(directStatus({ result: null }), chainEvidence());
    expect(["EVIDENCE_MISSING", "MISMATCH"]).toContain(result.verdict);
  });
});

describe("5 — panne ou timeout du fournisseur", () => {
  it("aucune réponse exploitable : EVIDENCE_MISSING, jamais MATCH", () => {
    for (const broken of [null, undefined, "timeout", 42, []]) {
      const result = run(broken, chainEvidence());
      expect(result.verdict).toBe("EVIDENCE_MISSING");
    }
  });

  it("les preuves on-chain restent lisibles même sans journal fournisseur", () => {
    const result = run(null, chainEvidence());
    const transferFromSafe = result.checks.find((c) => c.id === "TRANSFER_FROM_SAFE");
    expect(transferFromSafe?.status).toBe("MATCH");
  });
});

describe("6 — incohérence sponsored", () => {
  it("détecte la contradiction entre les deux niveaux", () => {
    const contradictory = directStatus({
      sponsored: false,
      result: { ...(directStatus().result as Record<string, unknown>) },
    });
    const executedCall = (contradictory.result as Record<string, unknown>).executedCall as Record<
      string,
      unknown
    >;
    executedCall.sponsored = true;

    const audit = normalizeAudit({ directStatus: contradictory });
    expect(audit.sponsored).toEqual({ root: false, executedCall: true, inconsistent: true });

    const result = reconcile(audit, chainEvidence(), EXPECTED);
    expect(result.warnings).toContain("SPONSORED_CONSISTENCY");
    expect(result.verdict).toBe("MATCH_WITH_PROVIDER_WARNINGS");
  });

  it("ne signale rien quand les deux niveaux concordent", () => {
    const audit = normalizeAudit({ directStatus: directStatus() });
    expect(audit.sponsored.inconsistent).toBe(false);
  });
});

describe("7 — rejeu idempotent", () => {
  it("est signalé comme avertissement, pas comme nouvelle exécution", () => {
    const audit = normalizeAudit({ directStatus: directStatus({ idempotentReplay: true }) });
    expect(audit.idempotentReplay).toBe(true);

    const result = reconcile(audit, chainEvidence(), EXPECTED);
    expect(result.warnings).toContain("IDEMPOTENT_REPLAY");
    expect(result.verdict).toBe("MATCH_WITH_PROVIDER_WARNINGS");
  });
});

describe("faux négatif de simulation", () => {
  it("un échec prédit suivi d'une exécution réussie déclenche un avertissement", () => {
    const result = run(directStatus(), chainEvidence(), {
      wouldRevert: true,
      revertReason: "Error(ERC20: transfer amount exceeds balance)",
    });
    expect(result.warnings).toContain("SIMULATION_FALSE_NEGATIVE");
    expect(result.verdict).toBe("MATCH_WITH_PROVIDER_WARNINGS");
  });
});

describe("invariants", () => {
  it("une divergence prime toujours sur une absence", () => {
    const result = run(
      directStatus({ receipts: [] }),
      chainEvidence({ transactionHash: `0x${"b".repeat(64)}` }),
    );
    expect(result.verdict).toBe("MISMATCH");
  });

  it("aucune combinaison d'absences ne produit MATCH", () => {
    for (const chain of [
      chainEvidence({ transferFrom: null }),
      chainEvidence({ allowanceConsumedRaw: null }),
      chainEvidence({ moduleExecutionSuccess: false }),
      chainEvidence({ chainId: null }),
    ]) {
      expect(run(directStatus(), chain).verdict).not.toBe("MATCH");
    }
  });

  it("est déterministe", () => {
    const a = run(directStatus(), chainEvidence());
    const b = run(directStatus(), chainEvidence());
    expect(a).toEqual(b);
  });

  it("n'expose jamais la clé API dans sa sortie", () => {
    const audit = normalizeAudit({ directStatus: directStatus() });
    expect(JSON.stringify(audit)).not.toMatch(/kh_[A-Za-z0-9]/);
  });
});
