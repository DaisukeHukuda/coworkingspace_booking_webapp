# TORCH 会員予約

TORCH Coworking の月額会員・回数券ユーザー向け予約リクエストシステム。
Cloudflare Workers + Hono + D1 で動作します。

## セットアップ

    npm install
    cp .dev.vars.example .dev.vars   # パスワード等を書き換える
    npx wrangler d1 migrations apply torch-member-booking --local
    npm run dev                      # http://localhost:8787

- ヘルスチェック: GET /health
- 管理画面: /admin （.dev.vars の ADMIN_PASSWORD でログイン）
- 会員ページ: /m/{トークン} （管理画面で会員登録すると発行される）

## テスト

    npm test           # 全テスト実行
    npm run typecheck  # 型チェック

## ドキュメント

- 設計書: docs/superpowers/specs/2026-07-23-torch-member-booking-design.md
- 実装計画: docs/superpowers/plans/

## 現在の機能（ステップ②まで）

### 会員ページ（専用リンク・ログイン不要）
- 月カレンダーで空き確認（過去・受付期間外・受付停止日は選択不可）
- 日付＋時間枠を選んでリクエスト送信（ひとことメモ付き・二重リクエスト防止）
- 自分のリクエスト一覧（申請中/確定/否認/キャンセル済み）とキャンセル
- 確定/否認の結果はメールで自動通知

### 管理画面
- 承認待ち一覧から確定/否認（否認理由を添えられる）
- リクエスト一覧（状態・会員・期間で絞り込み）
- 会員管理: 登録・編集・無効化・専用リンク発行/再発行
- 受付停止日の設定/解除
- 設定: スタッフ通知先メール・受付可能期間・時間枠テンプレート
- ログイン試行制限（15分に10回失敗で一時ブロック）

### メール通知（Resend）
- リクエスト送信/キャンセル → スタッフ宛、確定/否認 → 会員宛
- RESEND_API_KEY 未設定時は送信せず email_log に記録のみ（開発中の誤送信防止）

## 本番デプロイ（初回）

1. `wrangler d1 create torch-member-booking` を実行し、出力の database_id を wrangler.jsonc に反映
2. `npx wrangler d1 migrations apply torch-member-booking --remote`
3. `npx wrangler secret put ADMIN_PASSWORD` / `SESSION_SECRET` / `RESEND_API_KEY` / `NOTIFY_EMAIL_FROM`
4. `npm run deploy`
5. 管理画面 → 設定 でスタッフ通知先メールを入力

## 開発ステップ

1. 基盤 — 会員管理と専用リンク発行（完了）
2. リクエストの流れ — 空き表示・リクエスト・確定/否認・メール通知（完了・ここで運用開始可能）
3. Square自動同期 — Bookings APIで空き枠を15分ごとに取得 ← 次
4. 回数券の残数管理
