CREATE TABLE requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id),
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'declined', 'cancelled')),
  member_note TEXT NOT NULL DEFAULT '',
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_requests_member ON requests (member_id, date);
CREATE INDEX idx_requests_status_date ON requests (status, date);
-- 二重リクエスト防止: アクティブ（申請中/確定）な行だけを対象にした部分UNIQUE
CREATE UNIQUE INDEX ux_requests_active ON requests (member_id, date, start_time)
  WHERE status IN ('pending', 'confirmed');

CREATE TABLE closed_dates (
  date TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT ''
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES
  ('slots', '[{"start":"10:00","end":"13:00"},{"start":"13:00","end":"17:00"},{"start":"17:00","end":"21:00"}]'),
  ('window_days', '60'),
  ('staff_email', '');

CREATE TABLE email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  to_address TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE login_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_login_failures_ip ON login_failures (ip, created_at);
