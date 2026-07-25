-- ステップ⑤(§17.4): 会員が自分のリクエスト一覧から終了状態の行を隠せるフラグ（記録自体は保全・管理画面には残す）。
ALTER TABLE requests ADD COLUMN hidden_by_member INTEGER NOT NULL DEFAULT 0;

-- ステップ⑤(§17.1): 時間枠テンプレート廃止に伴う「受付時間帯」設定のシード（既定 10:00〜21:00・30分刻み）。
-- 旧 'slots' 行（0001シード）は残置するが getSettings は Task 6 以降読まない（無害）。
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('open_start', '10:00'),
  ('open_end', '21:00');
