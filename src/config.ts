import { getAddress } from "viem";

/**
 * Configuration du Treasury Drip Agent.
 *
 * Toutes les adresses sont celles du Safe réel utilisé pour le hackathon.
 * Rien de secret ici : seule `KEEPERHUB_API_KEY` est sensible, et elle vient
 * exclusivement de l'environnement.
 */

export const CHAIN_ID = 11155111; // Ethereum Sepolia

export const ADDRESSES = {
  safe: getAddress("0xf0Fe18E660A661EE17E6d1cA5F12243E23c544d1"),
  rolesModifier: getAddress("0x21e92b6825b6f8d31547c650974477938bc1acc8"),
  delegateEoa: getAddress("0x8FF41A30af4458E3C14C8843BDDcc37B7992ED58"),
  token: getAddress("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"),
} as const;

/** Destinataire autorisé par la policy Roles. */
export const RECIPIENT = ADDRESSES.delegateEoa;

export const ROLE_KEY =
  "0x11bd50d6cff2880f8ee05f1240131ccf849f18fe234d3da964282c27a9c28142" as const;

export const TOKEN = { symbol: "USDC", decimals: 6 } as const;

/**
 * Montant d'un versement : 0,1 USDC.
 * Volontairement micro — l'allocation hebdomadaire restante est limitée et les
 * reprises de tournage puisent dans la même enveloppe.
 */
export const DRIP_AMOUNT_RAW = 100_000n;

/** Marge de sécurité : on n'épuise jamais l'allocation jusqu'au dernier wei. */
export const SAFETY_MARGIN_RAW = 50_000n;

export const RPC_URL = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

export const KEEPERHUB_MCP_URL = process.env.KEEPERHUB_MCP_URL ?? "https://app.keeperhub.com/mcp";

/** Toute requête réseau est bornée : un endpoint muet ne doit pas figer l'agent. */
export const NETWORK_TIMEOUT_MS = Number(process.env.KEEPER_NETWORK_TIMEOUT_MS ?? 15_000);

/**
 * Refuse d'envoyer la clé ailleurs que sur un canal chiffré.
 *
 * `localhost` est toléré en clair pour le développement : la clé ne quitte pas
 * la machine. Tout autre hôte en `http://` est rejeté **avant** l'envoi, pas
 * après — une clé transmise en clair est déjà compromise.
 */
export function assertSecureUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`URL KeeperHub invalide : ${rawUrl}`);
  }
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !isLoopback) {
    throw new Error(
      `Refus d'envoyer la clé API vers ${url.protocol}//${url.host} : HTTPS obligatoire ` +
        "(seul localhost est toléré en clair).",
    );
  }
  return url;
}

/**
 * Convertit un montant décimal en unités brutes, sans passer par `Number`.
 *
 * `Number("0.1") * 1e6` puis `Math.round` fonctionne pour 0,1 mais perd de la
 * précision dès que le montant dépasse la plage exacte du flottant. Le parsing
 * se fait donc sur la chaîne, en base 10, et refuse tout ce qui n'est pas un
 * décimal positif.
 */
export function parseAmount(input: string, decimals = TOKEN.decimals): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Montant invalide : ${input} (attendu un décimal positif, ex. 0.1)`);
  }
  const [integer, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Montant ${input} : plus de ${decimals} décimales pour ${TOKEN.symbol}.`);
  }
  return BigInt(integer + fraction.padEnd(decimals, "0"));
}

export function requireApiKey(): string {
  const key = process.env.KEEPERHUB_API_KEY;
  if (!key) {
    throw new Error(
      "KEEPERHUB_API_KEY manquante. Créer une clé d'organisation sur " +
        "app.keeperhub.com → Settings → API Keys → Organisation, puis exporter " +
        "KEEPERHUB_API_KEY=kh_...",
    );
  }
  if (!key.startsWith("kh_")) {
    throw new Error("KEEPERHUB_API_KEY invalide : une clé KeeperHub commence par 'kh_'.");
  }
  return key;
}

/** Formate une quantité brute en unités lisibles, sans arrondi. */
export function formatUnits(raw: bigint, decimals = TOKEN.decimals): string {
  const s = raw.toString().padStart(decimals + 1, "0");
  const integer = s.slice(0, s.length - decimals);
  const fraction = s.slice(s.length - decimals).replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

/** Lundi 5 janvier 1970, 00:00 UTC — premier lundi de l'ère Unix. */
const MONDAY_EPOCH_MS = Date.UTC(1970, 0, 5);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Fenêtre de versement courante, ancrée sur le **lundi 00:00 UTC**.
 *
 * L'ancrage est explicite à dessein : une semaine calculée depuis l'epoch Unix
 * démarrerait un jeudi, ce qui est correct mais déroutant à auditer.
 *
 * Cette fenêtre est celle de l'agent, indépendante de la période de
 * rechargement de l'allocation on-chain — elle ne sert qu'à l'idempotence :
 * deux exécutions dans la même fenêtre avec les mêmes arguments ne peuvent pas
 * produire deux transferts.
 */
export function currentWindow(now: Date): string {
  const weeks = Math.floor((now.getTime() - MONDAY_EPOCH_MS) / WEEK_MS);
  return `w${weeks}`;
}

export function idempotencyKey(window: string, amountRaw: bigint): string {
  return `drip-${window}-${amountRaw.toString()}`;
}
