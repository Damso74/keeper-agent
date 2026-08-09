import { formatUnits, TOKEN } from "./config";

/**
 * Règle de décision de l'agent.
 *
 * Fonction pure et totale : mêmes entrées → même décision, sans réseau, sans
 * horloge implicite, sans aléa, sans LLM. C'est ce qui la rend auditable — un
 * tiers peut rejouer la décision et obtenir exactement le même résultat.
 *
 * **Unicité du versement.** Cette fonction ne compte pas les versements déjà
 * effectués dans la fenêtre : elle n'a aucun état persistant à interroger, et un
 * compteur câblé à zéro serait un garde-fou décoratif. L'unicité repose
 * entièrement sur la **clé d'idempotence KeeperHub** — `drip-<fenêtre>-<montant>`,
 * stable par construction — qui fait qu'un second appel identique rejoue le
 * résultat d'origine au lieu d'émettre un second transfert. C'est une garantie
 * côté fournisseur, énoncée ici plutôt que simulée localement.
 */

export type DecisionInput = {
  remainingAllowanceRaw: bigint;
  safeTokenBalanceRaw: bigint;
  dripAmountRaw: bigint;
  safetyMarginRaw: bigint;
};

export type DecisionCode =
  | "DRIP"
  | "SKIP_ALLOWANCE_INSUFFICIENT"
  | "SKIP_SAFE_BALANCE_INSUFFICIENT"
  | "SKIP_AMOUNT_NOT_POSITIVE";

export type Decision = {
  act: boolean;
  code: DecisionCode;
  /** Explication lisible, construite depuis les valeurs observées. */
  reason: string;
  amountRaw: bigint;
};

export function decide(input: DecisionInput): Decision {
  const { remainingAllowanceRaw, safeTokenBalanceRaw, dripAmountRaw, safetyMarginRaw } = input;

  const amount = `${formatUnits(dripAmountRaw, TOKEN.decimals)} ${TOKEN.symbol}`;
  const remaining = `${formatUnits(remainingAllowanceRaw, TOKEN.decimals)} ${TOKEN.symbol}`;

  if (dripAmountRaw <= 0n) {
    return {
      act: false,
      code: "SKIP_AMOUNT_NOT_POSITIVE",
      reason: "Le montant de versement configuré n'est pas strictement positif.",
      amountRaw: dripAmountRaw,
    };
  }

  // La marge empêche d'épuiser l'allocation : on garde de la réserve pour les
  // opérations manuelles et pour la reprise en cas d'échec.
  if (remainingAllowanceRaw < dripAmountRaw + safetyMarginRaw) {
    return {
      act: false,
      code: "SKIP_ALLOWANCE_INSUFFICIENT",
      reason:
        `Allocation restante ${remaining} < versement ${amount} + marge ` +
        `${formatUnits(safetyMarginRaw, TOKEN.decimals)} ${TOKEN.symbol}.`,
      amountRaw: dripAmountRaw,
    };
  }

  if (safeTokenBalanceRaw < dripAmountRaw) {
    return {
      act: false,
      code: "SKIP_SAFE_BALANCE_INSUFFICIENT",
      reason:
        `Le Safe détient ${formatUnits(safeTokenBalanceRaw, TOKEN.decimals)} ${TOKEN.symbol}, ` +
        `insuffisant pour verser ${amount}.`,
      amountRaw: dripAmountRaw,
    };
  }

  return {
    act: true,
    code: "DRIP",
    reason: `Allocation restante ${remaining} et solde du Safe suffisants pour verser ${amount}.`,
    amountRaw: dripAmountRaw,
  };
}
