-- Workers AI の使いすぎを防ぐ：1人1日あたりの回数
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,             -- YYYY-MM-DD（UTC）
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
