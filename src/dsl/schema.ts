import { Action, BotConfig, CommandDef, PUBLIC_BOT_FORBIDDEN_ACTIONS } from "./types";

export class SchemaError extends Error {}

const VALID_ACTION_TYPES = new Set([
  "send_message",
  "send_photo",
  "send_document",
  "send_location",
  "send_dice",
  "send_poll",
  "send_inline_keyboard",
  "send_keyboard",
  "request",
  "set_variable",
  "transform",
  "compute",
  "sort_slice",
  "condition",
  "ask",
  "log_event",
  "pick_random",
  "pick_unseen",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate the overall shape of a config object. Throws SchemaError with a
 * human-readable message on the first problem found.
 */
export function validateConfigShape(raw: unknown): asserts raw is BotConfig {
  if (!isPlainObject(raw)) throw new SchemaError("Config must be a JSON object");
  if (typeof raw.version !== "number") throw new SchemaError("Config must have a numeric 'version'");
  if (!Array.isArray(raw.commands)) throw new SchemaError("Config must have a 'commands' array");

  for (const [i, cmdRaw] of (raw.commands as unknown[]).entries()) {
    if (!isPlainObject(cmdRaw)) throw new SchemaError(`commands[${i}] must be an object`);
    if (typeof cmdRaw.command !== "string" || !/^[a-z0-9_]{1,32}$/i.test(cmdRaw.command)) {
      throw new SchemaError(`commands[${i}].command must be a short alphanumeric string`);
    }
    if (!Array.isArray(cmdRaw.actions) || cmdRaw.actions.length === 0) {
      throw new SchemaError(`commands[${i}].actions must be a non-empty array`);
    }
    validateActionList(cmdRaw.actions as unknown[], `commands[${i}].actions`);
  }
}

function validateActionList(actions: unknown[], path: string): void {
  for (const [i, a] of actions.entries()) {
    validateAction(a, `${path}[${i}]`);
  }
}

function validateAction(a: unknown, path: string): void {
  if (!isPlainObject(a)) throw new SchemaError(`${path} must be an object`);
  const type = a.type;
  if (typeof type !== "string" || !VALID_ACTION_TYPES.has(type)) {
    throw new SchemaError(
      `${path}.type '${String(type)}' is not a recognized action type. ` +
        `Note: 'shell' and 'python' style actions are not supported by this DSL — ` +
        `use 'compute'/'transform' for custom data shaping instead.`
    );
  }
  if (type === "condition") {
    const c = a as any;
    if (!Array.isArray(c.then)) throw new SchemaError(`${path}.then must be an array`);
    validateActionList(c.then, `${path}.then`);
    if (c.else !== undefined) {
      if (!Array.isArray(c.else)) throw new SchemaError(`${path}.else must be an array`);
      validateActionList(c.else, `${path}.else`);
    }
  }
  if (type === "compute") {
    const c = a as any;
    if (typeof c.expression !== "string" || c.expression.length === 0) {
      throw new SchemaError(`${path}.expression must be a non-empty string`);
    }
    if (typeof c.assign !== "string") throw new SchemaError(`${path}.assign is required`);
  }
  if (type === "log_event") {
    const p = a as any;
    if (typeof p.name !== "string") throw new SchemaError(`${path}.name is required`);
    if (typeof p.value !== "string") throw new SchemaError(`${path}.value is required`);
  }

  if (type === "pick_random") {
    const p = a as any;
    if (typeof p.source !== "string") throw new SchemaError(`${path}.source is required`);
    if (typeof p.assign !== "string") throw new SchemaError(`${path}.assign is required`);
  }

  if (type === "pick_unseen") {
    const p = a as any;
    for (const f of ["source", "key", "seen_key", "assign"]) {
      if (typeof p[f] !== "string") throw new SchemaError(`${path}.${f} is required`);
    }
  }
  if (type === "request") {
    const r = a as any;
    if (typeof r.url !== "string") throw new SchemaError(`${path}.url is required`);
  }
}

/**
 * Reject configs that try to smuggle actions forbidden on public bots.
 * Called at /setconfig, /json, and /ai save time whenever the target bot's
 * visibility is "public". Fails loudly with a specific action path rather
 * than silently stripping the offending action, per spec: a silently
 * modified config could surprise the owner into thinking a feature is live
 * when it was actually dropped.
 */
export function assertSafeForPublicBot(config: BotConfig): void {
  for (const cmd of config.commands) {
    walkActionsForPublicSafety(cmd.actions, `command '${cmd.command}'`);
  }
}

function walkActionsForPublicSafety(actions: Action[], where: string): void {
  for (const action of actions) {
    if (PUBLIC_BOT_FORBIDDEN_ACTIONS.has(action.type)) {
      throw new SchemaError(
        `Refusing to save: action type '${action.type}' in ${where} is not allowed on public bots.`
      );
    }
    if (action.type === "condition") {
      walkActionsForPublicSafety(action.then, where);
      if (action.else) walkActionsForPublicSafety(action.else, where);
    }
    if (action.type === "compute") {
      // Public bots may only use compute expressions built from the fixed
      // whitelist grammar (enforced by expression.ts at runtime — no
      // additional restriction needed here beyond that shared evaluator),
      // but we defensively cap length/complexity to reduce abuse surface
      // for e.g. deeply nested parens designed to blow the call stack.
      if (action.expression.length > 300) {
        throw new SchemaError(
          `Refusing to save: 'compute' expression in ${where} is too long for a public bot (max 300 chars).`
        );
      }
    }
  }
}

export function findCommand(config: BotConfig, name: string): CommandDef | undefined {
  return config.commands.find((c) => c.command === name);
}
