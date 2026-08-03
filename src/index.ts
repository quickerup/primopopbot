import { Hono } from "hono";
import { Env } from "./env";
import { TelegramClient, TgUpdate } from "./telegram";
import { handleFactoryMessage, handleFactoryCallback } from "./factory";
import { enqueueTokenGeneration, TokenGenerationQueue } from "./botfather";
import { SessionClient } from "./session-client";
import { loadSecrets } from "./secrets";
import { findCommand } from "./dsl/schema";
import { runActions } from "./dsl/interpreter";
import { BotConfig, BotRecord } from "./dsl/types";
import { handleScheduled } from "./scheduled";

export { ChatSession } from "./session.do";
export { TokenGenerationQueue };

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("telegram-bot-factory: ok"));

app.post("/factory/newbot", async (c) => {
  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!c.env.TELEGRAM_WEBHOOK_SECRET || bearer !== c.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.text("forbidden", 403);
  }
  const body = (await c.req.json()) as { botName?: string; visibility?: "public" | "private" };
  if (!body.botName) return c.text("botName is required", 400);
  try {
    const result = await enqueueTokenGeneration(c.env, c.req.raw as unknown as Request, {
      requestedName: body.botName,
      visibility: body.visibility ?? "private",
      ownerId: c.env.FACTORY_OWNER_ID,
    });
    return c.json({ botId: result.botId, displayName: result.displayName, username: result.username, sequence: result.sequence, visibility: result.visibility });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// Shared webhook secret verification. Telegram echoes back whatever secret
// was registered via setWebhook in the X-Telegram-Bot-Api-Secret-Token
// header on every call; a mismatch means the request didn't come from
// Telegram (or came from a stale/forged webhook) and is dropped.
// ---------------------------------------------------------------------------
function verifySecretToken(req: Request, expected: string): boolean {
  const got = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  return got === expected && expected.length > 0;
}

app.post("/hook/factory", async (c) => {
  if (!verifySecretToken(c.req.raw as unknown as Request, c.env.TELEGRAM_WEBHOOK_SECRET)) {
    return c.text("forbidden", 403);
  }
  const update = (await c.req.json()) as TgUpdate;

  // Fail-closed gatekeeper: this check runs before ANY command dispatch. If
  // FACTORY_OWNER_ID isn't configured, refuse everyone rather than defaulting
  // open — same posture as the Python original's gatekeeper.
  const senderId = update.message?.from?.id ?? update.callback_query?.from.id;
  const ownerId = c.env.FACTORY_OWNER_ID;
  if (!ownerId || String(senderId) !== String(ownerId)) {
    return c.text("ok"); // 200 OK, silent drop — reveals nothing to a prober
  }

  // The factory bot's own token is needed to call sendMessage etc. It's
  // registered as the botId "factory" in the same KV bot registry so it
  // benefits from the same getFile/download plumbing as child bots.
  const record = await c.env.BOT_KV.get("bot:factory");
  if (!record) {
    return c.text("factory bot not registered — see README setup.sh", 500);
  }
  const { token, botId } = JSON.parse(record) as BotRecord;
  const tg = new TelegramClient(token);

  try {
    if (update.message) {
      await handleFactoryMessage(c.env, c.req.raw as unknown as Request, tg, update.message);
    } else if (update.callback_query) {
      await handleFactoryCallback(c.env, c.req.raw as unknown as Request, tg, update.callback_query);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("Error in factory bot:", err);
    if (c.env.FACTORY_OWNER_ID) {
      try {
        await tg.sendMessage(c.env.FACTORY_OWNER_ID, `🚨📢❗Alert! ERROR Detected in @${botId || 'factory'}\n\nError: ${errMsg}`);
      } catch (sendErr) {
        console.error("Failed to send error alert to Telegram:", sendErr);
      }
    }
  }
  return c.text("ok");
});

app.post("/hook/:botId", async (c) => {
  if (!verifySecretToken(c.req.raw as unknown as Request, c.env.TELEGRAM_WEBHOOK_SECRET)) {
    return c.text("forbidden", 403);
  }
  const botId = c.req.param("botId");
  const recordRaw = await c.env.BOT_KV.get(`bot:${botId}`);
  if (!recordRaw) return c.text("ok"); // unknown bot id — drop silently

  const record = JSON.parse(recordRaw) as BotRecord;
  const update = (await c.req.json()) as TgUpdate;

  let msg = update.message;
  let fromUser = msg?.from;
  let text = (msg?.text ?? "").trim();
  let isCallback = false;

  if (update.callback_query) {
    isCallback = true;
    msg = update.callback_query.message;
    fromUser = update.callback_query.from;
    text = (update.callback_query.data ?? "").trim();
  }

  if (!msg || !fromUser) return c.text("ok");

  // Private bots: owner-only, silent drop for everyone else so probing the
  // bot reveals nothing (still 200 OK, no reply).
  if (record.visibility === "private" && String(fromUser.id) !== String(record.ownerId)) {
    return c.text("ok");
  }

  const tg = new TelegramClient(record.token);
  if (isCallback && update.callback_query) {
    try {
      await tg.answerCallbackQuery(update.callback_query.id);
    } catch (err) {
      console.error("Failed to answer callback query:", err);
    }
  }

  try {
    const configRaw = await c.env.BOT_KV.get(`config:${botId}`);
    const config = configRaw ? (JSON.parse(configRaw) as BotConfig) : { version: 1, commands: [] };

    const session = new SessionClient(c.env.CHAT_SESSION, botId, msg.chat.id);
    const secrets = await loadSecrets(c.env.BOT_KV, botId, c.env.SECRET_PASSPHRASE);
    const runCtx = {
      tg,
      session,
      botId,
      visibility: record.visibility,
      chatId: msg.chat.id,
      user: { id: fromUser.id, first_name: fromUser.first_name, username: fromUser.username },
      secrets,
      analyticsDb: c.env.ANALYTICS_DB,
    };

    // Resume a paused `ask` flow if one is in progress for this chat, and the
    // incoming message isn't itself a new slash command.
    const pending = await session.getPending();
    if (pending && !text.startsWith("/")) {
      const cmdDef = findCommand(config, pending.command);
      if (cmdDef) {
        const vars = await session.getVars();
        const merged = { ...vars, [pending.awaitingVar]: text };
        await runActions(runCtx, cmdDef, pending.actions, pending.resumeIndex, merged);
      } else {
        await session.clearPending();
      }
      return c.text("ok");
    }

    if (!text.startsWith("/")) {
      // For callback queries, we can also match the entire data string as a command name
      if (isCallback) {
        const [cmdRaw] = text.split(/\s+/);
        const cmdName = cmdRaw.split("@")[0].toLowerCase();
        const cmdDef = findCommand(config, cmdName);
        if (cmdDef) {
          if (cmdDef.admin_only && String(fromUser.id) !== String(record.ownerId)) {
            return c.text("ok");
          }
          const vars = await session.getVars();
          const commandArgs = text.slice(cmdRaw.length).trim();
          await runActions(runCtx, cmdDef, cmdDef.actions, 0, { ...vars, text: commandArgs });
          return c.text("ok");
        }
      }

      // default_command: dispatch plain-text messages to a named command
      // with the raw text available as {vars.text}.
      if (config.default_command) {
        const defCmd = findCommand(config, config.default_command);
        if (defCmd) {
          if (defCmd.admin_only && String(fromUser.id) !== String(record.ownerId)) {
            return c.text("ok");
          }
          const vars = await session.getVars();
          await runActions(runCtx, defCmd, defCmd.actions, 0, { ...vars, text });
          return c.text("ok");
        }
      }
      return c.text("ok"); // no free-text handling outside an ask flow or default_command
    }

    const [cmdRaw] = text.slice(1).split(/\s+/);
    const cmdName = cmdRaw.split("@")[0].toLowerCase();
    const cmdDef = findCommand(config, cmdName);
    if (!cmdDef) return c.text("ok");

    if (cmdDef.admin_only && String(fromUser.id) !== String(record.ownerId)) {
      return c.text("ok");
    }

    const vars = await session.getVars();
    const commandArgs = text.slice(1 + cmdRaw.length).trim();
    await runActions(runCtx, cmdDef, cmdDef.actions, 0, { ...vars, text: commandArgs });
    return c.text("ok");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`Error in bot ${botId}:`, err);
    try {
      const factoryRaw = await c.env.BOT_KV.get("bot:factory");
      if (factoryRaw && c.env.FACTORY_OWNER_ID) {
        const { token: factoryToken } = JSON.parse(factoryRaw) as BotRecord;
        const factoryTg = new TelegramClient(factoryToken);
        await factoryTg.sendMessage(c.env.FACTORY_OWNER_ID, `🚨📢❗Alert! ERROR Detected in @${botId}\n\nError: ${errMsg}`);
      }
    } catch (sendErr) {
      console.error("Failed to send error alert to factory owner:", sendErr);
    }
    return c.text("ok");
  }
});

export default {
  fetch: app.fetch.bind(app),
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(event, env));
  },
};
