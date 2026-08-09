import { afterEach, describe, expect, it, vi } from "vitest";

import { observe } from "../src/chain";
import { CHAIN_ID } from "../src/config";

/**
 * Cohérence de l'observation.
 *
 * L'agent lit un bloc, puis épingle toutes ses lectures dessus. Enchaîner des
 * lectures `latest` produirait un état composite — solde au bloc N, allocation
 * mesurée sur N+1..N+20 — qui n'a jamais existé simultanément.
 */

const BLOCK = 11_424_015;
const BLOCK_HEX = `0x${BLOCK.toString(16)}`;

type Captured = { method: string; blockTag: unknown };

/**
 * Stub RPC : répond `eth_chainId`, `eth_blockNumber`, et accepte tout `eth_call`
 * en dessous d'une allocation simulée, ce qui fait converger la dichotomie.
 */
function stubRpc(): Captured[] {
  const captured: Captured[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const { method, params } = JSON.parse(init.body) as {
        method: string;
        params: unknown[];
      };
      captured.push({ method, blockTag: Array.isArray(params) ? params[1] : undefined });

      if (method === "eth_chainId") {
        return jsonResponse({ result: `0x${CHAIN_ID.toString(16)}` });
      }
      if (method === "eth_blockNumber") {
        return jsonResponse({ result: BLOCK_HEX });
      }
      if (method === "eth_call") {
        const call = (params as [{ to?: string; data?: string }])[0];
        // balanceOf -> renvoie un solde ; execTransactionWithRole -> accepte ou
        // refuse selon un plafond, pour piloter la recherche dichotomique.
        const data = call?.data ?? "";
        if (data.startsWith("0x70a08231")) {
          return jsonResponse({ result: `0x${(19_000_000n).toString(16)}` });
        }
        // Le montant sondé est le second argument du `transfer(address,uint256)`
        // encapsulé dans l'enveloppe Roles : on le lit après le sélecteur ERC20.
        const inner = data.indexOf("a9059cbb");
        const amount =
          inner === -1 ? 0n : BigInt(`0x${data.slice(inner + 8 + 64, inner + 8 + 128)}`);
        return amount <= 4_000_000n
          ? jsonResponse({ result: "0x" })
          : jsonResponse({ error: { message: "AllowanceExceeded" } });
      }
      return jsonResponse({ result: null });
    }),
  );

  return captured;
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("observation épinglée sur un bloc", () => {
  it("adresse chaque eth_call au bloc lu au départ, jamais à 'latest'", async () => {
    const captured = stubRpc();

    const observation = await observe(5_000_000n, new Date("2026-08-05T00:00:00Z"));

    expect(observation.blockNumber).toBe(BLOCK);
    expect(observation.chainId).toBe(CHAIN_ID);

    const calls = captured.filter((c) => c.method === "eth_call");
    expect(calls.length).toBeGreaterThan(5); // solde + sondes de dichotomie

    // L'assertion qui compte : TOUS les eth_call portent exactement ce bloc.
    const tags = new Set(calls.map((c) => String(c.blockTag)));
    expect([...tags]).toEqual([BLOCK_HEX]);
    expect(tags.has("latest")).toBe(false);
  });

  it("mesure une allocation cohérente avec le plafond simulé", async () => {
    stubRpc();
    const observation = await observe(5_000_000n, new Date("2026-08-05T00:00:00Z"));
    expect(observation.remainingAllowanceRaw).toBe(4_000_000n);
    expect(observation.safeTokenBalanceRaw).toBe(19_000_000n);
  });

  it("refuse une chaîne inattendue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const { method } = JSON.parse(init.body) as { method: string };
        if (method === "eth_chainId") return jsonResponse({ result: "0x1" }); // mainnet
        return jsonResponse({ result: BLOCK_HEX });
      }),
    );

    await expect(observe(5_000_000n, new Date())).rejects.toThrow(/attendu/);
  });
});
