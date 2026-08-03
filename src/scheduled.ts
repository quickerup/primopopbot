// ---------------------------------------------------------------------------
// Scheduled handler: runs on cron triggers defined in wrangler.toml.
// - "0 9 * * MON": Weekly analytics digest
// - "* * * * *": Executes bot command schedules
// ---------------------------------------------------------------------------

import { Env } from "./env";
import { TelegramClient } from "./telegram";
import { BotRecord } from "./dsl/types";
import { findCommand } from "./dsl/schema";
import { runActions } from "./dsl/interpreter";
import { SessionClient } from "./session-client";
import { loadSecrets } from "./secrets";
import { CronExpressionParser } from "cron-parser";
import { BotConfig } from "./dsl/types";

interface EventRow {
  bot_id: string;
  event_name: string;
  value: string;
  count: number;
}

interface ScheduleRow {
  id: string;
  bot_id: string;
  command: string;
  type: string;
  expression: string;
  last_run: number;
}

export async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  if (event.cron === "0 9 * * MON") {
    await runAnalyticsWeekly(env);
  } else if (event.cron === "* * * * *") {
    await runBotSchedules(event, env);
  }
}

async function runBotSchedules(event: ScheduledEvent, env: Env): Promise<void> {
  if (!env.ANALYTICS_DB) return;

  const schedules = await env.ANALYTICS_DB.prepare("SELECT * FROM bot_schedules").all<ScheduleRow>();
  if (!schedules.results || schedules.results.length === 0) return;

  const now = event.scheduledTime;
  const toRun: ScheduleRow[] = [];

  for (const row of schedules.results) {
    if (row.type === "once") {
      const onceTime = Number(row.expression) * 1000;
      if (onceTime <= now && row.last_run === 0) {
        toRun.push(row);
      }
    } else if (row.type === "cron") {
      try {
        const interval = CronExpressionParser.parse(row.expression, { 
          currentDate: new Date(now - 60000)
        });
        const next = interval.next().getTime();
        if (Math.abs(next - now) < 60000) {
          toRun.push(row);
        }
      } catch (err) {
        console.error(`Invalid cron expression for schedule ${row.id}: ${row.expression}`);
      }
    } else if (row.type === "interval") {
      const intervalMs = Number(row.expression) * 1000;
      if (intervalMs > 0) {
        const lastRun = row.last_run ? row.last_run * 1000 : 0;
        if (now - lastRun >= intervalMs) {
          toRun.push(row);
        }
      }
    }
  }

  for (const row of toRun) {
    try {
      const botRaw = await env.BOT_KV.get(`bot:${row.bot_id}`);
      const configRaw = await env.BOT_KV.get(`config:${row.bot_id}`);
      if (!botRaw || !configRaw) continue;
      
      const botRecord = JSON.parse(botRaw) as BotRecord;
      const tg = new TelegramClient(botRecord.token);
      const session = new SessionClient(env.CHAT_SESSION, row.bot_id, Number(botRecord.ownerId));
      const config = JSON.parse(configRaw) as BotConfig;
      
      const cmdDef = findCommand(config, row.command);
      if (!cmdDef) continue;

      const vars = await session.getVars();
      await runActions({
        tg,
        session,
        botId: row.bot_id,
        visibility: botRecord.visibility,
        chatId: Number(botRecord.ownerId),
        user: { id: Number(botRecord.ownerId), first_name: "Owner" },
        secrets: await loadSecrets(env.BOT_KV, row.bot_id, env.SECRET_PASSPHRASE),
        analyticsDb: env.ANALYTICS_DB
      }, cmdDef, cmdDef.actions, 0, vars);

      await env.ANALYTICS_DB.prepare("UPDATE bot_schedules SET last_run = ? WHERE id = ?")
        .bind(Math.floor(now / 1000), row.id)
        .run();

    } catch (err) {
      console.error(`Error running schedule ${row.id}:`, err);
    }
  }
}

async function runAnalyticsWeekly(env: Env): Promise<void> {
  if (!env.ANALYTICS_DB || !env.FACTORY_OWNER_ID) return;

  const factoryRaw = await env.BOT_KV.get("bot:factory");
  if (!factoryRaw) return;
  const { token: factoryToken } = JSON.parse(factoryRaw) as BotRecord;
  const tg = new TelegramClient(factoryToken);

  const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60; // 7 days ago

  const result = await env.ANALYTICS_DB
    .prepare(
      `SELECT bot_id, event_name, value, COUNT(*) as count
       FROM search_log
       WHERE ts >= ?
       GROUP BY bot_id, event_name, value
       ORDER BY count DESC
       LIMIT 10`
    )
    .bind(since)
    .all<EventRow>();

  if (!result.results || result.results.length === 0) {
    await tg.sendMessage(
      env.FACTORY_OWNER_ID,
      "📊 <b>Weekly Analytics Report</b>\n\nNo events logged in the past 7 days."
    );
    return;
  }

  const byBot = new Map<string, EventRow[]>();
  for (const row of result.results) {
    const list = byBot.get(row.bot_id) ?? [];
    list.push(row);
    byBot.set(row.bot_id, list);
  }

  let report = "📊 <b>Weekly Analytics Report</b>\n";
  report += `<i>${new Date().toUTCString().slice(0, 16)}</i>\n`;

  for (const [botId, rows] of byBot.entries()) {
    report += `\n🤖 <b>@${botId}</b>\n`;
    for (const row of rows) {
      report += `  • <code>${row.event_name}</code>: ${row.value} — ${row.count}×\n`;
    }
  }

  await tg.sendMessage(env.FACTORY_OWNER_ID, report, { parse_mode: "HTML" });
}
