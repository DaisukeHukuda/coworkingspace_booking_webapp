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

## 現在の機能（ステップ①）

- 管理画面ログイン（パスワード＋30日セッション）
- 会員管理: 登録（名前・メール・種別）・編集・無効化・専用リンク発行/再発行
- 会員ページ: 専用リンクで本人確認（予約機能はステップ②で追加）

## 開発ステップ

1. 基盤 — 会員管理と専用リンク発行 ← いまここ
2. リクエストの流れ — 空き表示・リクエスト送信・確定/否認・メール通知（ここで運用開始）
3. Square自動同期 — Bookings APIで空き枠を15分ごとに取得
4. 回数券の残数管理
