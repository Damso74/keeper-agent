import { describe, expect, it } from "vitest";

import { ADDRESSES, CHAIN_ID, RECIPIENT } from "../src/config";
import type { ChainEvidence, Expectations } from "../src/reconcile";
import { verifyExecution } from "../src/verify";

/**
 * Tests négatifs de provenance.
 *
 * Un événement n'engage que le contrat qui l'émet. Ces cas vérifient qu'un log
 * au bon format mais émis par un **autre** contrat de la même transaction ne
 * peut jamais valider l'exécution.
 */

const TX = "0xe7e67b3ab83e1af1f5d130d3c33dbe945cf015da8fb082020b24c253a8eb5062";
const AMOUNT = 100_000n;
const IMPOSTOR = "0x00000000000000000000000000000000deadbeef";

const expected: Expectations = {
  safe: ADDRESSES.safe,
  rolesModifier: ADDRESSES.rolesModifier,
  delegateEoa: ADDRESSES.delegateEoa,
  token: ADDRESSES.token,
  recipient: RECIPIENT,
  chainId: CHAIN_ID,
};

function evidence(overrides: Partial<ChainEvidence> = {}): ChainEvidence {
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
    transferValueRaw: AMOUNT.toString(),
    moduleExecutionSuccess: true,
    allowanceConsumedRaw: AMOUNT.toString(),
    allowanceRemainingRaw: "3900000",
    moduleSuccessEmitter: ADDRESSES.safe,
    allowanceEmitter: ADDRESSES.rolesModifier,
    ...overrides,
  };
}

const run = (e: ChainEvidence) =>
  verifyExecution({ evidence: e, expected, amountRaw: AMOUNT, expectedTransactionHash: TX });

describe("vérification on-chain — cas nominal", () => {
  it("valide une preuve complète et cohérente", () => {
    const result = run(evidence());
    expect(result.verified).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.missing).toEqual([]);
  });
});

describe("provenance des événements — émetteurs incorrects", () => {
  it("refuse ExecutionFromModuleSuccess émis par un autre contrat", () => {
    const result = run(evidence({ moduleSuccessEmitter: IMPOSTOR }));
    expect(result.verified).toBe(false);
    expect(result.failed).toContain("MODULE_SUCCESS_EMITTED_BY_SAFE");
  });

  it("refuse ConsumeAllowance émis par un autre contrat", () => {
    // Le montant consommé est correct : seul l'émetteur est faux. Sans contrôle
    // de provenance, ce cas passait la vérification.
    const result = run(evidence({ allowanceEmitter: IMPOSTOR }));
    expect(result.verified).toBe(false);
    expect(result.failed).toContain("ALLOWANCE_EMITTED_BY_ROLES_MODIFIER");
  });

  it("refuse ConsumeAllowance émis par le Safe plutôt que le Roles Modifier", () => {
    const result = run(evidence({ allowanceEmitter: ADDRESSES.safe }));
    expect(result.verified).toBe(false);
    expect(result.failed).toContain("ALLOWANCE_EMITTED_BY_ROLES_MODIFIER");
  });

  it("refuse un Transfer émis par un jeton inattendu", () => {
    const result = run(evidence({ transferToken: IMPOSTOR }));
    expect(result.verified).toBe(false);
    expect(result.failed).toContain("TOKEN");
  });

  it("refuse un Transfer qui ne part pas du Safe", () => {
    const result = run(evidence({ transferFrom: IMPOSTOR }));
    expect(result.verified).toBe(false);
    expect(result.failed).toContain("TRANSFER_FROM_SAFE");
  });

  it("refuse une cible de premier niveau qui n'est pas le Roles Modifier", () => {
    const result = run(evidence({ topLevelTo: ADDRESSES.safe }));
    expect(result.verified).toBe(false);
    expect(result.failed).toContain("TOP_LEVEL_IS_ROLES_MODIFIER");
  });

  it("refuse un sender qui n'est pas l'EOA délégué", () => {
    const result = run(evidence({ sender: IMPOSTOR }));
    expect(result.verified).toBe(false);
    expect(result.failed).toContain("SENDER_IS_DELEGATE_EOA");
  });

  it("refuse un hash différent de celui annoncé", () => {
    const other = `0x${"11".repeat(32)}`;
    const result = run(evidence({ transactionHash: other }));
    expect(result.verified).toBe(false);
    expect(result.failed).toContain("TRANSACTION_HASH");
  });

  it("refuse une mauvaise chaîne", () => {
    const result = run(evidence({ chainId: 1 }));
    expect(result.verified).toBe(false);
    expect(result.failed).toContain("CHAIN_ID");
  });

  it("refuse une allocation consommée différente du montant transféré", () => {
    const result = run(evidence({ allowanceConsumedRaw: "1" }));
    expect(result.verified).toBe(false);
    expect(result.failed).toContain("ALLOWANCE_CONSUMED_MATCHES_AMOUNT");
  });
});

describe("preuves absentes", () => {
  it("classe un émetteur manquant en 'missing', jamais en succès", () => {
    const result = run(evidence({ moduleSuccessEmitter: null, allowanceEmitter: null }));
    expect(result.verified).toBe(false);
    expect(result.missing).toContain("MODULE_SUCCESS_EMITTED_BY_SAFE");
    expect(result.missing).toContain("ALLOWANCE_EMITTED_BY_ROLES_MODIFIER");
  });

  it("ne valide jamais un receipt échoué", () => {
    const result = run(evidence({ receiptStatusOk: false }));
    expect(result.verified).toBe(false);
    expect(result.failed).toContain("RECEIPT_STATUS_SUCCESS");
  });

  it("une preuve entièrement absente ne produit aucun succès", () => {
    const empty: ChainEvidence = {
      chainId: null,
      transactionHash: null,
      receiptStatusOk: null,
      blockNumber: null,
      gasUsed: null,
      sender: null,
      topLevelTo: null,
      transferToken: null,
      transferFrom: null,
      transferTo: null,
      transferValueRaw: null,
      moduleExecutionSuccess: false,
      allowanceConsumedRaw: null,
      allowanceRemainingRaw: null,
      moduleSuccessEmitter: null,
      allowanceEmitter: null,
    };
    const result = run(empty);
    expect(result.verified).toBe(false);
    expect(result.failed).toEqual([]);
    expect(result.missing.length).toBeGreaterThan(8);
  });
});
