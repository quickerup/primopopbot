import { ChatSession } from "./session.do";

export interface Env {
  BOT_KV: KVNamespace;
  CHAT_SESSION: DurableObjectNamespace;
  TOKEN_GENERATION_QUEUE: DurableObjectNamespace;
  AI: Ai;
  ANALYTICS_DB: D1Database;
  FACTORY_OWNER_ID: string;
  // Set via `wrangler secret put SECRET_PASSPHRASE` — never a plain [vars] entry.
  SECRET_PASSPHRASE: string;
  // Shared secret Telegram must echo back on every webhook call, set via
  // `wrangler secret put TELEGRAM_WEBHOOK_SECRET` and passed to setWebhook.
  TELEGRAM_WEBHOOK_SECRET: string;
  // User Client API credentials/session used by the BotFather automation bridge.
  TELEGRAM_API_ID: string;
  TELEGRAM_API_HASH: string;
  TELEGRAM_CLIENT_SESSION?: string;
  TELEGRAM_CLIENT_API_ENDPOINT: string;
}

export { ChatSession };
