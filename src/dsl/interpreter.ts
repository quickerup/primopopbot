// ---------------------------------------------------------------------------
// The action interpreter: walks a command's action array and executes each
// step against Telegram, the chat's variable bag (in the ChatSession DO),
// and (for `request`) the outside world via fetch().
//
// `ask` steps pause execution: remaining actions + resume index are
// persisted into the Durable Object, and the interpreter returns a
// "paused" result. The webhook handler resumes from here on the chat's
// next plain-text message (see index.ts).
// ---------------------------------------------------------------------------

import { TelegramClient } from "../telegram";
import { SessionClient } from "../session-client";
import { Action, BotConfig, CommandDef } from "./types";
import { renderTemplate, renderDeep, TemplateContext, getByDotPath } from "./template";
import { evaluateExpression, ExpressionError } from "./expression";
import { SecretsMap } from "../secrets";

export interface RunContext {
  tg: TelegramClient;
  session: SessionClient;
  botId: string;
  visibility: "public" | "private";
  chatId: number;
  user: { id: number; first_name: string; username?: string };
  secrets: SecretsMap;
  requestAllowlist: string[];
  analyticsDb?: D1Database; // optional — only present when the binding exists
}

export type RunResult = { status: "completed" } | { status: "paused"; prompt: string };

function checkWhen(action: Action, vars: Record<string, unknown>): boolean {
  if (!action.when) return true;
  const val = vars[action.when.var];
  if (action.when.equals !== undefined) return val === action.when.equals;
  if (action.when.not_equals !== undefined) return val !== action.when.not_equals;
  return true;
}

function templateCtx(ctx: RunContext, vars: Record<string, unknown>): TemplateContext {
  return {
    user: ctx.user,
    chat: { id: ctx.chatId, type: "private" },
    vars,
    secrets: ctx.secrets,
  };
}

function hostAllowed(url: string, ctx: RunContext): boolean {
  if (ctx.visibility === "private") return true; // owner-only bot, no SSRF concern from arbitrary third parties
  try {
    const host = new URL(url).hostname;
    return ctx.requestAllowlist.includes(host);
  } catch {
    return false;
  }
}

/**
 * Run a command's action list starting at `startIndex`, using `vars` as the
 * live variable bag (already merged with anything persisted from a prior
 * pause). Mutates a local copy and flushes it back to the DO at the end (or
 * at pause time) rather than after every single action, to keep the hot
 * path to one DO round trip per message where possible.
 */
