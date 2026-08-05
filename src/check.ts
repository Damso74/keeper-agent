#!/usr/bin/env node
import { chainId, blockNumber } from "./chain";
import { KeeperHubClient } from "./keeperhub";

/**
 * Vérification de connectivité, sans aucune écriture.
 *
 *   npm run check
 *
 * Confirme que la clé API KeeperHub authentifie et que le RPC répond, avant
 * d'engager quoi que ce soit.
 */
async function main(): Promise<void> {
  const id = await chainId();
  const block = await blockNumber();
  console.warn(`RPC OK — chaîne ${id}, bloc ${block}`);

  const client = new KeeperHubClient();
  await client.connect();
  try {
    const names = await client.listToolNames();
    console.warn(`KeeperHub OK — ${names.length} outils exposés`);
    for (const required of ["execute_transfer", "get_direct_execution_status"]) {
      console.warn(`  ${names.includes(required) ? "✓" : "✗"} ${required}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
