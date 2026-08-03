import { Env } from "./env";
import { BotConfig, BotRecord } from "./dsl/types";
import { TelegramClient } from "./telegram";

const BOT_TOKEN_RE = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/;
const BOT_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}bot$/i;
const BOT_SEQUENCE_KEY = "factory:primo-bot-sequence";

export interface ClientApiConfig {
  apiId: string;
  apiHash: string;
  endpoint: string;
  session?: string;
}

interface ClientApiMessage {
  id?: string | number;
  text?: string;
}

/**
 * Worker-compatible Telegram Client API adapter.
 *
 * Cloudflare Workers cannot open Telegram's native MTProto TCP sockets. This
 * adapter talks to a small MTProto-over-HTTP/WebSocket gateway (for example a
 * GramJS service running elsewhere, or any compatible bridge) with the user's
 * api_id/api_hash/session. Keeping the transport behind fetch() makes the bot
 * creation flow safe to execute in Workers, Queues, and Durable Objects.
 */
export class WebTelegramClientApi {
  constructor(private readonly config: ClientApiConfig) {}

  async connect(): Promise<void> {
    await this.rpc("connect", {});
  }

  async sendMessage(peer: string, message: string): Promise<ClientApiMessage> {
    return this.rpc<ClientApiMessage>("sendMessage", { peer, message });
  }

  async getRecentMessages(peer: string, limit = 5): Promise<ClientApiMessage[]> {
    return this.rpc<ClientApiMessage[]>("getRecentMessages", { peer, limit });
  }

