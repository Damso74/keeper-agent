import type { ChainEvidence, Expectations } from "./reconcile";

/**
 * Vérification on-chain indépendante d'une exécution.
 *
 * Fonction pure : elle ne reçoit que des preuves RPC (`ChainEvidence`) et la
 * configuration attendue. **Aucun champ du fournisseur n'entre ici.** C'est la
 * différence entre « KeeperHub dit que c'est vérifié » et « la chaîne le
 * montre » — la première affirmation ne peut pas valider une exécution.
 *
 * Règle : une preuve absente ne vaut pas une preuve fausse, mais ni l'une ni
 * l'autre ne produit `verified: true`.
 */

export type VerificationCheck = {
  id: string;
  ok: boolean;
  /** Ce que la chaîne montre, ou `null` si la preuve est absente. */
  observed: string | null;
  expected: string | null;
};

export type Verification = {
  verified: boolean;
  checks: VerificationCheck[];
  /** Contrôles qui divergent de l'attendu. */
  failed: string[];
  /** Contrôles dont la preuve est absente. */
  missing: string[];
};

export type VerificationInput = {
  evidence: ChainEvidence;
  expected: Expectations;
  /** Montant attendu, en unités brutes. */
  amountRaw: bigint;
  /** Hash annoncé par le fournisseur, comparé à celui du receipt lu par RPC. */
  expectedTransactionHash: string | null;
};

const eq = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

function check(
  id: string,
  observed: string | null,
  expected: string | null,
  ok: boolean,
): VerificationCheck {
  return { id, ok, observed, expected };
}

export function verifyExecution(input: VerificationInput): Verification {
  const { evidence, expected, amountRaw, expectedTransactionHash } = input;
  const amount = amountRaw.toString();
  const checks: VerificationCheck[] = [];

  checks.push(
    check(
      "RECEIPT_STATUS_SUCCESS",
      evidence.receiptStatusOk === null ? null : evidence.receiptStatusOk ? "success" : "failed",
      "success",
      evidence.receiptStatusOk === true,
    ),
  );

  checks.push(
    check(
      "CHAIN_ID",
      evidence.chainId === null ? null : String(evidence.chainId),
      String(expected.chainId),
      evidence.chainId === expected.chainId,
    ),
  );

  // Le hash lu sur la chaîne doit être celui que le fournisseur a annoncé : sans
  // cela on vérifierait consciencieusement une transaction sans rapport.
  checks.push(
    check(
      "TRANSACTION_HASH",
      evidence.transactionHash,
      expectedTransactionHash,
      eq(evidence.transactionHash, expectedTransactionHash),
    ),
  );

  checks.push(
    check(
      "SENDER_IS_DELEGATE_EOA",
      evidence.sender,
      expected.delegateEoa,
      eq(evidence.sender, expected.delegateEoa),
    ),
  );

  checks.push(
    check(
      "TOP_LEVEL_IS_ROLES_MODIFIER",
      evidence.topLevelTo,
      expected.rolesModifier,
      eq(evidence.topLevelTo, expected.rolesModifier),
    ),
  );

  checks.push(
    check("TOKEN", evidence.transferToken, expected.token, eq(evidence.transferToken, expected.token)),
  );

  checks.push(
    check(
      "TRANSFER_FROM_SAFE",
      evidence.transferFrom,
      expected.safe,
      eq(evidence.transferFrom, expected.safe),
    ),
  );

  checks.push(
    check(
      "TRANSFER_TO_RECIPIENT",
      evidence.transferTo,
      expected.recipient,
      eq(evidence.transferTo, expected.recipient),
    ),
  );

  checks.push(
    check(
      "TRANSFER_AMOUNT",
      evidence.transferValueRaw,
      amount,
      evidence.transferValueRaw !== null && BigInt(evidence.transferValueRaw) === amountRaw,
    ),
  );

  checks.push(
    check(
      "MODULE_EXECUTION_SUCCESS",
      evidence.moduleExecutionSuccess ? "ExecutionFromModuleSuccess" : null,
      "ExecutionFromModuleSuccess",
      evidence.moduleExecutionSuccess,
    ),
  );

  // Provenance : l'événement doit venir du Safe attendu. Sans ce contrôle,
  // n'importe quel contrat de la transaction pourrait émettre le même log.
  checks.push(
    check(
      "MODULE_SUCCESS_EMITTED_BY_SAFE",
      evidence.moduleSuccessEmitter ?? null,
      expected.safe,
      eq(evidence.moduleSuccessEmitter ?? null, expected.safe),
    ),
  );

  // L'allocation consommée doit égaler le montant transféré : une policy qui
  // décompte autre chose que ce qui est parti est une divergence, pas un détail.
  checks.push(
    check(
      "ALLOWANCE_CONSUMED_MATCHES_AMOUNT",
      evidence.allowanceConsumedRaw,
      amount,
      evidence.allowanceConsumedRaw !== null &&
        BigInt(evidence.allowanceConsumedRaw) === amountRaw,
    ),
  );

  // Provenance : la consommation d'allocation n'a de sens que si elle est
  // annoncée par le Roles Modifier qui applique réellement la policy.
  checks.push(
    check(
      "ALLOWANCE_EMITTED_BY_ROLES_MODIFIER",
      evidence.allowanceEmitter ?? null,
      expected.rolesModifier,
      eq(evidence.allowanceEmitter ?? null, expected.rolesModifier),
    ),
  );

  const failed = checks.filter((c) => !c.ok && c.observed !== null).map((c) => c.id);
  const missing = checks.filter((c) => !c.ok && c.observed === null).map((c) => c.id);

  return {
    // Exigence stricte : chaque contrôle doit passer. Une absence n'est jamais
    // convertie en succès.
    verified: checks.every((c) => c.ok),
    checks,
    failed,
    missing,
  };
}
