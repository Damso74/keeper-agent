#!/usr/bin/env node
import { ADDRESSES, CHAIN_ID, parseAmount, RECIPIENT } from "./config";
import { policyAccepts } from "./chain";
import { KeeperHubClient } from "./keeperhub";

/**
 * Compare, pour un montant donné, ce que le simulateur du fournisseur prédit et
 * ce que la policy on-chain accepte réellement.
 *
 *   npm run simulate -- 2
 *
 * Sert à démontrer le faux négatif de simulation : le simulateur modélise un
 * transfert direct depuis l'EOA délégué, alors que l'exécution passe par
 * Roles → Safe. Lecture seule, aucune diffusion.
 */
async function main(): Promise<void> {
  const amount = process.argv[2];
  if (!amount) {
    throw new Error("Usage : npm run simulate -- <montant en USDC>, ex. 2");
  }
  // Parsing décimal exact : pas de passage par un flottant, donc pas d'arrondi.
  const raw = parseAmount(amount);

  const chainAccepts = await policyAccepts(raw);

  const client = new KeeperHubClient();
  await client.connect();
  try {
    const result = await client.executeTransfer({
      chainId: CHAIN_ID,
      tokenAddress: ADDRESSES.token,
      toAddress: RECIPIENT,
      amount,
      idempotencyKey: `sim-probe-${raw}-${Date.now()}`,
      simulate: true,
    });
    const body = result.json as { wouldRevert?: boolean; revertReason?: string } | null;
    const providerWouldRevert = body?.wouldRevert ?? null;

    console.warn(`montant                         : ${amount} USDC`);
    console.warn(`policy on-chain accepte         : ${chainAccepts}`);
    console.warn(`simulateur prédit un revert     : ${providerWouldRevert}`);
    if (body?.revertReason) console.warn(`raison annoncée                 : ${body.revertReason}`);

    if (chainAccepts && providerWouldRevert === true) {
      console.warn("\n=> FAUX NÉGATIF DE SIMULATION reproduit :");
      console.warn("   le simulateur prédit un échec, la policy Safe accepte.");
    } else if (chainAccepts === false && providerWouldRevert === true) {
      console.warn("\n=> Les deux refusent : pas de divergence à ce montant.");
    } else {
      console.warn("\n=> Les deux acceptent : pas de divergence à ce montant.");
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
