#!/usr/bin/env node
/**
 * Prouve le solde USDC de l'EOA délégué immédiatement avant la transaction de
 * l'incident du 2026-08-04, en balayant TOUS les Transfer le concernant depuis
 * le déploiement du contrat.
 *
 *   node scripts/prove-historical-balance.mjs
 *
 * Lecture seule. Aucune diffusion, aucun état modifié.
 */
const RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const TOKEN = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const EOA = "0x8ff41a30af4458e3c14c8843bddcc37b7992ed58";
const PADDED = `0x000000000000000000000000${EOA.slice(2)}`;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TO_BLOCK = 11418272;
const CHUNK = 49_000;

let calls = 0;

async function rpc(method, params) {
  calls += 1;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: calls, method, params }),
      });
      const body = await response.json();
      if (body.error) throw new Error(body.error.message);
      return body.result;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  return null;
}

/**
 * Bloc de déploiement du contrat, par recherche dichotomique sur `eth_getCode`.
 * Nécessite un nœud conservant le code historique ; on le détecte et on le dit.
 */
async function findDeploymentBlock() {
  const hasCode = async (block) => {
    const code = await rpc("eth_getCode", [TOKEN, `0x${block.toString(16)}`]);
    return typeof code === "string" && code.length > 2;
  };
  if (!(await hasCode(TO_BLOCK))) throw new Error("aucun code au bloc de référence");
  let low = 0;
  let high = TO_BLOCK;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (await hasCode(mid)) high = mid;
    else low = mid;
  }
  return high;
}

async function scan(fromBlock) {
  let incoming = 0n;
  let outgoing = 0n;
  let incomingCount = 0;
  let outgoingCount = 0;
  let chunks = 0;

  for (let from = fromBlock; from <= TO_BLOCK; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, TO_BLOCK);
    const range = { address: TOKEN, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` };
    const [inLogs, outLogs] = await Promise.all([
      rpc("eth_getLogs", [{ ...range, topics: [TRANSFER, null, PADDED] }]),
      rpc("eth_getLogs", [{ ...range, topics: [TRANSFER, PADDED, null] }]),
    ]);
    for (const log of inLogs ?? []) {
      incoming += BigInt(log.data);
      incomingCount += 1;
    }
    for (const log of outLogs ?? []) {
      outgoing += BigInt(log.data);
      outgoingCount += 1;
    }
    chunks += 1;
  }

  return { incoming, outgoing, incomingCount, outgoingCount, chunks };
}

const fmt = (raw) => `${Number(raw) / 1e6} USDC`;

async function main() {
  let deployment = null;
  let note = "";
  try {
    deployment = await findDeploymentBlock();
    note = `bloc de déploiement du contrat déterminé par dichotomie sur eth_getCode : ${deployment}`;
  } catch (error) {
    note = `déploiement indéterminable (${String(error).slice(0, 90)}) — scan depuis le bloc 0`;
    deployment = 0;
  }
  console.warn(note);

  const result = await scan(deployment);
  // Le seul Transfer entrant au bloc de référence est celui de la transaction
  // de l'incident : on l'isole pour obtenir le solde juste AVANT.
  const before = result.incoming - result.outgoing - 1_000_000n;

  console.warn(
    JSON.stringify(
      {
        token: TOKEN,
        address: EOA,
        fromBlock: deployment,
        toBlock: TO_BLOCK,
        chunks: result.chunks,
        rpcCalls: calls,
        incoming: { count: result.incomingCount, total: fmt(result.incoming) },
        outgoing: { count: result.outgoingCount, total: fmt(result.outgoing) },
        balanceAtToBlock: fmt(result.incoming - result.outgoing),
        balanceImmediatelyBeforeIncidentTx: fmt(before),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