  private async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.config.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method,
        params,
        api_id: this.config.apiId,
        api_hash: this.config.apiHash,
        session: this.config.session,
      }),
    });
    if (!res.ok) throw new Error(`Client API ${method} failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { result?: T; error?: string } | T;
    if (typeof data === "object" && data && "error" in data && data.error) throw new Error(String(data.error));
    return (typeof data === "object" && data && "result" in data ? data.result : data) as T;
  }
}

function clientApiConfig(env: Env): ClientApiConfig {
  if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH || !env.TELEGRAM_CLIENT_API_ENDPOINT) {
    throw new Error("Token generation is not configured. Set TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_CLIENT_API_ENDPOINT.");
  }
  return {
    apiId: env.TELEGRAM_API_ID,
    apiHash: env.TELEGRAM_API_HASH,
    endpoint: env.TELEGRAM_CLIENT_API_ENDPOINT,
    session: env.TELEGRAM_CLIENT_SESSION,
  };
}

async function waitForBotFatherResponse(client: WebTelegramClientApi, sinceMessageId?: string | number): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const messages = await client.getRecentMessages("BotFather", 5);
    const relevant = messages.find((m) => (sinceMessageId === undefined || String(m.id) !== String(sinceMessageId)) && m.text);
    if (relevant?.text) return relevant.text;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error("Timed out waiting for @BotFather response.");
}

export async function createNewBot(botName: string, botUsername: string, env: Env): Promise<string> {
  if (!botName.trim()) throw new Error("botName is required.");
  if (!BOT_USERNAME_RE.test(botUsername)) throw new Error("botUsername must be a valid Telegram bot username ending in 'bot'.");

  const client = new WebTelegramClientApi(clientApiConfig(env));
  await client.connect();

  const start = await client.sendMessage("BotFather", "/newbot");
  await waitForBotFatherResponse(client, start.id);
  const nameMsg = await client.sendMessage("BotFather", botName.trim());
  await waitForBotFatherResponse(client, nameMsg.id);
  const usernameMsg = await client.sendMessage("BotFather", botUsername.trim());
  const finalText = await waitForBotFatherResponse(client, usernameMsg.id);

  const token = finalText.match(BOT_TOKEN_RE)?.[0];
  if (!token) throw new Error(`BotFather did not return a bot token. Last response: ${finalText.slice(0, 240)}`);
  return token;
}

export interface TokenGenerationRequest {
  requestedName: string;
  visibility?: "public" | "private";
  ownerId?: string;
  requestUrl: string;
}

export interface TokenGenerationResult {
  botId: string;
  displayName: string;
  username: string;
  sequence: number;
  token: string;
  visibility: "public" | "private";
}

export interface PrimoBotIdentity {
  displayName: string;
  username: string;
  sequence: number;
}

function titleCaseWords(input: string): string {
  return input
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function usernameStem(input: string): string {
  let stem = input
    .normalize("NFKD")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[A-Za-z]/.test(stem)) stem = `Primo_${stem}`;
  return stem || "Primo";
}

async function nextPrimoBotSequence(env: Env): Promise<number> {
  const current = Number((await env.BOT_KV.get(BOT_SEQUENCE_KEY)) ?? "0");
  const next = current + 1;
  await env.BOT_KV.put(BOT_SEQUENCE_KEY, String(next));
  return next;
}

async function makePrimoBotIdentity(env: Env, requestedName: string): Promise<PrimoBotIdentity> {
  const baseName = titleCaseWords(requestedName);
  if (!baseName) throw new Error("Bot name is required.");

  const sequence = await nextPrimoBotSequence(env);
  const sequenceLabel = String(sequence).padStart(2, "0");
  const displaySuffix = ` Primo ${sequenceLabel} Bot`;
  const displayName = `${baseName.slice(0, 64 - displaySuffix.length).trim()}${displaySuffix}`;
  const usernameBase = usernameStem(baseName);
  const usernameSuffix = `Primo${sequenceLabel}Bot`;
  const maxBaseLength = 32 - usernameSuffix.length - 1;
  const trimmedBase = usernameBase.slice(0, Math.max(1, maxBaseLength)).replace(/_+$/g, "") || "Primo";
  const username = `${trimmedBase}_${usernameSuffix}`;

  if (!BOT_USERNAME_RE.test(username)) throw new Error(`Generated username ${username} is not valid for Telegram.`);
  return { displayName, username, sequence };
}

export class TokenGenerationQueue {
  private nextAvailableAt = 0;

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const payload = (await request.json()) as TokenGenerationRequest;
    return this.state.blockConcurrencyWhile(async () => {
      const delayMs = Math.max(0, this.nextAvailableAt - Date.now());
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      this.nextAvailableAt = Date.now() + 60_000;
      const identity = await makePrimoBotIdentity(this.env, payload.requestedName);
      const token = await createNewBot(identity.displayName, identity.username, this.env);
      const me = await new TelegramClient(token).getMe();
      const botId = me.username ?? identity.username;
      const visibility = payload.visibility ?? "private";
      const url = new URL(payload.requestUrl);
      await new TelegramClient(token).setWebhook(`${url.protocol}//${url.host}/hook/${encodeURIComponent(botId)}`, this.env.TELEGRAM_WEBHOOK_SECRET);
      const record: BotRecord = { botId, token, ownerId: payload.ownerId ?? this.env.FACTORY_OWNER_ID, visibility, createdAt: new Date().toISOString() };
      await this.env.BOT_KV.put(`bot:${botId}`, JSON.stringify(record));
      await this.env.BOT_KV.put(`config:${botId}`, JSON.stringify({ version: 1, commands: [] } satisfies BotConfig));
      return Response.json({ botId, displayName: identity.displayName, username: identity.username, sequence: identity.sequence, token, visibility } satisfies TokenGenerationResult);
    });
  }
}

export async function enqueueTokenGeneration(env: Env, req: Request, payload: Omit<TokenGenerationRequest, "requestUrl">): Promise<TokenGenerationResult> {
  const id = env.TOKEN_GENERATION_QUEUE.idFromName("botfather-token-generation");
  const stub = env.TOKEN_GENERATION_QUEUE.get(id);
  const res = await stub.fetch("https://token-generation.local/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, requestUrl: req.url }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
