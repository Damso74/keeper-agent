import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { KEEPERHUB_MCP_URL, requireApiKey } from "./config";

/**
 * Client MCP KeeperHub pour usage headless.
 *
 * Authentification par clé d'organisation (`kh_…`) en Bearer, conformément à la
 * documentation : l'OAuth navigateur y est explicitement déconseillée pour les
 * systèmes autonomes. La clé ne transite que par l'environnement et n'est
 * jamais journalisée.
 */

export type ToolResult = { raw: unknown; text: string; json: unknown | null };

/**
 * Extrait le corps JSON d'une réponse d'outil.
 *
 * KeeperHub renvoie les reverts de simulation en **HTTP 400**, avec le JSON
 * utile enveloppé dans un texte du type
 * `API call failed: 400 Bad Request - {"wouldRevert":true,...}`.
 * Ne lire que `JSON.parse(text)` fait perdre toute l'information de diagnostic —
 * précisément celle qui révèle le faux négatif de simulation.
 */
export function extractJson(text: string): unknown | null {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Corps JSON encapsulé dans un message d'erreur.
  }
  const start = text.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

export class KeeperHubClient {
  private client: Client | null = null;

  async connect(): Promise<void> {
    const apiKey = requireApiKey();
    const transport = new StreamableHTTPClientTransport(new URL(KEEPERHUB_MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
    });
    const client = new Client(
      { name: "treasury-drip-agent", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    this.client = client;
  }

  async listToolNames(): Promise<string[]> {
    const client = this.require();
    const listed = await client.listTools();
    return listed.tools.map((tool) => tool.name).sort();
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const client = this.require();
    const raw = await client.callTool({ name, arguments: args });
    const content = Array.isArray((raw as { content?: unknown }).content)
      ? ((raw as { content: Array<{ type?: string; text?: string }> }).content ?? [])
      : [];
    const text = content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n");
    return { raw, text, json: extractJson(text) };
  }

  /**
   * Diffuse un transfert. Aucun retry : une clé d'idempotence protège contre le
   * double effet, mais réémettre après un timeout reste une décision humaine.
   */
  async executeTransfer(input: {
    chainId: number;
    tokenAddress: string;
    toAddress: string;
    amount: string;
    idempotencyKey: string;
    simulate?: boolean;
  }): Promise<ToolResult> {
    const args: Record<string, unknown> = {
      chain_id: String(input.chainId),
      token_address: input.tokenAddress,
      to_address: input.toAddress,
      amount: input.amount,
      idempotency_key: input.idempotencyKey,
    };
    if (input.simulate) args.simulate = true;
    return this.call("execute_transfer", args);
  }

  async executionStatus(executionId: string): Promise<ToolResult> {
    return this.call("get_direct_execution_status", { execution_id: executionId });
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  private require(): Client {
    if (!this.client) throw new Error("KeeperHubClient : connect() n'a pas été appelé.");
    return this.client;
  }
}
