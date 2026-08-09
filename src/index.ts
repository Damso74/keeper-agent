#!/usr/bin/env node
import { exitCodeFor, runAgent } from "./run";

/**
 * Treasury Drip Agent — point d'entrée.
 *
 *   npm run agent              observe et décide, ne diffuse rien
 *   npm run agent -- --execute observe, décide, exécute via KeeperHub
 *
 * La diffusion n'est jamais le comportement par défaut.
 */
async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");

  const report = await runAgent({ dryRun: !execute });

  // Contrat de sortie : le rapport JSON, et rien d'autre, sur stdout — il doit
  // pouvoir être redirigé vers `jq` ou un fichier sans être pollué. Les
  // diagnostics vont sur stderr.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  // 0 vérifié / sans action · 1 échec constaté · 2 indéterminé (à ne pas
  // confondre avec un succès).
  process.exitCode = exitCodeFor(report.outcome);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
