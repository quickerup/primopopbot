import { Action } from "./dsl/types";

export interface PendingState {
  actions: Action[];
  resumeIndex: number;
  awaitingVar: string;
  command: string;
}

/** Thin client wrapper around a ChatSession Durable Object stub. */
export class SessionClient {
  private stub: DurableObjectStub;

  constructor(namespace: DurableObjectNamespace, botId: string, chatId: number | string) {
    const id = namespace.idFromName(`${botId}:${chatId}`);
    this.stub = namespace.get(id);
  }

  async getVars(): Promise<Record<string, unknown>> {
    const res = await this.stub.fetch("https://do/vars", { method: "GET" });
    return res.json();
  }

  async mergeVars(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.stub.fetch("https://do/vars", {
      method: "POST",
      body: JSON.stringify(patch),
    });
    return res.json();
  }

  async clearVars(): Promise<void> {
    await this.stub.fetch("https://do/vars", { method: "DELETE" });
  }

  async getPending(): Promise<PendingState | null> {
    const res = await this.stub.fetch("https://do/pending", { method: "GET" });
    const data = await res.json();
    return data as PendingState | null;
  }

  async setPending(pending: PendingState): Promise<void> {
    await this.stub.fetch("https://do/pending", {
      method: "POST",
      body: JSON.stringify(pending),
    });
  }

  async clearPending(): Promise<void> {
    await this.stub.fetch("https://do/pending", { method: "DELETE" });
  }

  /** Token-bucket rate limit check; true if this call is allowed to proceed. */
  async checkRateLimit(): Promise<boolean> {
    const res = await this.stub.fetch("https://do/ratelimit", { method: "POST" });
    const data = (await res.json()) as { allowed: boolean };
    return data.allowed;
  }
}
