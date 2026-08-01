// ---------------------------------------------------------------------------
// ChatSession Durable Object — one instance per "botId:chatId" pair.
//
// This is the direct replacement for the Python version's
// `context.user_data`: Workers gives no guarantee that in-memory state
// (module-level variables, etc.) survives between requests or is shared
// across the many isolates that might handle a busy bot's traffic, so any
// state that needs to survive across a request boundary within a
// conversation MUST live here, not in a global variable and not in KV
// (KV is eventually consistent — a `set_variable` from one update reading
// back stale data a moment later on a second update would silently corrupt
// conversation state).
//
// Talked to over plain fetch() with small JSON bodies, routed on pathname.
// ---------------------------------------------------------------------------

import { Action } from "./dsl/types";

interface PendingState {
  actions: Action[];
  resumeIndex: number;
  awaitingVar: string;
  command: string;
}

interface RateLimitState {
  tokens: number;
  lastRefillMs: number;
}

const RATE_LIMIT_CAPACITY = 20; // burst size
const RATE_LIMIT_REFILL_PER_SEC = 0.5; // one token every 2s sustained

export class ChatSession implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (`${request.method} ${url.pathname}`) {
        case "GET /vars": {
          const vars = (await this.state.storage.get<Record<string, unknown>>("vars")) ?? {};
          return Response.json(vars);
        }
        case "POST /vars": {
          const incoming = (await request.json()) as Record<string, unknown>;
          const current = (await this.state.storage.get<Record<string, unknown>>("vars")) ?? {};
          const merged = { ...current, ...incoming };
          await this.state.storage.put("vars", merged);
          return Response.json(merged);
        }
        case "DELETE /vars": {
          await this.state.storage.delete("vars");
          return Response.json({ ok: true });
        }
        case "GET /pending": {
          const pending = (await this.state.storage.get<PendingState>("pending")) ?? null;
          return Response.json(pending);
        }
        case "POST /pending": {
          const body = (await request.json()) as PendingState;
          await this.state.storage.put("pending", body);
          return Response.json({ ok: true });
        }
        case "DELETE /pending": {
          await this.state.storage.delete("pending");
          return Response.json({ ok: true });
        }
        case "POST /ratelimit": {
          const allowed = await this.consumeToken();
          return Response.json({ allowed });
        }
        default:
          return new Response("not found", { status: 404 });
      }
    } catch (err) {
      return new Response(`ChatSession error: ${(err as Error).message}`, { status: 500 });
    }
  }

  private async consumeToken(): Promise<boolean> {
    const now = Date.now();
    const stored = (await this.state.storage.get<RateLimitState>("ratelimit")) ?? {
      tokens: RATE_LIMIT_CAPACITY,
      lastRefillMs: now,
    };
    const elapsedSec = (now - stored.lastRefillMs) / 1000;
    const refilled = Math.min(RATE_LIMIT_CAPACITY, stored.tokens + elapsedSec * RATE_LIMIT_REFILL_PER_SEC);
    if (refilled < 1) {
      await this.state.storage.put("ratelimit", { tokens: refilled, lastRefillMs: now });
      return false;
    }
    await this.state.storage.put("ratelimit", { tokens: refilled - 1, lastRefillMs: now });
    return true;
  }
}
