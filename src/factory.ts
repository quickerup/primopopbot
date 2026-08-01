import { Env } from "./env";
import { TelegramClient, TgMessage, TgCallbackQuery } from "./telegram";
import { BotConfig, BotRecord } from "./dsl/types";
import { validateConfigShape, assertSafeForPublicBot, SchemaError, findCommand } from "./dsl/schema";
import { loadSecrets, saveSecrets } from "./secrets";
import { generateCommandFromDescription } from "./ai";
import { handleEditorCallback, handleEditorMessage } from "./editor";
import {
  listWorkflows,
  dispatchWorkflow,
  listRuns,
  getRun,
  cancelRun,
  rerunRun,
  getRunLogsUrl,
  GhCreds,
} from "./github";

const PENDING_TTL_SECONDS = 15 * 60;

interface PendingFactoryState {
  kind: 
    | "awaiting_newbot_token"
    | "newbot_visibility"
    | "awaiting_config_json"
    | "awaiting_config_file" // not purely text, but we check if msg has document
    | "awaiting_secret_name"
    | "awaiting_secret_value"
    | "awaiting_ai_prompt"
    | "ai_confirm"
    | "deletebot_confirm"
    | "awaiting_editor_input";
  botId?: string;
  token?: string; 
  secretName?: string; 
  commandJson?: unknown;
  commandIndex?: number;
  actionIndex?: number;
  field?: string;
}

async function getPending(env: Env, chatId: number): Promise<PendingFactoryState | null> {
  const raw = await env.BOT_KV.get(`pending:${chatId}`);
  return raw ? (JSON.parse(raw) as PendingFactoryState) : null;
}

async function setPending(env: Env, chatId: number, state: PendingFactoryState): Promise<void> {
  await env.BOT_KV.put(`pending:${chatId}`, JSON.stringify(state), { expirationTtl: PENDING_TTL_SECONDS });
}

async function clearPending(env: Env, chatId: number): Promise<void> {
  await env.BOT_KV.delete(`pending:${chatId}`);
}

