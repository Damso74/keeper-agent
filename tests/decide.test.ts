import { describe, expect, it } from "vitest";

import { currentWindow, idempotencyKey } from "../src/config";
import { decide, type DecisionInput } from "../src/decide";

const BASE: DecisionInput = {
  remainingAllowanceRaw: 4_000_000n, // 4 USDC
  safeTokenBalanceRaw: 4_000_000n,
  dripAmountRaw: 100_000n, // 0,1 USDC
  safetyMarginRaw: 50_000n,
  dripsThisWindow: 0,
};

describe("règle de décision", () => {
  it("verse quand allocation et solde le permettent", () => {
    const decision = decide(BASE);
    expect(decision.act).toBe(true);
    expect(decision.code).toBe("DRIP");
    expect(decision.reason).toContain("4 USDC");
  });

  it("s'abstient si un versement a déjà eu lieu dans la fenêtre", () => {
    const decision = decide({ ...BASE, dripsThisWindow: 1 });
    expect(decision.act).toBe(false);
    expect(decision.code).toBe("SKIP_ALREADY_DRIPPED_THIS_WINDOW");
  });

  it("s'abstient si l'allocation ne couvre pas le versement plus la marge", () => {
    // 0,12 USDC restants : couvre le versement (0,1) mais pas la marge (0,05).
    const decision = decide({ ...BASE, remainingAllowanceRaw: 120_000n });
    expect(decision.act).toBe(false);
    expect(decision.code).toBe("SKIP_ALLOWANCE_INSUFFICIENT");
  });

  it("accepte exactement au seuil versement + marge", () => {
    const decision = decide({ ...BASE, remainingAllowanceRaw: 150_000n });
    expect(decision.act).toBe(true);
  });

  it("s'abstient si le Safe ne détient pas assez de jetons", () => {
    const decision = decide({ ...BASE, safeTokenBalanceRaw: 50_000n });
    expect(decision.act).toBe(false);
    expect(decision.code).toBe("SKIP_SAFE_BALANCE_INSUFFICIENT");
  });

  it("refuse un montant nul ou négatif", () => {
    expect(decide({ ...BASE, dripAmountRaw: 0n }).code).toBe("SKIP_AMOUNT_NOT_POSITIVE");
  });

  it("est déterministe : mêmes entrées, même décision", () => {
    const a = decide(BASE);
    const b = decide({ ...BASE });
    expect(a).toEqual(b);
  });

  it("expose toujours une raison lisible", () => {
    for (const input of [
      BASE,
      { ...BASE, dripsThisWindow: 2 },
      { ...BASE, remainingAllowanceRaw: 0n },
      { ...BASE, safeTokenBalanceRaw: 0n },
    ]) {
      expect(decide(input).reason.length).toBeGreaterThan(10);
    }
  });
});

describe("idempotence", () => {
  it("produit la même clé du lundi au dimanche de la même semaine", () => {
    const monday = new Date("2026-08-03T00:00:00Z");
    const friday = new Date("2026-08-07T18:00:00Z");
    const sunday = new Date("2026-08-09T23:59:59Z");
    expect(currentWindow(friday)).toBe(currentWindow(monday));
    expect(currentWindow(sunday)).toBe(currentWindow(monday));
    expect(idempotencyKey(currentWindow(monday), 100_000n)).toBe(
      idempotencyKey(currentWindow(sunday), 100_000n),
    );
  });

  it("bascule de fenêtre au lundi 00:00 UTC, pas ailleurs", () => {
    const sundayLate = new Date("2026-08-09T23:59:59Z");
    const mondayEarly = new Date("2026-08-10T00:00:01Z");
    expect(currentWindow(mondayEarly)).not.toBe(currentWindow(sundayLate));
  });

  it("change de clé si le montant change", () => {
    const w = currentWindow(new Date("2026-08-05T12:00:00Z"));
    expect(idempotencyKey(w, 100_000n)).not.toBe(idempotencyKey(w, 200_000n));
  });
});
