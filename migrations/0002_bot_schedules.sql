CREATE TABLE IF NOT EXISTS bot_schedules (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  command TEXT NOT NULL,
  type TEXT NOT NULL,
  expression TEXT NOT NULL,
  last_run INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bot_schedules_bot_id ON bot_schedules(bot_id);
