import { decodeEventLog, parseAbi } from "viem";

import { NETWORK_TIMEOUT_MS, RPC_URL } from "./config";
import type { ChainEvidence } from "./reconcile";

/**
 * Preuves on-chain indépendantes, lues directement par RPC.
 *
 * Aucune donnée ne vient du fournisseur : c'est tout l'intérêt. Lecture seule.
 */

const EVENT_ABI = parseAbi([
  "event SafeModuleTransaction(address module, address to, uint256 value, bytes data, uint8 operation)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event ExecutionFromModuleSuccess(address indexed module)",
  "event ConsumeAllowance(bytes32 allowanceKey, uint128 consumed, uint128 newBalance)",
]);

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status}`);
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`RPC ${method} : ${body.error.message ?? "erreur"}`);
  return body.result ?? null;
}

const hexToNumber = (value: unknown): number | null =>
  typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) ? Number.parseInt(value, 16) : null;

const hexToDecimal = (value: unknown): string | null =>
  typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) ? BigInt(value).toString() : null;

/**
 * Lit la transaction et son receipt, puis décode les événements.
 * Renvoie `null` sur les champs absents plutôt que d'inventer une valeur.
 */
export async function fetchChainEvidence(transactionHash: string): Promise<ChainEvidence> {
  const [tx, receipt] = (await Promise.all([
    rpc("eth_getTransactionByHash", [transactionHash]),
    rpc("eth_getTransactionReceipt", [transactionHash]),
  ])) as [Record<string, unknown> | null, Record<string, unknown> | null];

  const chainIdHex = await rpc("eth_chainId", []);

  const evidence: ChainEvidence = {
    chainId: hexToNumber(chainIdHex),
    transactionHash: typeof receipt?.transactionHash === "string" ? receipt.transactionHash : null,
    receiptStatusOk: receipt ? receipt.status === "0x1" : null,
    blockNumber: hexToNumber(receipt?.blockNumber),
    gasUsed: hexToDecimal(receipt?.gasUsed),
    sender: typeof tx?.from === "string" ? tx.from : null,
    topLevelTo: typeof tx?.to === "string" ? tx.to : null,
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

  const logs = Array.isArray(receipt?.logs) ? (receipt.logs as Array<Record<string, unknown>>) : [];
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: EVENT_ABI,
        data: log.data as `0x${string}`,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      const args = decoded.args as Record<string, unknown>;
      const emitter = typeof log.address === "string" ? log.address : null;

      // Chaque événement est conservé AVEC son émetteur : un événement n'engage
      // que le contrat qui l'a émis. La vérification compare ensuite ces
      // adresses aux contrats attendus, de sorte qu'un log identique émis par un
      // autre contrat de la même transaction ne peut pas valider l'exécution.
      if (decoded.eventName === "Transfer") {
        // Premier Transfer retenu, pas le dernier : la sélection doit être
        // déterministe. Si un leurre précède le vrai transfert, les contrôles de
        // jeton, d'émetteur, de destinataire et de montant échouent — la
        // vérification se ferme, elle ne s'ouvre jamais par erreur.
        if (evidence.transferToken === null) {
          evidence.transferToken = emitter;
          evidence.transferFrom = typeof args.from === "string" ? args.from : null;
          evidence.transferTo = typeof args.to === "string" ? args.to : null;
          evidence.transferValueRaw = typeof args.value === "bigint" ? args.value.toString() : null;
        }
      } else if (decoded.eventName === "ExecutionFromModuleSuccess") {
        if (!evidence.moduleExecutionSuccess) {
          evidence.moduleExecutionSuccess = true;
          evidence.moduleSuccessEmitter = emitter;
        }
      } else if (decoded.eventName === "ConsumeAllowance") {
        if (evidence.allowanceConsumedRaw === null) {
          evidence.allowanceConsumedRaw =
            typeof args.consumed === "bigint" ? args.consumed.toString() : null;
          evidence.allowanceRemainingRaw =
            typeof args.newBalance === "bigint" ? args.newBalance.toString() : null;
          evidence.allowanceEmitter = emitter;
        }
      }
    } catch {
      // Log non reconnu : ignoré, jamais deviné.
    }
  }

  return evidence;
}
