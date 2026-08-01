import { ChatSession } from "./session.do";

export interface Env {
  BOT_KV: KVNamespace;
  CHAT_SESSION: DurableObjectNamespace;
  AI: Ai;
  FACTORY_OWNER_ID: string;
  PUBLIC_REQUEST_ALLOWLIST: string;
  // Set via `wrangler secret put SECRET_PASSPHRASE` — never a plain [vars] entry.
  SECRET_PASSPHRASE: string;
  // Shared secret Telegram must echo back on every webhook call, set via
  // `wrangler secret put TELEGRAM_WEBHOOK_SECRET` and passed to setWebhook.
  TELEGRAM_WEBHOOK_SECRET: string;
}

export { ChatSession };