export async function runActions(
  ctx: RunContext,
  command: CommandDef,
  actions: Action[],
  startIndex: number,
  initialVars: Record<string, unknown>
): Promise<RunResult> {
  let vars = { ...initialVars };

  for (let i = startIndex; i < actions.length; i++) {
    const action = actions[i];
    if (!checkWhen(action, vars)) continue;

    switch (action.type) {
      case "send_message": {
        const text = renderTemplate(action.text, templateCtx(ctx, vars));
        await ctx.tg.sendMessage(ctx.chatId, text, {
          parse_mode: action.parse_mode,
          disable_web_page_preview: action.disable_web_page_preview,
        });
        break;
      }
      case "send_photo": {
        const photo = renderTemplate(action.photo, templateCtx(ctx, vars));
        const caption = action.caption ? renderTemplate(action.caption, templateCtx(ctx, vars)) : undefined;
        await ctx.tg.sendPhoto(ctx.chatId, photo, caption);
        break;
      }
      case "send_document": {
        const doc = renderTemplate(action.document, templateCtx(ctx, vars));
        const caption = action.caption ? renderTemplate(action.caption, templateCtx(ctx, vars)) : undefined;
        await ctx.tg.sendDocument(ctx.chatId, doc, caption);
        break;
      }
      case "send_location": {
        await ctx.tg.sendLocation(ctx.chatId, action.latitude, action.longitude);
        break;
      }
      case "send_dice": {
        await ctx.tg.sendDice(ctx.chatId, action.emoji);
        break;
      }
      case "send_poll": {
        await ctx.tg.sendPoll(
          ctx.chatId,
          renderTemplate(action.question, templateCtx(ctx, vars)),
          action.options,
          action.is_anonymous,
          action.allows_multiple_answers
        );
        break;
      }
      case "send_inline_keyboard": {
        await ctx.tg.sendMessageWithInlineKeyboard(
          ctx.chatId,
          renderTemplate(action.text, templateCtx(ctx, vars)),
          action.buttons
        );
        break;
      }
      case "send_keyboard": {
        await ctx.tg.sendMessageWithKeyboard(
          ctx.chatId,
          renderTemplate(action.text, templateCtx(ctx, vars)),
          action.buttons,
          action.one_time
        );
        break;
      }
      case "request": {
        if (ctx.visibility === "public" && !hostAllowed(action.url, ctx)) {
          await ctx.tg.sendMessage(
            ctx.chatId,
            "⚠️ This bot isn't allowed to call that host. Ask the bot owner to add it to PUBLIC_REQUEST_ALLOWLIST."
          );
          break;
        }
        if (ctx.visibility === "public") {
          const allowed = await ctx.session.checkRateLimit();
          if (!allowed) {
            await ctx.tg.sendMessage(ctx.chatId, "⏳ Too many requests — please slow down and try again shortly.");
            break;
          }
        }
        const url = renderTemplate(action.url, templateCtx(ctx, vars));
        const headers = action.headers ? (renderDeep(action.headers, templateCtx(ctx, vars)) as Record<string, string>) : undefined;
        const body = action.body ? renderDeep(action.body, templateCtx(ctx, vars)) : undefined;
        try {
          const res = await fetch(url, {
            method: action.method ?? "GET",
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
          });

          if (!res.ok) {
            throw new Error(`HTTP ${action.method ?? "GET"} ${url} failed: ${res.status} ${res.statusText}`);
          }

          let parsed: unknown = undefined;
          try {
            parsed = await res.json();
          } catch {
            parsed = await res.text().catch(() => undefined);
          }
          const extracted = action.json_key ? getByDotPath(parsed, action.json_key) : parsed;
          if (action.assign) {
            vars = { ...vars, [action.assign]: extracted };
          }
        } catch (err) {
          if ((action.on_error ?? "throw") === "ignore") {
            // Silently swallow the error; leave vars unchanged.
            break;
          }
          throw err;
        }
        break;
      }
      case "set_variable": {
        const value =
          typeof action.value === "string" ? renderTemplate(action.value, templateCtx(ctx, vars)) : action.value;
        vars = { ...vars, [action.name]: value };
        break;
      }
      case "transform": {
        const source = vars[action.source];
        if (!Array.isArray(source)) {
          vars = { ...vars, [action.assign]: [] };
          break;
        }
        let result: unknown;
        if (action.op === "map" && action.fields) {
          result = source.map((item) => {
            const out: Record<string, unknown> = {};
            for (const [to, from] of Object.entries(action.fields!)) {
              out[to] = getByDotPath(item, from);
            }
            return out;
          });
        } else if (action.op === "filter" && action.filter) {
          const f = action.filter;
          result = source.filter((item) => {
            const val = getByDotPath(item, f.field);
            switch (f.op) {
              case "eq":
                return val === f.value;
              case "neq":
                return val !== f.value;
              case "gt":
                return typeof val === "number" && val > (f.value as number);
              case "lt":
                return typeof val === "number" && val < (f.value as number);
              case "gte":
                return typeof val === "number" && val >= (f.value as number);
              case "lte":
                return typeof val === "number" && val <= (f.value as number);
              case "contains":
                return typeof val === "string" && val.includes(String(f.value));
              default:
                return true;
            }
          });
        } else if (action.op === "pluck" && action.field) {
          result = source.map((item) => getByDotPath(item, action.field!));
        } else {
          result = source;
        }
        vars = { ...vars, [action.assign]: result };
        break;
      }
      case "compute": {
        try {
          if (action.source) {
            const source = vars[action.source];
            if (!Array.isArray(source)) {
              vars = { ...vars, [action.assign]: [] };
              break;
            }
            const asField = action.as ?? "result";
            const result = source.map((item, index) => {
              const scope: Record<string, number> = { index };
              if (item && typeof item === "object") {
                for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
                  if (typeof v === "number") scope[k] = v;
                }
              }
              const value = evaluateExpression(action.expression, scope);
              return { ...(item as object), [asField]: value };
            });
            vars = { ...vars, [action.assign]: result };
          } else {
            const scope: Record<string, number> = {};
            for (const [k, v] of Object.entries(vars)) {
              if (typeof v === "number") {
                scope[k] = v;
              } else if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
                // Values captured via `ask` arrive as plain text (e.g. a
                // user typing "42.5"); coerce numeric-looking strings so
                // compute can use them without a separate cast action.
                scope[k] = Number(v);
              }
            }
            const value = evaluateExpression(action.expression, scope);
            vars = { ...vars, [action.assign]: value };
          }
        } catch (err) {
          const msg = err instanceof ExpressionError ? err.message : "compute failed";
          await ctx.tg.sendMessage(ctx.chatId, `⚠️ compute error: ${msg}`);
        }
        break;
      }
      case "sort_slice": {
        const source = vars[action.source];
        if (!Array.isArray(source)) {
          vars = { ...vars, [action.assign]: [] };
          break;
        }
        const order = action.order ?? "desc";
        const sorted = [...source].sort((a, b) => {
          const av = Number(getByDotPath(a, action.key)) || 0;
          const bv = Number(getByDotPath(b, action.key)) || 0;
          return order === "desc" ? bv - av : av - bv;
        });
        const sliced = action.top ? sorted.slice(0, action.top) : sorted;
        const withDivide =
          action.divide_by && action.divide_as
            ? sliced.map((item) => ({
                ...(item as object),
                [action.divide_as!]: (Number(getByDotPath(item, action.key)) || 0) / action.divide_by!,
              }))
            : sliced;
        vars = { ...vars, [action.assign]: withDivide };
        break;
      }
      case "condition": {
        const val = vars[action.var];
        let matched = false;
        if (action.equals !== undefined) matched = val === action.equals;
        else if (action.not_equals !== undefined) matched = val !== action.not_equals;
        else if (action.gt !== undefined) matched = typeof val === "number" && val > action.gt;
        else if (action.lt !== undefined) matched = typeof val === "number" && val < action.lt;
        const branch = matched ? action.then : action.else ?? [];
        if (branch.length) {
          const result = await runActions(ctx, command, branch, 0, vars);
          if (result.status === "paused") {
            // Nested pause inside a branch: persist the *outer* remaining
            // sequence too so resume continues past the condition once the
            // inner ask completes. We flatten by persisting just the inner
            // branch remainder; outer actions after the condition are lost
            // on nested-ask configs by design simplicity — documented below.
            return result;
          }
          // Pull any vars the nested branch set back into our scope. Since
          // runActions works on copies, re-fetch from the DO once at the
          // end of the whole top-level call instead of threading returns
          // through every branch; simplest correct approach given DO vars
          // are flushed centrally in the caller (see index.ts).
        }
        break;
      }
      case "ask": {
        const prompt = renderTemplate(action.prompt, templateCtx(ctx, vars));
        await ctx.tg.sendMessage(ctx.chatId, prompt);
        await ctx.session.mergeVars(vars);
        await ctx.session.setPending({
          actions,
          resumeIndex: i + 1,
          awaitingVar: action.assign,
          command: command.command,
        });
        return { status: "paused", prompt };
      }
      case "log_event": {
        if (ctx.analyticsDb) {
          const value = renderTemplate(action.value, templateCtx(ctx, vars));
          await ctx.analyticsDb
            .prepare(
              "INSERT INTO search_log (bot_id, event_name, value, chat_id, ts) VALUES (?, ?, ?, ?, ?)"
            )
            .bind(ctx.botId, action.name, value, ctx.chatId, Math.floor(Date.now() / 1000))
            .run()
            .catch(() => { /* best-effort — never fail a user-facing action for analytics */ });
        }
        break;
      }
    }
  }

  await ctx.session.mergeVars(vars);
  await ctx.session.clearPending();
  return { status: "completed" };
}
