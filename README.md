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

## 現在の機能（ステップ③まで）

### 会員ページ（専用リンク・ログイン不要）
- 月カレンダーで空き確認（過去・受付期間外・受付停止日は選択不可）
- 日付＋時間枠を選んでリクエスト送信（ひとことメモ付き・二重リクエスト防止）
- 自分のリクエスト一覧（申請中/確定/否認/キャンセル済み）とキャンセル
- 確定/否認の結果はメールで自動通知

### 管理画面
- 承認待ち一覧から確定/否認（否認理由を添えられる。Square同期中は「埋まった可能性」を警告表示）
- リクエスト一覧（状態・会員・期間で絞り込み）
- 会員管理: 登録・編集・無効化・専用リンク発行/再発行
- 受付停止日の設定/解除
- 設定: スタッフ通知先メール・受付可能期間・時間枠テンプレート・Square連携
- ログイン試行制限（15分に10回失敗で一時ブロック）

### Square自動同期（ステップ③・読み取り専用）
- 15分ごとの cron で Bookings API から空き枠を取得し `availability_cache` に保存
- 同期有効時は会員ページの空き表示・リクエスト受付がキャッシュに従う
- 取得が24時間以上止まるとスタッフへ通知メール
- **Square設定（ロケーション/サービスID）が未設定の間は従来どおりの手動モード**

### メール通知（Resend）
- リクエスト送信/キャンセル → スタッフ宛、確定/否認 → 会員宛、同期停止(24h) → スタッフ宛
- RESEND_API_KEY 未設定時は送信せず email_log に記録のみ（開発中の誤送信防止）

## Square連携のセットアップ

Square の空き枠をアプリに取り込むための初期設定です。ロケーション/サービスIDを入れるまでは同期無効（手動モード）のままなので、準備ができてから設定してください。

1. **アクセストークンを発行**: Square Developer ダッシュボード（developer.squareup.com）→ アプリを作成 → 本番用の Production Access Token を取得（読み取りのみで可・無料・5分程度）
2. **ID を調べる**:
   - `location_id`: Square ダッシュボード、または API `GET /v2/locations` で確認
   - `service_variation_id`: 予約対象のサービス（アイテムのバリエーション）のID
3. **トークンをサーバーに登録**: 本番は `npx wrangler secret put SQUARE_ACCESS_TOKEN`／ローカルは `.dev.vars` の `SQUARE_ACCESS_TOKEN`
4. **管理画面で ID を入力**: /admin → 設定 → Square連携 に location_id と service_variation_id を入力して保存（両方入れると「同期有効」になる）
5. **結合確認**: 設定画面の「今すぐ同期」を押す → 「Squareと同期しました」が出れば成功。会員ページを開き、空き枠がSquareの内容と一致することを確認

> sandbox で試す場合は env `SQUARE_API_BASE` を `https://connect.squareupsandbox.com` に設定します（既定は本番 `https://connect.squareup.com`）。

## 本番デプロイ（初回）

1. `wrangler d1 create torch-member-booking` を実行し、出力の database_id を wrangler.jsonc に反映
2. `npx wrangler d1 migrations apply torch-member-booking --remote`
3. `npx wrangler secret put ADMIN_PASSWORD` / `SESSION_SECRET` / `RESEND_API_KEY` / `NOTIFY_EMAIL_FROM`（Square連携する場合は `SQUARE_ACCESS_TOKEN` も）
4. （任意）`npx wrangler secret put APP_ORIGIN` にメールのリンク用の絶対URL（例 https://torch-member-booking.example.workers.dev）を設定
5. `npm run deploy`（cron `*/15 * * * *` も一緒に登録される）
6. 管理画面 → 設定 でスタッフ通知先メールを入力。Square連携する場合はロケーション/サービスIDも入力

## 福田さん向け: Square同期の動作確認手順

エンジニアでなくても確認できます（管理画面と会員ページだけで完結します）。

1. /admin → 設定 → 「Square連携」に、用意した location_id と service_variation_id を入力して「保存」
2. 状態が「同期有効」になることを確認
3. 「今すぐ同期」を押す → 「Squareと同期しました」と出る（出ない場合はIDやアクセストークンを確認）
4. 会員の専用リンクを開き、カレンダーで日付を選ぶ → 表示される時間枠がSquareの空き状況と一致することを確認
5. Square側で一つ枠を埋める（テスト予約を入れる）→ 「今すぐ同期」後に会員ページの該当枠が消えることを確認
6. 一致していれば同期は成功。IDを空にして保存すれば、いつでも手動モードに戻せます

## 開発ステップ

1. 基盤 — 会員管理と専用リンク発行（完了）
2. リクエストの流れ — 空き表示・リクエスト・確定/否認・メール通知（完了・運用開始可能）
3. Square自動同期 — Bookings APIで空き枠を15分ごとに取得（完了）
4. 回数券の残数管理 ← 次
