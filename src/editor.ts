import { Env } from "./env";
import { TelegramClient, TgCallbackQuery, TgMessage } from "./telegram";
import { BotConfig, ActionType, BaseAction } from "./dsl/types";
import { CronExpressionParser } from "cron-parser";

// This file handles the interactive Visual Action & Button Editor (the Premium BotFather experience).

export interface PendingEditorState {
  kind: "awaiting_editor_input";
  botId: string;
  commandIndex?: number;
  actionIndex?: number;
  field: string; // e.g. "command_name", "action_url", "schedule_expr", etc.
  tempSchedule?: { command: string; type: string };
}

async function getBotConfig(env: Env, botId: string): Promise<BotConfig | null> {
  const raw = await env.BOT_KV.get(`config:${botId}`);
  return raw ? (JSON.parse(raw) as BotConfig) : null;
}

async function saveBotConfig(env: Env, botId: string, config: BotConfig): Promise<void> {
  await env.BOT_KV.put(`config:${botId}`, JSON.stringify(config));
}

// ---------------------------------------------------------------------------
// MENUS
// ---------------------------------------------------------------------------

interface ScheduleRow {
  id: string;
  bot_id: string;
  command: string;
  type: string;
  expression: string;
  last_run: number;
}

export async function showSchedulesMenu(env: Env, tg: TelegramClient, chatId: number, botId: string): Promise<void> {
  const schedules = await env.ANALYTICS_DB
    ?.prepare("SELECT * FROM bot_schedules WHERE bot_id = ?")
    .bind(botId)
    .all<ScheduleRow>();
    
  let msg = `⏰ <b>Schedules for @${botId}</b>\n\n`;
  const buttons: any[][] = [];
  
  if (!schedules || !schedules.results || schedules.results.length === 0) {
    msg += "No schedules configured.";
  } else {
    schedules.results.forEach(s => {
      msg += `• /${s.command} [${s.type.toUpperCase()}] — ${s.expression}\n`;
      buttons.push([{ text: `🗑️ Delete /${s.command} (${s.type})`, callback_data: `editor:delsched:${botId}:${s.id}` }]);
    });
  }
  
  buttons.push([{ text: "➕ Add Schedule", callback_data: `editor:addsched:${botId}` }]);
  buttons.push([{ text: "🔙 Back to Bot", callback_data: `manage:bot:${botId}` }]);
  
  await tg.sendMessageWithInlineKeyboard(chatId, msg, buttons, { parse_mode: "HTML" });
}

export async function showCommandsMenu(env: Env, tg: TelegramClient, chatId: number, botId: string): Promise<void> {
  const config = await getBotConfig(env, botId) ?? { version: 1, commands: [] };
  const buttons: any[][] = [];
  
  let msg = `⚡ <b>Manage Actions for @${botId}</b>\nSelect a command to modify:\n\n`;
  if (config.commands.length === 0) {
    msg += "No commands yet.";
  } else {
    config.commands.forEach((cmd, i) => {
      msg += `• /${cmd.command} ➔ (${cmd.actions.length} actions)\n`;
      buttons.push([{ text: `✏️ Edit /${cmd.command}`, callback_data: `editor:cmd:${botId}:${i}` }]);
    });
  }
  
  buttons.push([{ text: "➕ Add Command", callback_data: `editor:addcmd:${botId}` }]);
  buttons.push([{ text: "🔙 Back to Dashboard", callback_data: `manage:bot:${botId}` }]);

  await tg.sendMessageWithInlineKeyboard(chatId, msg, buttons, { parse_mode: "HTML" });
}

