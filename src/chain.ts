import { encodeFunctionData, parseAbi } from "viem";

import { ADDRESSES, CHAIN_ID, RECIPIENT, ROLE_KEY, RPC_URL } from "./config";

/**
 * Observation on-chain. L'agent lit l'état lui-même, en direct, par RPC —
 * jamais à travers le rapport d'un fournisseur. C'est le fondement du reste :
 * une décision prise sur des données déclaratives ne serait pas auditable.
 */

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

const ROLES_ABI = parseAbi([
  "function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert) returns (bool)",
]);

export type RpcCall = { method: string; params: unknown[] };

let rpcCallCount = 0;

export function rpcCallsMade(): number {
  return rpcCallCount;
}

async function rpc(
  method: string,
  params: unknown[],
): Promise<{ result?: unknown; error?: unknown }> {
  rpcCallCount += 1;
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcCallCount, method, params }),
  });
  if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status}`);
  return (await response.json()) as { result?: unknown; error?: unknown };
}

/** Enveloppe Roles complète pour un transfert ERC20 — identique à celle qu'exécute KeeperHub. */
export function buildRolesEnvelope(amountRaw: bigint): {
  inner: `0x${string}`;
  outer: `0x${string}`;
} {
  const inner = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [RECIPIENT, amountRaw],
  });
  const outer = encodeFunctionData({
    abi: ROLES_ABI,
    functionName: "execTransactionWithRole",
    args: [ADDRESSES.token, 0n, inner, 0, ROLE_KEY, true],
  });
  return { inner, outer };
}

/** `true` si la policy accepterait ce montant à l'instant présent. Lecture pure. */
export async function policyAccepts(amountRaw: bigint): Promise<boolean> {
  if (amountRaw <= 0n) return false;
  const { outer } = buildRolesEnvelope(amountRaw);
  const response = await rpc("eth_call", [
    { from: ADDRESSES.delegateEoa, to: ADDRESSES.rolesModifier, data: outer },
    "latest",
  ]);
  return !response.error;
}

export async function safeTokenBalance(): Promise<bigint> {
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [ADDRESSES.safe],
  });
  const response = await rpc("eth_call", [{ to: ADDRESSES.token, data }, "latest"]);
  if (response.error) throw new Error(`balanceOf a échoué : ${JSON.stringify(response.error)}`);
  return BigInt(response.result as string);
}

export async function chainId(): Promise<number> {
  const response = await rpc("eth_chainId", []);
  return Number.parseInt(response.result as string, 16);
}

export async function blockNumber(): Promise<number> {
  const response = await rpc("eth_blockNumber", []);
  return Number.parseInt(response.result as string, 16);
}

/**
 * Détermine l'allocation restante par recherche dichotomique sur `eth_call`.
 *
 * La policy Zodiac Roles n'expose pas de getter public d'allocation : on la
 * mesure donc par sondes, en cherchant le plus grand montant que le module
 * accepte encore. ~20 lectures, aucune écriture, aucun gas.
 *
 * `upperBound` doit être un montant refusé (borne haute exclusive).
 */
export async function measureRemainingAllowance(upperBound: bigint): Promise<bigint> {
  if (await policyAccepts(upperBound)) return upperBound; // l'allocation dépasse la borne
  let low = 0n;
  let high = upperBound;
  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    if (await policyAccepts(mid)) low = mid;
    else high = mid;
  }
  return low;
}

export type ChainObservation = {
  chainId: number;
  blockNumber: number;
  safeTokenBalanceRaw: bigint;
  remainingAllowanceRaw: bigint;
  observedAt: string;
};

export async function observe(upperBound: bigint, now: Date): Promise<ChainObservation> {
  const [id, block, balance] = await Promise.all([chainId(), blockNumber(), safeTokenBalance()]);
  if (id !== CHAIN_ID) {
    throw new Error(`RPC connecté à la chaîne ${id}, attendu ${CHAIN_ID}`);
  }
  const remaining = await measureRemainingAllowance(upperBound);
  return {
    chainId: id,
    blockNumber: block,
    safeTokenBalanceRaw: balance,
    remainingAllowanceRaw: remaining,
    observedAt: now.toISOString(),
  };
}
