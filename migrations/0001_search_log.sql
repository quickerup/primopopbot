CREATE TABLE IF NOT EXISTS search_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id     TEXT    NOT NULL,
  event_name TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  chat_id    INTEGER NOT NULL,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_log_lookup ON search_log(event_name, ts);