function webhookUrl(req: Request, botId: string): string {
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}/hook/${encodeURIComponent(botId)}`;
}

async function getBotRecord(env: Env, botId: string): Promise<BotRecord | null> {
  const raw = await env.BOT_KV.get(`bot:${botId}`);
  return raw ? (JSON.parse(raw) as BotRecord) : null;
}

async function getBotConfig(env: Env, botId: string): Promise<BotConfig | null> {
  const raw = await env.BOT_KV.get(`config:${botId}`);
  return raw ? (JSON.parse(raw) as BotConfig) : null;
}

export async function handleFactoryMessage(env: Env, req: Request, tg: TelegramClient, msg: TgMessage): Promise<void> {
  const chatId = msg.chat.id;
  const text = (msg.text ?? "").trim();

  const pending = await getPending(env, chatId);
  
  if (pending && (!text.startsWith("/") || text === "/cancel")) {
    if (text === "/cancel") {
      await clearPending(env, chatId);
      await tg.sendMessage(chatId, "Action cancelled.");
      await showMainMenu(tg, chatId);
      return;
    }
    const handled = await continuePendingFlow(env, req, tg, msg, pending);
    if (handled) return;
  }

  if (!text.startsWith("/")) {
    await showMainMenu(tg, chatId);
    return;
  }

  const [cmdRaw, ...rest] = text.slice(1).split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const argLine = text.slice(1 + cmdRaw.length).trim();

  switch (cmd) {
    case "start":
    case "menu":
    case "help":
      await showMainMenu(tg, chatId);
      return;
    case "newbot":
      await cmdNewBot(env, req, tg, chatId, rest[0]);
      return;
    case "setconfig":
      await cmdSetConfigFromDocument(env, tg, chatId, msg, rest[0]);
      return;
    case "json":
      await cmdJsonInline(env, tg, chatId, rest[0], argLine.slice(rest[0]?.length ?? 0).trim());
      return;
    case "list":
      await cmdList(env, tg, chatId, rest[0]);
      return;
    case "show":
      await cmdShow(env, tg, chatId, rest[0], rest[1]);
      return;
    case "listbots":
      await cmdListBots(env, tg, chatId);
      return;
    case "setvisibility":
      await cmdSetVisibility(env, tg, chatId, rest[0], rest[1] as "public" | "private");
      return;
    case "deletebot":
      await cmdDeleteBotPrompt(env, tg, chatId, rest[0]);
      return;
    case "set_secret":
      await cmdSetSecretStart(env, tg, chatId, rest[0]);
      return;
    case "list_secrets":
      await cmdListSecrets(env, tg, chatId, rest[0]);
      return;
    case "delete_secret":
      await cmdDeleteSecret(env, tg, chatId, rest[0], rest[1]);
      return;
    case "ai":
      await cmdAi(env, tg, chatId, rest[0], argLine.slice(rest[0]?.length ?? 0).trim());
      return;
    case "gh_workflows":
      await cmdGh(env, tg, chatId, async (c) => listWorkflows(c));
      return;
    case "gh_dispatch":
      await cmdGh(env, tg, chatId, async (c) => dispatchWorkflow(c, rest[0], rest[1] ?? "main"));
      return;
    case "gh_runs":
      await cmdGh(env, tg, chatId, async (c) => listRuns(c, rest[0] ? Number(rest[0]) : 10));
      return;
    case "gh_run":
      await cmdGh(env, tg, chatId, async (c) => getRun(c, rest[0]));
      return;
    case "gh_cancel":
      await cmdGh(env, tg, chatId, async (c) => cancelRun(c, rest[0]));
      return;
    case "gh_rerun":
      await cmdGh(env, tg, chatId, async (c) => rerunRun(c, rest[0]));
      return;
    case "gh_logs":
      await cmdGh(env, tg, chatId, async (c) => getRunLogsUrl(c, rest[0]));
      return;
    default:
      await tg.sendMessage(chatId, `Unknown command /${cmd}.`);
      await showMainMenu(tg, chatId);
  }
}

// ---------------------------------------------------------------------------
// MENUS
// ---------------------------------------------------------------------------
async function showMainMenu(tg: TelegramClient, chatId: number): Promise<void> {
  await tg.sendMessageWithInlineKeyboard(chatId, "🏭 <b>PrimoPopBot</b>\n\nWhat would you like to do?", [
    [{ text: "➕ Create New Bot", callback_data: "menu:new_bot" }],
    [{ text: "🤖 Manage Bots", callback_data: "menu:list_bots" }],
    [{ text: "🐙 GitHub Gateway", callback_data: "menu:gh" }]
  ], { parse_mode: "HTML" });
}

async function showBotMenu(env: Env, tg: TelegramClient, chatId: number, botId: string): Promise<void> {
  const record = await getBotRecord(env, botId);
  if (!record) {
    await tg.sendMessage(chatId, `Bot @${botId} no longer exists.`);
    return;
  }
  const config = await getBotConfig(env, botId);
  const cmdCount = config?.commands.length ?? 0;
  const msg = `🤖 <b>@${botId}</b>\nVisibility: ${record.visibility}\nCommands: ${cmdCount}\nCreated: ${record.createdAt.slice(0,10)}\n\nWhat would you like to do?`;
  
  await tg.sendMessageWithInlineKeyboard(chatId, msg, [
    [{ text: "📄 View/Upload JSON", callback_data: `manage:config:${botId}` }, { text: "🔑 Secrets", callback_data: `manage:secrets:${botId}` }],
    [{ text: "⚡ Manage Actions", callback_data: `editor:cmds:${botId}` }, { text: "⏰ Manage Schedules", callback_data: `editor:scheds:${botId}` }],
    [{ text: "🔄 Sync Commands", callback_data: `manage:sync:${botId}` }],
    [{ text: "👁️ Toggle Visibility", callback_data: `manage:visibility:${botId}` }],
    [{ text: "🗑️ Delete Bot", callback_data: `manage:delete:${botId}` }],
    [{ text: "🔙 Back to Bots", callback_data: "menu:list_bots" }]
  ], { parse_mode: "HTML" });
}

async function showConfigMenu(tg: TelegramClient, chatId: number, botId: string): Promise<void> {
  await tg.sendMessageWithInlineKeyboard(chatId, `📝 <b>Config for @${botId}</b>\n\nChoose how you want to update the config:`, [
    [{ text: "📄 Upload JSON File", callback_data: `config:upload:${botId}` }],
    [{ text: "⌨️ Paste Inline JSON", callback_data: `config:inline:${botId}` }],
    [{ text: "💬 Draft with AI", callback_data: `config:ai:${botId}` }],
    [{ text: "🔙 Back to Bot", callback_data: `manage:bot:${botId}` }]
  ], { parse_mode: "HTML" });
}

async function showSecretsMenu(env: Env, tg: TelegramClient, chatId: number, botId: string): Promise<void> {
  const secrets = await loadSecrets(env.BOT_KV, botId, env.SECRET_PASSPHRASE);
  const names = Object.keys(secrets);
  const msg = names.length ? `🔑 <b>Secrets for @${botId}</b>\n${names.join(", ")}\n\nWhat would you like to do?` : `🔑 <b>Secrets for @${botId}</b>\nNo secrets stored.\n\nWhat would you like to do?`;
  
  const buttons: any[][] = [[{ text: "➕ Add Secret", callback_data: `secrets:add:${botId}` }]];
  if (names.length) {
    // Just list up to 5 secrets to delete as buttons, for simplicity
    for (const name of names.slice(0, 5)) {
      buttons.push([{ text: `🗑️ Delete ${name}`, callback_data: `secrets:del:${botId}:${name}` }]);
    }
  }
  buttons.push([{ text: "🔙 Back to Bot", callback_data: `manage:bot:${botId}` }]);
  
  await tg.sendMessageWithInlineKeyboard(chatId, msg, buttons, { parse_mode: "HTML" });
}


export async function handleFactoryCallback(env: Env, req: Request, tg: TelegramClient, cq: TgCallbackQuery): Promise<void> {
  const chatId = cq.message?.chat.id;
  if (!chatId) return;
  await tg.answerCallbackQuery(cq.id);

  const data = cq.data ?? "";
  const pending = await getPending(env, chatId);

  if (data.startsWith("editor:")) {
    const handled = await handleEditorCallback(env, req, tg, cq, setPending);
    if (handled) return;
  }

  if (data.startsWith("menu:")) {
    await clearPending(env, chatId);
    const action = data.split(":")[1];
    if (action === "new_bot") {
      await setPending(env, chatId, { kind: "awaiting_newbot_token" });
      await tg.sendMessage(chatId, "Send me the Bot Token from @BotFather to register your new bot.\n\n(Send /cancel to abort)");
    } else if (action === "list_bots") {
      const list = await env.BOT_KV.list({ prefix: "bot:" });
      if (!list.keys.length) {
        await tg.sendMessage(chatId, "No bots registered yet.");
        await showMainMenu(tg, chatId);
        return;
      }
      const buttons: any[][] = [];
      for (const key of list.keys) {
        const raw = await env.BOT_KV.get(key.name);
        if (!raw) continue;
        const rec = JSON.parse(raw) as BotRecord;
        if (rec.botId !== "factory") {
          buttons.push([{ text: `@${rec.botId}`, callback_data: `manage:bot:${rec.botId}` }]);
        }
      }
      buttons.push([{ text: "🔙 Main Menu", callback_data: "menu:main" }]);
      await tg.sendMessageWithInlineKeyboard(chatId, "Select a bot to manage:", buttons);
    } else if (action === "gh") {
      await tg.sendMessage(chatId, "GitHub Gateway active. Use /gh_workflows, /gh_runs, etc. to interact.");
    } else if (action === "main") {
      await showMainMenu(tg, chatId);
    }
    return;
  }

  if (data.startsWith("manage:")) {
    await clearPending(env, chatId);
    const parts = data.split(":");
    const action = parts[1];
    const botId = parts[2];
    if (action === "bot") {
      await showBotMenu(env, tg, chatId, botId);
    } else if (action === "config") {
      await showConfigMenu(tg, chatId, botId);
    } else if (action === "secrets") {
      await showSecretsMenu(env, tg, chatId, botId);
    } else if (action === "visibility") {
      const record = await getBotRecord(env, botId);
      if (record) {
        const newVis = record.visibility === "public" ? "private" : "public";
        await cmdSetVisibility(env, tg, chatId, botId, newVis);
        await showBotMenu(env, tg, chatId, botId);
      }
    } else if (action === "sync") {
      const config = await getBotConfig(env, botId);
      const record = await getBotRecord(env, botId);
      if (config && record) {
        const commands = config.commands.map(c => ({
          command: c.command,
          description: c.description || "No description"
        }));
        try {
          const childTg = new TelegramClient(record.token);
          await childTg.setMyCommands(commands);
          await tg.sendMessage(chatId, `✅ Successfully synced ${commands.length} commands to Telegram menu for @${botId}.`);
        } catch (err) {
          await tg.sendMessage(chatId, `❌ Failed to sync commands: ${(err as Error).message}`);
        }
      } else {
        await tg.sendMessage(chatId, `Failed to load bot config.`);
      }
    } else if (action === "delete") {
      await cmdDeleteBotPrompt(env, tg, chatId, botId);
    }
    return;
  }

  if (data.startsWith("config:")) {
    await clearPending(env, chatId);
    const parts = data.split(":");
    const action = parts[1];
    const botId = parts[2];
    if (action === "upload") {
      await setPending(env, chatId, { kind: "awaiting_config_file", botId });
      await tg.sendMessage(chatId, `Attach and send a .json config file for @${botId}.\n\n(Send /cancel to abort)`);
    } else if (action === "inline") {
      await setPending(env, chatId, { kind: "awaiting_config_json", botId });
      await tg.sendMessage(chatId, `Paste your JSON config string for @${botId}.\n\n(Send /cancel to abort)`);
    } else if (action === "ai") {
      await setPending(env, chatId, { kind: "awaiting_ai_prompt", botId });
      await tg.sendMessage(chatId, `Describe the command you want AI to build for @${botId}.\n\n(Send /cancel to abort)`);
    }
    return;
  }

  if (data.startsWith("secrets:")) {
    await clearPending(env, chatId);
    const parts = data.split(":");
    const action = parts[1];
    const botId = parts[2];
    const secretName = parts[3];
    if (action === "add") {
      await setPending(env, chatId, { kind: "awaiting_secret_name", botId });
      await tg.sendMessage(chatId, `What's the secret's name (e.g. API_KEY)?\n\n(Send /cancel to abort)`);
    } else if (action === "del") {
      await cmdDeleteSecret(env, tg, chatId, botId, secretName);
      await showSecretsMenu(env, tg, chatId, botId);
    }
    return;
  }

  if (data === "newbot_vis:public" || data === "newbot_vis:private") {
    if (!pending || pending.kind !== "newbot_visibility" || !pending.token) {
      await tg.sendMessage(chatId, "That setup flow expired.");
      return;
    }
    const visibility = data.endsWith("public") ? "public" : "private";
    await finalizeNewBot(env, req, tg, chatId, pending.botId!, pending.token, visibility);
    await clearPending(env, chatId);
    await showBotMenu(env, tg, chatId, pending.botId!);
    return;
  }

  if (data === "ai_confirm" || data === "ai_cancel") {
    if (!pending || pending.kind !== "ai_confirm") {
      await tg.sendMessage(chatId, "That AI draft expired.");
      return;
    }
    if (data === "ai_cancel") {
      await tg.sendMessage(chatId, "Discarded.");
    } else {
      await saveGeneratedCommand(env, tg, chatId, pending.botId!, pending.commandJson);
    }
    await clearPending(env, chatId);
    await showConfigMenu(tg, chatId, pending.botId!);
    return;
  }

  if (data === "deletebot_confirm" || data === "deletebot_cancel") {
    if (!pending || pending.kind !== "deletebot_confirm") {
      await tg.sendMessage(chatId, "That confirmation expired.");
      return;
    }
    if (data === "deletebot_cancel") {
      await tg.sendMessage(chatId, "Cancelled.");
      await showBotMenu(env, tg, chatId, pending.botId!);
    } else {
      await env.BOT_KV.delete(`bot:${pending.botId}`);
      await env.BOT_KV.delete(`config:${pending.botId}`);
      await env.BOT_KV.delete(`secrets:${pending.botId}`);
      await tg.sendMessage(chatId, `🗑️ Deleted bot @${pending.botId}.`);
      await showMainMenu(tg, chatId);
    }
    await clearPending(env, chatId);
    return;
  }
}

async function continuePendingFlow(env: Env, req: Request, tg: TelegramClient, msg: TgMessage, pending: PendingFactoryState): Promise<boolean> {
  const chatId = msg.chat.id;
  const text = (msg.text ?? "").trim();

  if (pending.kind === "awaiting_editor_input") {
    // pending object is slightly differently typed in editor, but structurally identical.
    const handled = await handleEditorMessage(env, tg, msg, pending as any, clearPending);
    return handled;
  }

  if (pending.kind === "awaiting_newbot_token") {
    await cmdNewBot(env, req, tg, chatId, text);
    return true; // cmdNewBot handles the state update to newbot_visibility
  }

  if (pending.kind === "awaiting_config_json") {
    await cmdJsonInline(env, tg, chatId, pending.botId, text);
    await clearPending(env, chatId);
    await showBotMenu(env, tg, chatId, pending.botId!);
    return true;
  }

  if (pending.kind === "awaiting_config_file") {
    if (msg.document) {
      await cmdSetConfigFromDocument(env, tg, chatId, msg, pending.botId);
      await clearPending(env, chatId);
      await showBotMenu(env, tg, chatId, pending.botId!);
      return true;
    }
    await tg.sendMessage(chatId, "Please attach a .json file, or send /cancel to abort.");
    return true;
  }

  if (pending.kind === "awaiting_ai_prompt") {
    await cmdAi(env, tg, chatId, pending.botId, text);
    return true; // state shifts to ai_confirm
  }

  if (pending.kind === "awaiting_secret_name") {
    if (!/^[A-Z0-9_]{1,64}$/i.test(text)) {
      await tg.sendMessage(chatId, "Secret names should be short alphanumeric/underscore identifiers. Try again, or /cancel to abort.");
      return true;
    }
    await setPending(env, chatId, { kind: "awaiting_secret_value", botId: pending.botId, secretName: text.toUpperCase() });
    await tg.sendMessage(chatId, `Now send the value for ${text.toUpperCase()}. I'll delete your message right after I save it.`);
    return true;
  }

  if (pending.kind === "awaiting_secret_value" && pending.secretName) {
    const secrets = await loadSecrets(env.BOT_KV, pending.botId!, env.SECRET_PASSPHRASE);
    secrets[pending.secretName] = text;
    await saveSecrets(env.BOT_KV, pending.botId!, env.SECRET_PASSPHRASE, secrets);
    await clearPending(env, chatId);
    await tg.deleteMessage(chatId, msg.message_id);
    await tg.sendMessage(chatId, `✅ Saved secret ${pending.secretName} for @${pending.botId}. I deleted your message containing the value.`);
    await showSecretsMenu(env, tg, chatId, pending.botId!);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Original command implementations (mostly intact, slightly modified for flow)
// ---------------------------------------------------------------------------

async function cmdNewBot(env: Env, req: Request, tg: TelegramClient, chatId: number, token?: string): Promise<void> {
  if (!token) {
    await tg.sendMessage(chatId, "Usage: /newbot <token-from-BotFather>");
    return;
  }
  let me;
  try {
    me = await new TelegramClient(token).getMe();
  } catch (err) {
    await tg.sendMessage(chatId, `Couldn't validate that token: ${(err as Error).message}`);
    return;
  }
  if (!me.username) {
    await tg.sendMessage(chatId, "That bot has no username, which shouldn't be possible — try a different token.");
    return;
  }
  const botId = me.username;
  const existing = await getBotRecord(env, botId);
  if (existing) {
    await tg.sendMessage(chatId, `@${botId} is already registered (visibility: ${existing.visibility}). Use the manage menu to re-register it.`);
    return;
  }

  await setPending(env, chatId, { kind: "newbot_visibility", botId, token });
  await tg.sendMessageWithInlineKeyboard(chatId, `Got it — @${botId}. Should this bot be public or private?`, [
    [
      { text: "🔒 Private (owner only)", callback_data: "newbot_vis:private" },
      { text: "🌐 Public (anyone)", callback_data: "newbot_vis:public" },
    ],
  ]);
}

async function finalizeNewBot(
  env: Env,
  req: Request,
  tg: TelegramClient,
  chatId: number,
  botId: string,
  token: string,
  visibility: "public" | "private"
): Promise<void> {
  const childTg = new TelegramClient(token);
  try {
    await childTg.setWebhook(webhookUrl(req, botId), env.TELEGRAM_WEBHOOK_SECRET);
  } catch (err) {
    await tg.sendMessage(chatId, `Failed to register webhook for @${botId}: ${(err as Error).message}`);
    return;
  }
  const record: BotRecord = {
    botId,
    token,
    ownerId: env.FACTORY_OWNER_ID,
    visibility,
    createdAt: new Date().toISOString(),
  };
  await env.BOT_KV.put(`bot:${botId}`, JSON.stringify(record));
  await env.BOT_KV.put(`config:${botId}`, JSON.stringify({ version: 1, commands: [] } satisfies BotConfig));
  await tg.sendMessage(chatId, `✅ @${botId} is live (${visibility}).`);
}

async function saveConfigOrReject(env: Env, tg: TelegramClient, chatId: number, botId: string, raw: unknown): Promise<void> {
  const record = await getBotRecord(env, botId);
  if (!record) {
    await tg.sendMessage(chatId, `No such bot @${botId}.`);
    return;
  }
  try {
    validateConfigShape(raw);
    if (record.visibility === "public") {
      assertSafeForPublicBot(raw);
    }
  } catch (err) {
    const msg = err instanceof SchemaError ? err.message : "Invalid config.";
    await tg.sendMessage(chatId, `❌ Config rejected: ${msg}`);
    return;
  }
  await env.BOT_KV.put(`config:${botId}`, JSON.stringify(raw));
  await tg.sendMessage(chatId, `✅ Saved config for @${botId} (${(raw as BotConfig).commands.length} command(s)).`);
}

async function cmdSetConfigFromDocument(env: Env, tg: TelegramClient, chatId: number, msg: TgMessage, botId?: string): Promise<void> {
  if (!botId) {
    await tg.sendMessage(chatId, "Usage: /setconfig <botId> (attach a .json file)");
    return;
  }
  if (!msg.document) {
    await tg.sendMessage(chatId, "Attach a .json file with this command.");
    return;
  }
  const record = await getBotRecord(env, botId);
  if (!record) {
    await tg.sendMessage(chatId, `No such bot @${botId}.`);
    return;
  }
  await tg.sendMessage(chatId, "Reading uploaded file…");
  try {
    const file = await tgFileText(tg, msg.document.file_id);
    const parsed = JSON.parse(file);
    await saveConfigOrReject(env, tg, chatId, botId, parsed);
  } catch (err) {
    await tg.sendMessage(chatId, `❌ Couldn't read/parse that file: ${(err as Error).message}`);
  }
}

async function tgFileText(tg: TelegramClient, fileId: string): Promise<string> {
  const info = await tg.getFile(fileId);
  if (!info.file_path) throw new Error("Telegram did not return a file_path");
  const url = (tg as any).fileDownloadUrl(info.file_path) as string;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return res.text();
}

async function cmdJsonInline(env: Env, tg: TelegramClient, chatId: number, botId?: string, jsonText?: string): Promise<void> {
  if (!botId || !jsonText) {
    await tg.sendMessage(chatId, "Usage: /json <botId> <json config>");
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    await tg.sendMessage(chatId, `❌ Not valid JSON: ${(err as Error).message}`);
    return;
  }
  await saveConfigOrReject(env, tg, chatId, botId, parsed);
}

async function cmdList(env: Env, tg: TelegramClient, chatId: number, botId?: string): Promise<void> {
  if (!botId) {
    await tg.sendMessage(chatId, "Usage: /list <botId>");
    return;
  }
  const config = await getBotConfig(env, botId);
  if (!config) {
    await tg.sendMessage(chatId, `No config found for @${botId}.`);
    return;
  }
  if (!config.commands.length) {
    await tg.sendMessage(chatId, `@${botId} has no commands configured yet.`);
    return;
  }
  const lines = config.commands.map((c) => `/${c.command}${c.admin_only ? " (admin only)" : ""} — ${c.actions.length} action(s)`);
  await tg.sendMessage(chatId, `Commands for @${botId}:\n${lines.join("\n")}`);
}

async function cmdShow(env: Env, tg: TelegramClient, chatId: number, botId?: string, command?: string): Promise<void> {
  if (!botId || !command) {
    await tg.sendMessage(chatId, "Usage: /show <botId> <command>");
    return;
  }
  const config = await getBotConfig(env, botId);
  const cmdDef = config ? findCommand(config, command.replace(/^\//, "")) : undefined;
  if (!cmdDef) {
    await tg.sendMessage(chatId, `No command '${command}' found for @${botId}.`);
    return;
  }
  await tg.sendMessage(chatId, "```json\n" + JSON.stringify(cmdDef, null, 2) + "\n```", { parse_mode: "Markdown" });
}

async function cmdListBots(env: Env, tg: TelegramClient, chatId: number): Promise<void> {
  const list = await env.BOT_KV.list({ prefix: "bot:" });
  if (!list.keys.length) {
    await tg.sendMessage(chatId, "No bots registered yet.");
    return;
  }
  const lines: string[] = [];
  for (const key of list.keys) {
    const raw = await env.BOT_KV.get(key.name);
    if (!raw) continue;
    const rec = JSON.parse(raw) as BotRecord;
    lines.push(`@${rec.botId} — ${rec.visibility} — created ${rec.createdAt.slice(0, 10)}`);
  }
  await tg.sendMessage(chatId, lines.join("\n"));
}

async function cmdSetVisibility(env: Env, tg: TelegramClient, chatId: number, botId?: string, visibility?: "public" | "private"): Promise<void> {
  if (!botId || (visibility !== "public" && visibility !== "private")) {
    await tg.sendMessage(chatId, "Usage: /setvisibility <botId> <public|private>");
    return;
  }
  const record = await getBotRecord(env, botId);
  if (!record) {
    await tg.sendMessage(chatId, `No such bot @${botId}.`);
    return;
  }
  if (visibility === "public") {
    const config = await getBotConfig(env, botId);
    if (config) {
      try {
        assertSafeForPublicBot(config);
      } catch (err) {
        const msg = err instanceof SchemaError ? err.message : "Config unsafe for public.";
        await tg.sendMessage(chatId, `❌ Can't make @${botId} public: ${msg}\nFix the config first.`);
        return;
      }
    }
  }
  record.visibility = visibility;
  await env.BOT_KV.put(`bot:${botId}`, JSON.stringify(record));
  await tg.sendMessage(chatId, `✅ @${botId} is now ${visibility}.`);
}

async function cmdDeleteBotPrompt(env: Env, tg: TelegramClient, chatId: number, botId?: string): Promise<void> {
  if (!botId) return;
  const record = await getBotRecord(env, botId);
  if (!record) return;
  await setPending(env, chatId, { kind: "deletebot_confirm", botId });
  await tg.sendMessageWithInlineKeyboard(chatId, `Delete @${botId} and all its config/secrets? This can't be undone.`, [
    [
      { text: "❌ Cancel", callback_data: "deletebot_cancel" },
      { text: "🗑️ Delete", callback_data: "deletebot_confirm" },
    ],
  ]);
}

async function cmdSetSecretStart(env: Env, tg: TelegramClient, chatId: number, botId?: string): Promise<void> {
  if (!botId) return;
  const record = await getBotRecord(env, botId);
  if (!record && botId !== "factory") return;
  await setPending(env, chatId, { kind: "awaiting_secret_name", botId });
  await tg.sendMessage(chatId, `What's the secret's name (e.g. API_KEY)?\n\n(Send /cancel to abort)`);
}

async function cmdListSecrets(env: Env, tg: TelegramClient, chatId: number, botId?: string): Promise<void> {
  if (!botId) return;
  const secrets = await loadSecrets(env.BOT_KV, botId, env.SECRET_PASSPHRASE);
  const names = Object.keys(secrets);
  await tg.sendMessage(chatId, names.length ? `Secrets for @${botId}: ${names.join(", ")}\n(values hidden)` : `No secrets stored for @${botId}.`);
}

async function cmdDeleteSecret(env: Env, tg: TelegramClient, chatId: number, botId?: string, name?: string): Promise<void> {
  if (!botId || !name) return;
  const secrets = await loadSecrets(env.BOT_KV, botId, env.SECRET_PASSPHRASE);
  const key = name.toUpperCase();
  if (!(key in secrets)) return;
  delete secrets[key];
  await saveSecrets(env.BOT_KV, botId, env.SECRET_PASSPHRASE, secrets);
  await tg.sendMessage(chatId, `🗑️ Deleted secret ${key} for @${botId}.`);
}

async function cmdAi(env: Env, tg: TelegramClient, chatId: number, botId?: string, description?: string): Promise<void> {
  if (!botId || !description) return;
  const record = await getBotRecord(env, botId);
  if (!record) return;
  await tg.sendMessage(chatId, "Drafting…");
  const result = await generateCommandFromDescription(env.AI, description);
  if (!result.ok || !result.command) {
    await tg.sendMessage(chatId, `❌ Couldn't generate a valid command: ${result.error ?? "unknown error"}\n\nRaw model output:\n${result.rawText.slice(0, 1000)}`);
    return;
  }
  if (record.visibility === "public") {
    try {
      assertSafeForPublicBot({ version: 1, commands: [result.command] });
    } catch (err) {
      const msg = err instanceof SchemaError ? err.message : "Unsafe for public bot.";
      await tg.sendMessage(chatId, `❌ Generated command isn't safe for a public bot: ${msg}`);
      return;
    }
  }
  await setPending(env, chatId, { kind: "ai_confirm", botId, commandJson: result.command });
  await tg.sendMessage(chatId, "```json\n" + JSON.stringify(result.command, null, 2) + "\n```", { parse_mode: "Markdown" });
  await tg.sendMessageWithInlineKeyboard(chatId, "Save this command?", [
    [
      { text: "❌ Discard", callback_data: "ai_cancel" },
      { text: "✅ Save", callback_data: "ai_confirm" },
    ],
  ]);
}

async function saveGeneratedCommand(env: Env, tg: TelegramClient, chatId: number, botId: string, commandJson: unknown): Promise<void> {
  const config = (await getBotConfig(env, botId)) ?? { version: 1, commands: [] };
  const cmdDef = commandJson as BotConfig["commands"][number];
  const withoutOld = config.commands.filter((c) => c.command !== cmdDef.command);
  const updated: BotConfig = { ...config, commands: [...withoutOld, cmdDef] };
  const record = await getBotRecord(env, botId);
  if (record?.visibility === "public") {
    try {
      assertSafeForPublicBot(updated);
    } catch (err) {
      await tg.sendMessage(chatId, `❌ Not saved — unsafe for public bot: ${(err as Error).message}`);
      return;
    }
  }
  await env.BOT_KV.put(`config:${botId}`, JSON.stringify(updated));
  await tg.sendMessage(chatId, `✅ Saved /${cmdDef.command} to @${botId}.`);
}

async function cmdGh(env: Env, tg: TelegramClient, chatId: number, fn: (creds: GhCreds) => Promise<string>): Promise<void> {
  const secrets = await loadSecrets(env.BOT_KV, "factory", env.SECRET_PASSPHRASE);
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = secrets;
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    await tg.sendMessage(
      chatId,
      "GitHub gateway isn't configured. Set /set_secret factory GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO first."
    );
    return;
  }
  try {
    const text = await fn({ token: GITHUB_TOKEN, owner: GITHUB_OWNER, repo: GITHUB_REPO });
    await tg.sendMessage(chatId, text);
  } catch (err) {
    await tg.sendMessage(chatId, `❌ GitHub gateway error: ${(err as Error).message}`);
  }
}
