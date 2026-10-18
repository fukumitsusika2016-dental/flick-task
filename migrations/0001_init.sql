-- Flick のデータベース（Cloudflare D1 / SQLite）

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,           -- google:<sub>
  email TEXT NOT NULL,
  name TEXT,
  picture TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,           -- ログイン用トークンのSHA-256（トークンそのものは保存しない）
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,           -- 端末で作るID（オフラインでも追加できるように）
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'done')),
  moved_at INTEGER NOT NULL,     -- 並び順（作った時・ステータスを変えた時）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_user ON tasks(user_id, moved_at DESC);