export async function showCommandMenu(env: Env, tg: TelegramClient, chatId: number, botId: string, commandIndex: number): Promise<void> {
  const config = await getBotConfig(env, botId);
  if (!config || !config.commands[commandIndex]) {
    await tg.sendMessage(chatId, "Command not found.");
    return;
  }
  const cmd = config.commands[commandIndex];
  
  let msg = `🛠️ <b>Editing Command:</b> /${cmd.command}\n\nActions:\n`;
  const buttons: any[][] = [];
  
  if (cmd.actions.length === 0) {
    msg += "No actions.";
  } else {
    cmd.actions.forEach((act, i) => {
      msg += `${i+1}. ${act.type}\n`;
      buttons.push([{ text: `✏️ Edit Action ${i+1} (${act.type})`, callback_data: `editor:act:${botId}:${commandIndex}:${i}` }]);
    });
  }

  buttons.push([{ text: "➕ Add Action", callback_data: `editor:addact:${botId}:${commandIndex}` }]);
  buttons.push([{ text: "💬 Rename Command", callback_data: `editor:rencmd:${botId}:${commandIndex}` }]);
  buttons.push([{ text: "🗑️ Delete Command", callback_data: `editor:delcmd:${botId}:${commandIndex}` }]);
  buttons.push([{ text: "🔙 Back to Commands", callback_data: `editor:cmds:${botId}` }]);

  await tg.sendMessageWithInlineKeyboard(chatId, msg, buttons, { parse_mode: "HTML" });
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function showActionMenu(env: Env, tg: TelegramClient, chatId: number, botId: string, commandIndex: number, actionIndex: number): Promise<void> {
  const config = await getBotConfig(env, botId);
  if (!config || !config.commands[commandIndex] || !config.commands[commandIndex].actions[actionIndex]) return;
  
  const cmd = config.commands[commandIndex];
  const act = cmd.actions[actionIndex] as any;
  
  let msg = `🛠️ <b>Editing Action ${actionIndex+1} in /${cmd.command}</b>\nType: ${act.type}\n\n`;
  const buttons: any[][] = [];
  
  // Dynamically generate fields based on action type
  if (act.type === "send_message") {
    const textPreview = escapeHtml(act.text.slice(0, 50)) + (act.text.length > 50 ? "..." : "");
    msg += `Text: ${textPreview}\n`;
    buttons.push([{ text: "📝 Edit Text", callback_data: `editor:setfield:${botId}:${commandIndex}:${actionIndex}:text` }]);
  } else if (act.type === "request") {
    msg += `URL: ${escapeHtml(act.url || "")}\nMethod: ${act.method || "GET"}\nAssign: ${act.assign || "none"}\nJSON Key: ${act.json_key || "none"}\n`;
    buttons.push([{ text: "🔗 Edit URL", callback_data: `editor:setfield:${botId}:${commandIndex}:${actionIndex}:url` }]);
    buttons.push([{ text: "📦 Edit Assign Var", callback_data: `editor:setfield:${botId}:${commandIndex}:${actionIndex}:assign` }]);
  } else if (act.type === "set_variable") {
    msg += `Name: ${escapeHtml(act.name || "")}\nValue: ${escapeHtml(JSON.stringify(act.value) || "")}\n`;
    buttons.push([{ text: "📦 Edit Name", callback_data: `editor:setfield:${botId}:${commandIndex}:${actionIndex}:name` }]);
    buttons.push([{ text: "📝 Edit Value", callback_data: `editor:setfield:${botId}:${commandIndex}:${actionIndex}:value` }]);
  } else {
    msg += `(Visual editing for ${act.type} is limited. Use JSON upload for full control.)\n`;
  }

  buttons.push([{ text: "🗑️ Delete Action", callback_data: `editor:delact:${botId}:${commandIndex}:${actionIndex}` }]);
  buttons.push([{ text: "🔙 Back to Actions", callback_data: `editor:cmd:${botId}:${commandIndex}` }]);

  await tg.sendMessageWithInlineKeyboard(chatId, msg, buttons, { parse_mode: "HTML" });
}

export async function handleEditorCallback(env: Env, req: Request, tg: TelegramClient, cq: TgCallbackQuery, setPending: any): Promise<boolean> {
  const data = cq.data ?? "";
  if (!data.startsWith("editor:")) return false;
  
  const chatId = cq.message?.chat.id;
  if (!chatId) return true;
  
  const parts = data.split(":");
  const action = parts[1];
  const botId = parts[2];
  
  if (action === "cmds") {
    await showCommandsMenu(env, tg, chatId, botId);
  } else if (action === "cmd") {
    await showCommandMenu(env, tg, chatId, botId, parseInt(parts[3]));
  } else if (action === "act") {
    await showActionMenu(env, tg, chatId, botId, parseInt(parts[3]), parseInt(parts[4]));
  } else if (action === "addcmd") {
    const config = await getBotConfig(env, botId) ?? { version: 1, commands: [] };
    config.commands.push({ command: "new_command", actions: [] });
    await saveBotConfig(env, botId, config);
    await showCommandMenu(env, tg, chatId, botId, config.commands.length - 1);
  } else if (action === "delcmd") {
    const config = await getBotConfig(env, botId);
    if (config) {
      config.commands.splice(parseInt(parts[3]), 1);
      await saveBotConfig(env, botId, config);
    }
    await showCommandsMenu(env, tg, chatId, botId);
  } else if (action === "addact") {
    const config = await getBotConfig(env, botId);
    const cIdx = parseInt(parts[3]);
    if (config && config.commands[cIdx]) {
      config.commands[cIdx].actions.push({ type: "send_message", text: "New message" });
      await saveBotConfig(env, botId, config);
      await showActionMenu(env, tg, chatId, botId, cIdx, config.commands[cIdx].actions.length - 1);
    }
  } else if (action === "delact") {
    const config = await getBotConfig(env, botId);
    const cIdx = parseInt(parts[3]);
    const aIdx = parseInt(parts[4]);
    if (config && config.commands[cIdx]) {
      config.commands[cIdx].actions.splice(aIdx, 1);
      await saveBotConfig(env, botId, config);
      await showCommandMenu(env, tg, chatId, botId, cIdx);
    }
  } else if (action === "rencmd") {
    await setPending(env, chatId, { kind: "awaiting_editor_input", botId, commandIndex: parseInt(parts[3]), field: "command_name" });
    await tg.sendMessage(chatId, "Send the new command name (e.g. `start`):", { parse_mode: "Markdown" });
  } else if (action === "setfield") {
    const cIdx = parseInt(parts[3]);
    const aIdx = parseInt(parts[4]);
    const field = parts[5];
    await setPending(env, chatId, { kind: "awaiting_editor_input", botId, commandIndex: cIdx, actionIndex: aIdx, field });
    await tg.sendMessage(chatId, `Send the new value for ${field}:\n\n(Send /cancel to abort)`);
  } else if (action === "scheds") {
    await showSchedulesMenu(env, tg, chatId, botId);
  } else if (action === "delsched") {
    const schedId = parts[3];
    await env.ANALYTICS_DB?.prepare("DELETE FROM bot_schedules WHERE id = ?").bind(schedId).run();
    await showSchedulesMenu(env, tg, chatId, botId);
  } else if (action === "addsched") {
    const config = await getBotConfig(env, botId);
    if (!config || config.commands.length === 0) {
      await tg.sendMessage(chatId, "You need to add at least one command to this bot before scheduling.");
      return true;
    }
    const buttons = config.commands.map(c => [{ text: `/${c.command}`, callback_data: `editor:schedcmd:${botId}:${c.command}` }]);
    buttons.push([{ text: "🔙 Cancel", callback_data: `editor:scheds:${botId}` }]);
    await tg.sendMessageWithInlineKeyboard(chatId, "Select a command to schedule:", buttons);
  } else if (action === "schedcmd") {
    const command = parts[3];
    await tg.sendMessageWithInlineKeyboard(chatId, `Schedule type for /${command}?`, [
      [{ text: "🔄 Recurring (Cron)", callback_data: `editor:schedtype:${botId}:${command}:cron` }],
      [{ text: "⏱️ One-off (Timestamp)", callback_data: `editor:schedtype:${botId}:${command}:once` }],
      [{ text: "🔙 Cancel", callback_data: `editor:scheds:${botId}` }]
    ]);
  } else if (action === "schedtype") {
    const command = parts[3];
    const type = parts[4];
    await setPending(env, chatId, { kind: "awaiting_editor_input", botId, field: "schedule_expr", tempSchedule: { command, type } });
    const instructions = type === "cron" 
      ? "Send a cron expression (e.g. `0 9 * * *` for daily at 9am UTC).\n\n(Send /cancel to abort)" 
      : "Send a Unix timestamp in seconds (e.g. `1712000000`).\n\n(Send /cancel to abort)";
    await tg.sendMessage(chatId, instructions, { parse_mode: "Markdown" });
  }
  
  return true;
}

export async function handleEditorMessage(env: Env, tg: TelegramClient, msg: TgMessage, pending: PendingEditorState, clearPending: any): Promise<boolean> {
  const chatId = msg.chat.id;
  const text = (msg.text ?? "").trim();
  
  const config = await getBotConfig(env, pending.botId);
  if (!config) return true;
  
  if (pending.field === "command_name" && pending.commandIndex !== undefined) {
    if (config.commands[pending.commandIndex]) {
      config.commands[pending.commandIndex].command = text.replace(/^\//, "");
      await saveBotConfig(env, pending.botId, config);
    }
    await clearPending(env, chatId);
    await showCommandMenu(env, tg, chatId, pending.botId, pending.commandIndex);
    return true;
  }
  
  if (pending.actionIndex !== undefined && pending.commandIndex !== undefined) {
    const act = config.commands[pending.commandIndex]?.actions[pending.actionIndex] as any;
    if (act) {
      act[pending.field] = text;
      await saveBotConfig(env, pending.botId, config);
    }
    await clearPending(env, chatId);
    await showActionMenu(env, tg, chatId, pending.botId, pending.commandIndex, pending.actionIndex);
    return true;
  }
  if (pending.field === "schedule_expr" && pending.tempSchedule) {
    const { command, type } = pending.tempSchedule;
    if (type === "cron") {
      try {
        CronExpressionParser.parse(text);
      } catch {
        await tg.sendMessage(chatId, "❌ Invalid cron expression. Please send a valid one (e.g. `0 9 * * *`), or send /cancel.");
        return true;
      }
    } else {
      if (isNaN(Number(text))) {
        await tg.sendMessage(chatId, "❌ Invalid timestamp. Please send a numeric Unix timestamp, or send /cancel.");
        return true;
      }
    }
    const id = crypto.randomUUID().slice(0, 8);
    await env.ANALYTICS_DB?.prepare("INSERT INTO bot_schedules (id, bot_id, command, type, expression) VALUES (?, ?, ?, ?, ?)")
      .bind(id, pending.botId, command, type, text)
      .run();
    await clearPending(env, chatId);
    await tg.sendMessage(chatId, "✅ Schedule saved!");
    await showSchedulesMenu(env, tg, chatId, pending.botId);
    return true;
  }
  
  return false;
}
