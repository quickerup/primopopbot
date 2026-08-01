// ---------------------------------------------------------------------------
// Placeholder interpolation: {user.id}, {user.first_name}, {chat.id},
// {vars.NAME}, {secrets.NAME}.
//
// IMPORTANT: {secrets.*} resolution only ever happens here, server-side,
// against the decrypted-in-memory secrets map for the current request. The
// interpreter (interpreter.ts) is responsible for deciding *which* strings
// this function is allowed to touch — never call renderTemplate with the
// secrets map on a value that's about to be logged or echoed back unless
// the action explicitly intends to display it. Treat that as a foot-gun:
// a `send_message` action that interpolates `{secrets.API_KEY}` directly
// into its text WILL show that key to whoever is in the chat.
// ---------------------------------------------------------------------------

export interface TemplateContext {
  user: { id: number; first_name: string; username?: string };
  chat: { id: number; type: string };
  vars: Record<string, unknown>;
  secrets: Record<string, string>;
}

function getPath(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_.]*)\}/g;

export function renderTemplate(input: string, ctx: TemplateContext): string {
  return input.replace(PLACEHOLDER_RE, (match, expr: string) => {
    const parts = expr.split(".");
    const root = parts[0];
    if (root !== "user" && root !== "chat" && root !== "vars" && root !== "secrets") {
      return match; // not a recognized placeholder root — leave as-is
    }
    const value = getPath(ctx as unknown as Record<string, unknown>, parts);
    if (value === undefined || value === null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

/** Recursively render all string fields of an arbitrary JSON-ish value. */
export function renderDeep<T>(input: T, ctx: TemplateContext): T {
  if (typeof input === "string") {
    return renderTemplate(input, ctx) as unknown as T;
  }
  if (Array.isArray(input)) {
    return input.map((v) => renderDeep(v, ctx)) as unknown as T;
  }
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = renderDeep(v, ctx);
    }
    return out as T;
  }
  return input;
}

function getByDotPath(obj: unknown, dotPath: string): unknown {
  return getPath(obj, dotPath.split("."));
}

export { getByDotPath };
