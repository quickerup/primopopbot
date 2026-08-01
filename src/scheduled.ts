// ---------------------------------------------------------------------------
// Scheduled handler: runs on the cron trigger defined in wrangler.toml.
// Queries D1 for the top 10 events per bot over the past 7 days and sends
// a weekly analytics digest to the factory owner via PrimoPopBot.
// ---------------------------------------------------------------------------

import { Env } from "./env";
import { TelegramClient } from "./telegram";
import { BotRecord } from "./dsl/types";

interface EventRow {
  bot_id: string;
  event_name: string;
  value: string;
  count: number;
}

export async function handleScheduled(env: Env): Promise<void> {
  if (!env.ANALYTICS_DB || !env.FACTORY_OWNER_ID) return;

  const factoryRaw = await env.BOT_KV.get("bot:factory");
  if (!factoryRaw) return;
  const { token: factoryToken } = JSON.parse(factoryRaw) as BotRecord;
  const tg = new TelegramClient(factoryToken);

  const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60; // 7 days ago

  // Top 10 events globally, grouped by bot + event name + value
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

  // Group by bot for a clean report
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
