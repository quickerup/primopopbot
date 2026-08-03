import { renderTemplate, TemplateContext } from "./dsl/template";

export type TonNetwork = "mainnet" | "testnet";
export type TonSignDataType = "text" | "binary" | "cell";

export interface TonConnectLinkOptions {
  network?: TonNetwork;
  manifestUrl: string;
  returnUrl?: string;
  tonProof?: string;
  walletUniversalUrl?: string;
}

export interface TonSignLinkOptions {
  network?: TonNetwork;
  signingUrl: string;
  payload: string;
  payloadType?: TonSignDataType;
  returnUrl?: string;
  state?: string;
}

export function normalizeTonNetwork(network: unknown): TonNetwork {
  return network === "testnet" ? "testnet" : "mainnet";
}

export function tonExplorerUrl(network: TonNetwork, address: string): string {
  const base = network === "testnet" ? "https://testnet.tonviewer.com" : "https://tonviewer.com";
  return `${base}/${encodeURIComponent(address)}`;
}

export function toncoinToNano(amount: string | number): string {
  const raw = String(amount).trim();
  if (!/^\d+(?:\.\d{1,9})?$/.test(raw)) {
    throw new Error("TON amount must be a non-negative decimal with at most 9 fractional digits");
  }
  const [whole, frac = ""] = raw.split(".");
  return `${BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, "0"))}`;
}

export async function buildTonConnectLink(opts: TonConnectLinkOptions): Promise<string> {
  const network = normalizeTonNetwork(opts.network);
  const manifestUrl = opts.manifestUrl.trim();
  if (!/^https:\/\//i.test(manifestUrl)) throw new Error("TON Connect manifest_url must be an HTTPS URL");

  const request: Record<string, unknown> = {
    manifestUrl,
    items: opts.tonProof
      ? [{ name: "ton_addr" }, { name: "ton_proof", payload: opts.tonProof }]
      : [{ name: "ton_addr" }],
  };
  const clientId = await sha256Hex(`${manifestUrl}:${network}`);
  const params = new URLSearchParams({
    v: "2",
    id: clientId,
    r: JSON.stringify(request),
  });
  if (opts.returnUrl) params.set("ret", opts.returnUrl);

  const base = opts.walletUniversalUrl?.trim();
  if (base) {
    if (!/^https:\/\//i.test(base)) throw new Error("wallet_universal_url must be HTTPS when provided");
    return `${base}${base.includes("?") ? "&" : "?"}${params.toString()}`;
  }
  return `tc://?${params.toString()}`;
}

export function buildTonSignLink(opts: TonSignLinkOptions): string {
  const signingUrl = opts.signingUrl.trim();
  if (!/^https:\/\//i.test(signingUrl)) throw new Error("TON signing_url must be an HTTPS URL");
  const url = new URL(signingUrl);
  url.searchParams.set("network", normalizeTonNetwork(opts.network));
  url.searchParams.set("type", opts.payloadType ?? "text");
  url.searchParams.set("payload", opts.payload);
  if (opts.returnUrl) url.searchParams.set("return_url", opts.returnUrl);
  if (opts.state) url.searchParams.set("state", opts.state);
  return url.toString();
}

export function renderTonTemplate(input: string | undefined, ctx: TemplateContext): string | undefined {
  return input === undefined ? undefined : renderTemplate(input, ctx);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
