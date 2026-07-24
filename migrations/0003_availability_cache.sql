-- Square Bookings API から取得した「日ごとの空き開始時刻」をキャッシュする（ステップ③・読み取り専用）。
-- slots_json は開始時刻（'HH:MM'）の配列。行が有る=その日は取得済み（空配列なら満枠）、行が無い=未取得。
CREATE TABLE availability_cache (
  date TEXT PRIMARY KEY,
  slots_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
