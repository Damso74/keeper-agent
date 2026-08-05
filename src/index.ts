#!/usr/bin/env node
import { runAgent } from "./run";

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
  console.warn(JSON.stringify(report, null, 2));

  if (report.outcome === "FAILED") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
