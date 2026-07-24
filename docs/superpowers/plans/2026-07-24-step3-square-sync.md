# TORCH会員予約システム ステップ③（Square自動同期）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Square の Bookings API から空き枠を15分ごと（cron）に取得してキャッシュし、会員ページの空き表示・リクエスト送信の検証・承認画面の警告に反映する。**同期が無効な間はステップ②の手動モードと1ビットも変わらない挙動を保つ**（設計書 §12 ステップ③）。完了条件は「Squareで枠を閉じるとアプリの表示も変わる」こと。

**Architecture:** ステップ②の土台の上に、(1) `availability_cache` テーブルと設定コアのSquare拡張、(2) 純粋な同期コア `src/core/square.ts`（Bookings API `SearchAvailability` を今日〜受付期間で**31日ずつチャンク取得**し日別に upsert・**絶対に例外を投げない**）、(3) Workers cron（15分）→ `src/core/scheduled.ts` の `runScheduled`（同期・`login_failures` 掃除・24h同期停止時のスタッフ通知）、(4) 会員ページ・承認画面・設定画面の同期対応、(5) ステップ②持ち越しの仕上げ（`saveSettings` バッチ化・`weekdayOf` 共通化・メールリンクの `APP_ORIGIN`）を積む。Squareへは**書き込まない（読み取り専用）**。

**Tech Stack:** ステップ②と同一（Hono 4.12.28 / wrangler 4.107.0 / D1 / vitest 3.2.7 + vitest-pool-workers 0.12.21 / TypeScript 6.0.3）。Square Bookings API を `fetch` で直接叩く（SDK不使用・**新規依存なし**）。cron は Workers の `scheduled` ハンドラ。

## Global Constraints

- 設計書: `docs/superpowers/specs/2026-07-23-torch-member-booking-design.md` の §5.3 / §6 / §7 / §8 / §9 / §12 / §16（本計画は §12 ステップ③のみ。回数券 `ticket_events`・Squareへの書き込み・Webhook は**作らない**）
- 作業ディレクトリ: `/Users/daisukefukuda/Projects/coworkingspace_booking_webapp/`（記号入りの旧パスで `npm test` を実行しない）
- **同期無効時は現行動作を1ビットも変えない**（最重要・後方互換の生命線）。Square設定 `square_location_id`・`square_service_variation_id` の**両方が非空**のときだけ「同期有効」。どちらか空なら同期無効＝ステップ②の手動モードのまま。既存87テストは同期無効を前提にしているので**1件も壊さない**
- 日付はすべて **JST基準**。「今日」は `currentJstDate()`（UTC+9固定）。Square応答の `start_at`（RFC3339・UTC等のオフセット付き）は `Date.parse(start_at) + 9時間` で JST の `YYYY-MM-DD` と `HH:MM` に変換する
- Square同期・通知・スケジュールの各処理は **絶対に例外を投げない**（`notify.ts` と同じ二重 try/catch 思想。失敗は戻り値 `{ ok: false, error }` で表す）。**実Square APIをテストで叩かない**（`fetcher` 注入のモックのみ）
- Square応答は **防御的にパースする**。想定形状は `{ availabilities: [{ start_at: string, ... }] }`。`availabilities` が配列でない・`start_at` が文字列でない/暦不正でも例外にせず、その分だけ無視して継続する。実APIとの形状差異はステップ③の**結合確認時に吸収**する
- 認証情報は Workers secret `SQUARE_ACCESS_TOKEN`（Bindings に optional で追加）。APIベースURLは env `SQUARE_API_BASE`（optional・既定 `https://connect.squareup.com`・sandbox切替用）。トークンをコード・ログ・エラーメッセージに出さない（設計書 §10）
- UI文言はすべて日本語・丁寧語。管理画面は簡潔な日本語。アプリ表示名「TORCH 会員予約」
- 各タスク完了時: `npm test` と `npm run typecheck` が全部通ってからコミット。コミットメッセージは `feat:`/`fix:`/`chore:` プレフィックス＋日本語
- テスト名は日本語でよい。miniflare の `MF-Vitest-Source` 非ASCII警告は既知の無害な挙動
- バージョンは完全固定（`package.json` は現状のまま）。**新規依存は追加しない**（Square連携は fetch のみで実装）
- 既存テストの改変は **Task 3 の「default import → named import への置換」だけ**（`export default app` を Workers ハンドラ化するため。10ファイル・機械的置換）。それ以外の既存テストは書き換えない

---

### Task 1: スキーマ0003（availability_cache）・設定コアのSquare拡張・日付コア追加

**Files:**
- Create: `migrations/0003_availability_cache.sql`
- Modify: `src/core/settings.ts`（全文差し替え: Square設定・`syncEnabled`・`saveSettings` 追加）
- Modify: `src/core/dates.ts`（追記: `weekdayOf` / `formatStampJst`）
- Modify: `src/types.ts`（全文差し替え: Bindings に Square/APP_ORIGIN を追加・`AvailabilityCacheRow` 追加）
- Test: `test/schema3.test.ts`
- Test: `test/settings.test.ts`（4ケース追記）
- Test: `test/dates.test.ts`（2ケース追記）

**Interfaces:**
- Consumes: `settings` テーブル（ステップ②）、`WEEKDAY_LABELS`（dates.ts）
- Produces:
  - `availability_cache(date PRIMARY KEY, slots_json, fetched_at)` テーブル。行が有る＝その日は取得済み（空配列 `[]` なら満枠）、行が無い＝未取得
  - `settings.ts`: `AppSettings` に `squareLocationId: string` / `squareServiceVariationId: string` / `syncEnabled: boolean` を追加。`SettingKey` 型／`saveSettings(db, entries: { key: SettingKey; value: string }[]): Promise<void>`（`db.batch`）
  - `dates.ts`: `weekdayOf(date: string): string` / `formatStampJst(iso: string): string`
  - `types.ts`: `Bindings` に `APP_ORIGIN?`・`SQUARE_ACCESS_TOKEN?`・`SQUARE_API_BASE?`。`AvailabilityCacheRow` 型

- [ ] **Step 1: 失敗するテストを書く**

`test/schema3.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

const UPSERT = `INSERT INTO availability_cache (date, slots_json, fetched_at)
  VALUES (?, ?, ?)
  ON CONFLICT(date) DO UPDATE SET slots_json = excluded.slots_json, fetched_at = excluded.fetched_at`;

describe('step3 schema', () => {
  it('availability_cache に読み書きできる', async () => {
    await env.DB.prepare(UPSERT).bind('2026-08-01', '["10:00","13:00"]', '2026-07-24T00:00:00.000Z').run();
    const row = await env.DB.prepare('SELECT * FROM availability_cache WHERE date = ?')
      .bind('2026-08-01').first<{ date: string; slots_json: string; fetched_at: string }>();
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.slots_json)).toEqual(['10:00', '13:00']);
    expect(row!.fetched_at).toBe('2026-07-24T00:00:00.000Z');
  });

  it('date は主キーで upsert により上書きされる', async () => {
    await env.DB.prepare(UPSERT).bind('2026-08-02', '["10:00"]', '2026-07-24T00:00:00.000Z').run();
    await env.DB.prepare(UPSERT).bind('2026-08-02', '["13:00","17:00"]', '2026-07-24T01:00:00.000Z').run();
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM availability_cache WHERE date = ?')
      .bind('2026-08-02').first<{ n: number }>();
    expect(count!.n).toBe(1);
    const row = await env.DB.prepare('SELECT slots_json, fetched_at FROM availability_cache WHERE date = ?')
      .bind('2026-08-02').first<{ slots_json: string; fetched_at: string }>();
    expect(JSON.parse(row!.slots_json)).toEqual(['13:00', '17:00']);
    expect(row!.fetched_at).toBe('2026-07-24T01:00:00.000Z');
  });

  it('空配列（満枠日）も保存でき、未取得日（行なし）と区別できる', async () => {
    await env.DB.prepare(UPSERT).bind('2026-08-03', '[]', '2026-07-24T00:00:00.000Z').run();
    const present = await env.DB.prepare('SELECT slots_json FROM availability_cache WHERE date = ?')
      .bind('2026-08-03').first<{ slots_json: string }>();
    expect(present).not.toBeNull();
    expect(JSON.parse(present!.slots_json)).toEqual([]);
    const absent = await env.DB.prepare('SELECT slots_json FROM availability_cache WHERE date = ?')
      .bind('2026-08-04').first();
    expect(absent).toBeNull(); // 未取得日は行が無い
  });
});
```

`test/settings.test.ts` の import 行を差し替え（`saveSettings` を追加）:

```ts
import { getSettings, setSetting, saveSettings, parseSlotsText, slotsToText, findSlot, DEFAULT_SLOTS } from '../src/core/settings';
```

`describe('settings')` の末尾（`slotsToText と findSlot` テストの後）に4ケース追加:

```ts
  it('Square未設定なら syncEnabled は false で ID は空', async () => {
    const s = await getSettings(env.DB);
    expect(s.squareLocationId).toBe('');
    expect(s.squareServiceVariationId).toBe('');
    expect(s.syncEnabled).toBe(false);
  });

  it('ロケーションIDとサービスIDが両方あれば syncEnabled は true', async () => {
    await setSetting(env.DB, 'square_location_id', 'LOC123');
    await setSetting(env.DB, 'square_service_variation_id', 'SV456');
    const s = await getSettings(env.DB);
    expect(s.squareLocationId).toBe('LOC123');
    expect(s.squareServiceVariationId).toBe('SV456');
    expect(s.syncEnabled).toBe(true);
  });

  it('片方だけの設定では syncEnabled は false（無効のまま）', async () => {
    await setSetting(env.DB, 'square_location_id', 'LOC123');
    const s = await getSettings(env.DB);
    expect(s.syncEnabled).toBe(false);
  });

  it('saveSettings は複数キーを一括保存できる', async () => {
    await saveSettings(env.DB, [
      { key: 'staff_email', value: 'batch@example.com' },
      { key: 'window_days', value: '45' },
      { key: 'square_location_id', value: 'LOCX' }
    ]);
    const s = await getSettings(env.DB);
    expect(s.staffEmail).toBe('batch@example.com');
    expect(s.windowDays).toBe(45);
    expect(s.squareLocationId).toBe('LOCX');
  });
```

`test/dates.test.ts` の import 文に `weekdayOf` と `formatStampJst` を追加し、末尾（最後のテストの後・`});` の直前）に2ケース追加:

```ts
  it('weekdayOf は日付の曜日ラベルを返す', () => {
    expect(weekdayOf('2026-07-24')).toBe('金'); // 2026-07-24 は金曜
    expect(weekdayOf('2026-07-26')).toBe('日');
  });

  it('formatStampJst は UTC時刻を JST の「M月D日 H時MM分」に整形する', () => {
    expect(formatStampJst('2026-07-24T00:30:00.000Z')).toBe('7月24日 9時30分'); // UTC 00:30 → JST 09:30
    expect(formatStampJst('2026-07-24T15:05:00.000Z')).toBe('7月25日 0時05分'); // 日付跨ぎ
  });
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（`no such table: availability_cache` / `saveSettings` が未定義 / `weekdayOf` が未定義）

- [ ] **Step 3: マイグレーションとコアを実装**

`migrations/0003_availability_cache.sql`:

```sql
-- Square Bookings API から取得した「日ごとの空き開始時刻」をキャッシュする（ステップ③・読み取り専用）。
-- slots_json は開始時刻（'HH:MM'）の配列。行が有る=その日は取得済み（空配列なら満枠）、行が無い=未取得。
CREATE TABLE availability_cache (
  date TEXT PRIMARY KEY,
  slots_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
```

`src/core/settings.ts`（全文差し替え）:

```ts
export interface Slot {
  start: string; // 'HH:MM'
  end: string;   // 'HH:MM'
}

export interface AppSettings {
  slots: Slot[];
  windowDays: number;
  staffEmail: string;
  squareLocationId: string;
  squareServiceVariationId: string;
  syncEnabled: boolean; // squareLocationId と squareServiceVariationId が両方非空なら true
}

export type SettingKey =
  | 'slots'
  | 'window_days'
  | 'staff_email'
  | 'square_location_id'
  | 'square_service_variation_id';

export const DEFAULT_SLOTS: Slot[] = [
  { start: '10:00', end: '13:00' },
  { start: '13:00', end: '17:00' },
  { start: '17:00', end: '21:00' }
];
export const DEFAULT_WINDOW_DAYS = 60;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function getSettings(db: D1Database): Promise<AppSettings> {
  const rows = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const map = new Map(rows.results.map((r) => [r.key, r.value]));

  let slots = DEFAULT_SLOTS;
  const slotsRaw = map.get('slots');
  if (slotsRaw) {
    try {
      const parsed = JSON.parse(slotsRaw);
      // 形だけでなくドメイン条件（時刻形式・開始<終了・1件以上）も検証する。
      // 保存経路は parseSlotsText で検証するが、DB直接編集等で壊れた値が入っても
      // 「壊れた設定値はデフォルトにフォールバック」の制約を守るための多層防御
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every(
          (s) =>
            typeof s?.start === 'string' && typeof s?.end === 'string' &&
            TIME_RE.test(s.start) && TIME_RE.test(s.end) && s.start < s.end
        )
      ) {
        slots = parsed;
      }
    } catch {
      // 壊れた値はデフォルトにフォールバック（設定画面から保存し直せば直る）
    }
  }

  const windowRaw = Number(map.get('window_days'));
  const windowDays = Number.isInteger(windowRaw) && windowRaw >= 1 && windowRaw <= 365 ? windowRaw : DEFAULT_WINDOW_DAYS;

  const squareLocationId = (map.get('square_location_id') ?? '').trim();
  const squareServiceVariationId = (map.get('square_service_variation_id') ?? '').trim();
  const syncEnabled = squareLocationId !== '' && squareServiceVariationId !== '';

  return {
    slots,
    windowDays,
    staffEmail: map.get('staff_email') ?? '',
    squareLocationId,
    squareServiceVariationId,
    syncEnabled
  };
}

export async function setSetting(db: D1Database, key: SettingKey, value: string): Promise<void> {
  await db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(key, value).run();
}

// 複数の設定キーを1回のD1バッチ（暗黙トランザクション）で保存する。
// 設定画面の保存で複数キーをまとめて書くのに使う（ステップ②持ち越し: setSetting3連の解消）
export async function saveSettings(db: D1Database, entries: { key: SettingKey; value: string }[]): Promise<void> {
  if (entries.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  await db.batch(entries.map((e) => stmt.bind(e.key, e.value)));
}

// 1行1枠「HH:MM-HH:MM」。空行・前後空白は無視し、開始時刻順に整列して返す。不正は null
export function parseSlotsText(text: string): Slot[] | null {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0 || lines.length > 10) return null;
  const slots: Slot[] = [];
  for (const line of lines) {
    const m = line.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
    if (!m) return null;
    const [, start, end] = m;
    if (!TIME_RE.test(start) || !TIME_RE.test(end) || start >= end) return null;
    slots.push({ start, end });
  }
  slots.sort((a, b) => (a.start < b.start ? -1 : 1));
  for (let i = 1; i < slots.length; i++) {
    if (slots[i].start === slots[i - 1].start) return null;
  }
  return slots;
}

export function slotsToText(slots: Slot[]): string {
  return slots.map((s) => `${s.start}-${s.end}`).join('\n');
}

export function findSlot(slots: Slot[], start: string): Slot | null {
  return slots.find((s) => s.start === start) ?? null;
}
```

`src/core/dates.ts` の末尾（`isValidMonth` の後）に2つの関数を追記:

```ts
// 'YYYY-MM-DD' の曜日ラベル。日付だけなのでUTCで曜日を取れば十分（member.tsx/requests.tsx で共通利用）
export function weekdayOf(date: string): string {
  return WEEKDAY_LABELS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

// UTCのISO時刻文字列を JST の「M月D日 H時MM分」に整形する（空き情報の取得時刻の表示用）
export function formatStampJst(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${d.getUTCHours()}時${String(d.getUTCMinutes()).padStart(2, '0')}分`;
}
```

`src/types.ts`（全文差し替え）:

```ts
export type Bindings = {
  DB: D1Database;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  RESEND_API_KEY?: string;
  NOTIFY_EMAIL_FROM?: string;
  APP_ORIGIN?: string;         // メール本文の管理画面リンクに使う絶対URL（未設定ならリクエストoriginを使う）
  SQUARE_ACCESS_TOKEN?: string; // Square Bookings API のアクセストークン（secret）
  SQUARE_API_BASE?: string;     // Square APIのベースURL（未設定なら https://connect.squareup.com）
};

export type MemberType = 'monthly' | 'ticket';

export interface MemberRow {
  id: number;
  name: string;
  email: string;
  member_type: MemberType;
  token: string;
  is_active: number; // 1 | 0
  created_at: string;
}

export type RequestStatus = 'pending' | 'confirmed' | 'declined' | 'cancelled';

export interface RequestRow {
  id: number;
  member_id: number;
  date: string;       // 'YYYY-MM-DD'
  start_time: string; // 'HH:MM'
  end_time: string;   // 'HH:MM'
  status: RequestStatus;
  member_note: string;
  admin_note: string;
  created_at: string;
  updated_at: string;
}

export interface AvailabilityCacheRow {
  date: string;       // 'YYYY-MM-DD'
  slots_json: string; // JSON配列文字列（開始時刻 'HH:MM' の配列）
  fetched_at: string; // ISO文字列（UTC）
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（schema3 3件＋settings 4件＋dates 2件を含む累計 **96 件**）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5: ローカル開発DBにも適用してコミット**

Run: `npx wrangler d1 migrations apply torch-member-booking --local`
Expected: `0003_availability_cache.sql` が適用される（確認プロンプトが出たら y）

```bash
git add migrations/0003_availability_cache.sql src/core/settings.ts src/core/dates.ts src/types.ts test/schema3.test.ts test/settings.test.ts test/dates.test.ts
git commit -m "feat: availability_cacheスキーマと設定コアのSquare拡張（syncEnabled/saveSettings/日付ヘルパ）"
```

---

### Task 2: Square同期コア（syncAvailability・キャッシュ読み出し）

**Files:**
- Create: `src/core/square.ts`
- Test: `test/square.test.ts`

**Interfaces:**
- Consumes: `availability_cache`（Task 1）、`getSettings`/`syncEnabled`（Task 1）、`currentJstDate`/`addDays`/`clampDate`（dates.ts）
- Produces: `src/core/square.ts`:
  - `SyncResult { ok: boolean; days: number; error?: string }`
  - `syncAvailability(db, env: { SQUARE_ACCESS_TOKEN?: string; SQUARE_API_BASE?: string }, fetcher?: typeof fetch): Promise<SyncResult>` — 今日〜今日+windowDays を31日ずつ取得し日別 upsert。**絶対に例外を投げない**
  - `getCachedStarts(db, from, to): Promise<Map<string, string[]>>` — 日付→開始時刻配列（行がある日だけキー・空配列＝満枠）
  - `getCacheStatus(db): Promise<{ days: number; lastFetched: string | null }>`

- [ ] **Step 1: 失敗するテストを書く**

`test/square.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { syncAvailability, getCachedStarts, getCacheStatus } from '../src/core/square';
import { setSetting } from '../src/core/settings';
import { currentJstDate, addDays } from '../src/core/dates';

// Square設定を有効化する（両IDを入れる）。windowDays を任意に上書きできる。
async function enableSquare(windowDays?: number): Promise<void> {
  await setSetting(env.DB, 'square_location_id', 'LOC');
  await setSetting(env.DB, 'square_service_variation_id', 'SV');
  if (windowDays !== undefined) await setSetting(env.DB, 'window_days', String(windowDays));
}

// availabilities を返すモック fetcher を作る。呼び出し記録も返す。
function mockFetcher(availabilities: { start_at: string }[]) {
  const calls: { url: string; body: unknown }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init!.body)) });
    return new Response(JSON.stringify({ availabilities }), { status: 200 });
  }) as typeof fetch;
  return { fetcher, calls };
}

const SQUARE_ENV = { SQUARE_ACCESS_TOKEN: 'tok' };

describe('syncAvailability', () => {
  it('同期無効（Square未設定）なら fetcher を呼ばず sync_disabled を返す', async () => {
    let called = false;
    const fetcher = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
    const result = await syncAvailability(env.DB, SQUARE_ENV, fetcher);
    expect(result).toEqual({ ok: false, days: 0, error: 'sync_disabled' });
    expect(called).toBe(false);
  });

  it('アクセストークン未設定なら sync_disabled を返す', async () => {
    await enableSquare();
    const result = await syncAvailability(env.DB, {}, (async () => new Response('{}')) as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('sync_disabled');
  });

  it('応答の start_at を JST の開始時刻に変換して日別にupsertする', async () => {
    await enableSquare(5); // 今日〜今日+5 = 6日
    const day = addDays(currentJstDate(), 2);
    const { fetcher } = mockFetcher([
      { start_at: `${day}T01:00:00Z` }, // UTC 01:00 → JST 10:00
      { start_at: `${day}T04:00:00Z` }, // UTC 04:00 → JST 13:00
      { start_at: `${day}T01:00:00Z` }  // 重複は1つに
    ]);
    const result = await syncAvailability(env.DB, SQUARE_ENV, fetcher);
    expect(result.ok).toBe(true);
    expect(result.days).toBe(6); // 範囲内の全日を upsert
    const starts = await getCachedStarts(env.DB, day, day);
    expect(starts.get(day)).toEqual(['10:00', '13:00']);
  });

  it('範囲内に枠が無い日も空配列で upsert される（満枠日と未取得日を区別）', async () => {
    await enableSquare(3);
    const today = currentJstDate();
    const { fetcher } = mockFetcher([]); // 1件も枠が無い
    const result = await syncAvailability(env.DB, SQUARE_ENV, fetcher);
    expect(result.ok).toBe(true);
    const starts = await getCachedStarts(env.DB, today, addDays(today, 3));
    expect(starts.has(today)).toBe(true); // 行はある
    expect(starts.get(today)).toEqual([]); // 中身は空（満枠）
    expect(starts.size).toBe(4);           // 今日〜今日+3 の4日ぶん
  });

  it('31日を超える範囲はチャンク分割して複数回リクエストする', async () => {
    await enableSquare(40); // 41日 → 31 + 10 の2チャンク
    const { fetcher, calls } = mockFetcher([]);
    const result = await syncAvailability(env.DB, SQUARE_ENV, fetcher);
    expect(result.ok).toBe(true);
    expect(result.days).toBe(41);
    expect(calls.length).toBe(2);
  });

  it('想定外の応答（availabilities欠落・start_at不正）でも例外を投げず継続する', async () => {
    await enableSquare(2);
    const today = currentJstDate();
    const fetcher = (async () =>
      new Response(JSON.stringify({ nonsense: true, availabilities: [{ foo: 1 }, { start_at: 999 }] }), { status: 200 })
    ) as typeof fetch;
    const result = await syncAvailability(env.DB, SQUARE_ENV, fetcher);
    expect(result.ok).toBe(true);
    const starts = await getCachedStarts(env.DB, today, addDays(today, 2));
    expect(starts.get(today)).toEqual([]); // 不正な枠は無視され空配列
  });

  it('APIが失敗（500）や例外でも投げず ok:false を返す', async () => {
    await enableSquare(2);
    const fail = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const r1 = await syncAvailability(env.DB, SQUARE_ENV, fail);
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('500');

    const boom = (async () => { throw new Error('network down'); }) as typeof fetch;
    const r2 = await syncAvailability(env.DB, SQUARE_ENV, boom);
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('network down');
  });

  it('getCacheStatus は日数と最終取得時刻を返す', async () => {
    await enableSquare(1);
    const { fetcher } = mockFetcher([]);
    await syncAvailability(env.DB, SQUARE_ENV, fetcher);
    const status = await getCacheStatus(env.DB);
    expect(status.days).toBe(2); // 今日と翌日
    expect(status.lastFetched).not.toBeNull();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（`Failed to load ../src/core/square`）

- [ ] **Step 3: 実装**

`src/core/square.ts`:

```ts
import { addDays, clampDate, currentJstDate } from './dates';
import { getSettings } from './settings';

interface SquareEnv {
  SQUARE_ACCESS_TOKEN?: string;
  SQUARE_API_BASE?: string;
}

export interface SyncResult {
  ok: boolean;
  days: number;   // upsert した日数
  error?: string; // 失敗理由（sync_disabled・HTTP xxx・例外メッセージ）
}

const DEFAULT_API_BASE = 'https://connect.squareup.com';
const MAX_CHUNK_DAYS = 31; // Square SearchAvailability の1リクエストの最大範囲

// Square応答の start_at（RFC3339）を JST の { date, time } に変換する。型不正・暦不正は null。
function toJstDateTime(startAt: unknown): { date: string; time: string } | null {
  if (typeof startAt !== 'string') return null;
  const ms = Date.parse(startAt);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms + 9 * 3600_000).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
}

// Square Bookings API SearchAvailability を今日〜今日+windowDays の範囲で呼び、
// 日別の空き開始時刻を availability_cache に upsert する。
// 絶対に例外を投げない（失敗は { ok:false, error } で返す）。実APIはテストで叩かず fetcher を注入する。
export async function syncAvailability(
  db: D1Database,
  env: SquareEnv,
  fetcher: typeof fetch = fetch
): Promise<SyncResult> {
  try {
    const settings = await getSettings(db);
    if (!settings.syncEnabled || !env.SQUARE_ACCESS_TOKEN) {
      // 設定不足では何もしない（呼び出し側でも同期有効を確認するが、多層防御）
      return { ok: false, days: 0, error: 'sync_disabled' };
    }

    const base = (env.SQUARE_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    const url = `${base}/v2/bookings/availability/search`;
    const today = currentJstDate();
    const end = addDays(today, settings.windowDays);
    const fetchedAt = new Date().toISOString();

    // 日別の開始時刻集合。範囲内の全日を空集合で先に埋め、
    // 「取得済みだが枠ゼロ（満枠）」と「未取得（行なし）」を確実に区別する。
    const byDate = new Map<string, Set<string>>();
    for (let d = today; d <= end; d = addDays(d, 1)) byDate.set(d, new Set<string>());

    let chunkStart = today;
    while (chunkStart <= end) {
      const chunkEnd = clampDate(addDays(chunkStart, MAX_CHUNK_DAYS - 1), chunkStart, end);
      const body = {
        query: {
          filter: {
            start_at_range: {
              start_at: `${chunkStart}T00:00:00+09:00`,
              end_at: `${addDays(chunkEnd, 1)}T00:00:00+09:00` // 終端の翌日0時（chunkEnd当日を丸ごと含める）
            },
            location_id: settings.squareLocationId,
            segment_filters: [{ service_variation_id: settings.squareServiceVariationId }]
          }
        }
      };

      const res = await fetcher(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
          'content-type': 'application/json',
          'square-version': '2024-08-21'
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        // 1チャンクでも失敗したら既存キャッシュを温存して中断（部分更新で表示を壊さない）
        return { ok: false, days: 0, error: `HTTP ${res.status}` };
      }

      const json = (await res.json()) as { availabilities?: unknown };
      const availabilities = Array.isArray(json.availabilities) ? json.availabilities : [];
      for (const a of availabilities) {
        const startAt = (a as { start_at?: unknown })?.start_at;
        const jst = toJstDateTime(startAt);
        // 範囲内の日だけ採用（範囲外の枠が混じっても無視）
        if (jst && byDate.has(jst.date)) byDate.get(jst.date)!.add(jst.time);
      }

      chunkStart = addDays(chunkEnd, 1);
    }

    // 日別に upsert（開始時刻は昇順にそろえる）
    const upsert = db.prepare(
      `INSERT INTO availability_cache (date, slots_json, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET slots_json = excluded.slots_json, fetched_at = excluded.fetched_at`
    );
    const batch = [...byDate.entries()].map(([date, starts]) =>
      upsert.bind(date, JSON.stringify([...starts].sort()), fetchedAt)
    );
    if (batch.length > 0) await db.batch(batch);

    return { ok: true, days: byDate.size };
  } catch (e) {
    // 応答JSONの破損・ネットワーク例外なども握りつぶし、既存キャッシュを温存する（会員ページは前回値で継続表示）
    return { ok: false, days: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

// 指定範囲のキャッシュを「日付→開始時刻配列」で返す。行が有る日だけキーが入る（空配列＝満枠）。
export async function getCachedStarts(db: D1Database, from: string, to: string): Promise<Map<string, string[]>> {
  const result = await db.prepare('SELECT date, slots_json FROM availability_cache WHERE date >= ? AND date <= ?')
    .bind(from, to).all<{ date: string; slots_json: string }>();
  const map = new Map<string, string[]>();
  for (const r of result.results) {
    let starts: string[] = [];
    try {
      const parsed = JSON.parse(r.slots_json);
      if (Array.isArray(parsed)) starts = parsed.filter((s): s is string => typeof s === 'string');
    } catch {
      // 壊れた値は空配列扱い（次回同期で直る）
    }
    map.set(r.date, starts);
  }
  return map;
}

// 同期状態（キャッシュ日数と最終取得時刻）。設定画面の表示と scheduled の24h判定で使う。
export async function getCacheStatus(db: D1Database): Promise<{ days: number; lastFetched: string | null }> {
  const row = await db.prepare('SELECT COUNT(*) AS n, MAX(fetched_at) AS m FROM availability_cache')
    .first<{ n: number; m: string | null }>();
  return { days: row?.n ?? 0, lastFetched: row?.m ?? null };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（syncAvailability 8件を含む累計 **104 件**）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/core/square.ts test/square.test.ts
git commit -m "feat: Square同期コア（SearchAvailabilityを31日チャンクで取得しJST日別にキャッシュ）"
```

---

### Task 3: cron配線・スケジュールコア・同期停止通知

**Files:**
- Create: `src/core/scheduled.ts`
- Modify: `src/core/notify.ts`（全文差し替え: `EmailType` に `sync_stale`・`APP_ORIGIN` 優先・`sendSyncStaleNotification` 追加）
- Modify: `src/index.ts`（全文差し替え: `export const app` 化＋Workersハンドラ default export）
- Modify: `wrangler.jsonc`（全文差し替え: `triggers.crons` 追加）
- Modify: `test/env.d.ts`（全文差し替え: Square/APP_ORIGIN を optional 追加）
- Modify: 既存10ファイルの `import app from '../src/index'` を `import { app } from '../src/index'` に（**この置換だけが唯一許される既存テスト改変**）
- Test: `test/scheduled.test.ts`
- Test: `test/notify.test.ts`（2ケース追記）

**Interfaces:**
- Consumes: `syncAvailability`/`getCacheStatus`（Task 2）、`getSettings`（Task 1）、`login_failures`（ステップ②）
- Produces:
  - `notify.ts`: `EmailType = 'requested' | 'cancelled' | 'confirmed' | 'declined' | 'sync_stale'`。`NotifyEnv` に `APP_ORIGIN?`。既存 `sendRequestNotification` の管理画面リンクは `env.APP_ORIGIN ?? origin` を使う。`sendSyncStaleNotification(db, env, origin, fetcher?): Promise<void>`（スタッフ宛・`email_log` の `request_id` は 0・type `sync_stale`・**例外を投げない**）
  - `scheduled.ts`: `runScheduled(db, env, fetcher?: typeof fetch, nowMs?: number): Promise<void>`
  - `src/index.ts`: `export const app`（Honoアプリ）＋ `export default { fetch: app.fetch, scheduled }`
  - cron `*/15 * * * *`

- [ ] **Step 1: 失敗するテストを書く**

`test/scheduled.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { runScheduled } from '../src/core/scheduled';
import { setSetting } from '../src/core/settings';
import { getCacheStatus } from '../src/core/square';
import { currentJstDate } from '../src/core/dates';

async function enableSquare(): Promise<void> {
  await setSetting(env.DB, 'square_location_id', 'LOC');
  await setSetting(env.DB, 'square_service_variation_id', 'SV');
  await setSetting(env.DB, 'window_days', '2');
}

const OK_FETCHER = (async () => new Response(JSON.stringify({ availabilities: [] }), { status: 200 })) as typeof fetch;
const NOW = Date.parse('2026-07-24T00:00:00.000Z');

describe('runScheduled', () => {
  it('同期有効なら Square を取得してキャッシュを更新する', async () => {
    await enableSquare();
    await runScheduled(env.DB, { SQUARE_ACCESS_TOKEN: 'tok' }, OK_FETCHER, NOW);
    const status = await getCacheStatus(env.DB);
    expect(status.days).toBe(3); // 今日〜今日+2
    expect(status.lastFetched).not.toBeNull();
  });

  it('同期無効なら fetcher を呼ばない', async () => {
    let called = false;
    const spy = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
    await runScheduled(env.DB, { SQUARE_ACCESS_TOKEN: 'tok' }, spy, NOW);
    expect(called).toBe(false);
    const status = await getCacheStatus(env.DB);
    expect(status.days).toBe(0);
  });

  it('1日より古い login_failures を削除し、新しい行は残す', async () => {
    const old = new Date(NOW - 25 * 3600_000).toISOString();
    const fresh = new Date(NOW - 1 * 3600_000).toISOString();
    await env.DB.prepare('INSERT INTO login_failures (ip, created_at) VALUES (?, ?)').bind('1.1.1.1', old).run();
    await env.DB.prepare('INSERT INTO login_failures (ip, created_at) VALUES (?, ?)').bind('2.2.2.2', fresh).run();

    await runScheduled(env.DB, {}, OK_FETCHER, NOW);

    const rows = await env.DB.prepare('SELECT ip FROM login_failures').all<{ ip: string }>();
    expect(rows.results.map((r) => r.ip)).toEqual(['2.2.2.2']);
  });

  it('同期有効かつ最終取得が24h超なら sync_stale をスタッフへ記録する', async () => {
    await enableSquare();
    await setSetting(env.DB, 'staff_email', 'staff@example.com');
    // 古い取得時刻のキャッシュを seed し、同期は失敗させて更新されないようにする
    const oldStamp = new Date(NOW - 30 * 3600_000).toISOString();
    await env.DB.prepare('INSERT INTO availability_cache (date, slots_json, fetched_at) VALUES (?, ?, ?)')
      .bind(currentJstDate(), '[]', oldStamp).run();
    const failFetcher = (async () => new Response('boom', { status: 500 })) as typeof fetch;

    await runScheduled(env.DB, { SQUARE_ACCESS_TOKEN: 'tok' }, failFetcher, NOW);

    const log = await env.DB.prepare(
      "SELECT type, status, request_id FROM email_log WHERE type = 'sync_stale' ORDER BY id DESC LIMIT 1"
    ).first<{ type: string; status: string; request_id: number }>();
    expect(log).not.toBeNull();
    expect(log!.request_id).toBe(0);
    expect(log!.status).toBe('skipped'); // RESEND_API_KEY 未設定 → 送信スキップ・記録のみ
  });

  it('最終取得が24h以内なら sync_stale を記録しない', async () => {
    await enableSquare();
    await setSetting(env.DB, 'staff_email', 'staff@example.com');
    const recent = new Date(NOW - 1 * 3600_000).toISOString();
    await env.DB.prepare('INSERT INTO availability_cache (date, slots_json, fetched_at) VALUES (?, ?, ?)')
      .bind(currentJstDate(), '[]', recent).run();
    const failFetcher = (async () => new Response('boom', { status: 500 })) as typeof fetch;

    await runScheduled(env.DB, { SQUARE_ACCESS_TOKEN: 'tok' }, failFetcher, NOW);

    const log = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_log WHERE type = 'sync_stale'").first<{ n: number }>();
    expect(log!.n).toBe(0);
  });
});
```

`test/notify.test.ts` の import 行を差し替え（`sendSyncStaleNotification` を追加）:

```ts
import { sendRequestNotification, sendSyncStaleNotification } from '../src/core/notify';
```

`describe('notify')` の末尾（`declined は…` テストの後）に2ケース追加:

```ts
  it('APP_ORIGIN が設定されていれば管理画面リンクは APP_ORIGIN を使う', async () => {
    const id = await seedRequest();
    await setSetting(env.DB, 'staff_email', 'staff@example.com');
    const calls: { init: RequestInit }[] = [];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ init: init! });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await sendRequestNotification(
      env.DB, { RESEND_API_KEY: 'key', APP_ORIGIN: 'https://torch.example' }, id, 'requested', 'http://localhost:8787', fetcher
    );

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.text).toContain('https://torch.example/admin/requests');
    expect(body.text).not.toContain('http://localhost:8787');
  });

  it('sync_stale はスタッフ宛に送信し request_id 0 で記録する', async () => {
    await setSetting(env.DB, 'staff_email', 'staff@example.com');
    const calls: { init: RequestInit }[] = [];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ init: init! });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await sendSyncStaleNotification(env.DB, { RESEND_API_KEY: 'key', APP_ORIGIN: 'https://torch.example' }, '', fetcher);

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.to).toEqual(['staff@example.com']);
    expect(body.subject).toContain('同期が停止');
    expect(body.text).toContain('https://torch.example/admin/settings');
    const log = await env.DB.prepare('SELECT request_id, type, status FROM email_log ORDER BY id DESC LIMIT 1')
      .first<{ request_id: number; type: string; status: string }>();
    expect(log).toEqual({ request_id: 0, type: 'sync_stale', status: 'sent' });
  });
```

- [ ] **Step 2: 既存テストの import を named import へ置換**

`export default app` を Workers ハンドラに変えるため、`app` を named export に切り替える。既存10ファイルの default import を機械的に置換する:

```bash
for f in test/helpers.ts test/smoke.test.ts test/admin-auth.test.ts test/admin-members.test.ts test/member-page.test.ts test/member-requests.test.ts test/admin-requests.test.ts test/admin-requests-list.test.ts test/admin-closed-settings.test.ts test/hardening.test.ts; do
  sed -i '' "s|import app from '../src/index';|import { app } from '../src/index';|" "$f"
done
```

Run（置換の確認）: `grep -rn "from '../src/index'" test/`
Expected: 10ファイルすべてが `import { app } from '../src/index';`（default import が残っていないこと）

- [ ] **Step 3: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（`Failed to load ../src/core/scheduled` / `sendSyncStaleNotification` 未定義。named import 置換により旧 default export 参照はこの時点でまだ `export const app` 未実装なら import エラー）

- [ ] **Step 4: 実装**

`src/core/notify.ts`（全文差し替え）:

```ts
import { getSettings } from './settings';

export type EmailType = 'requested' | 'cancelled' | 'confirmed' | 'declined' | 'sync_stale';

interface NotifyEnv {
  RESEND_API_KEY?: string;
  NOTIFY_EMAIL_FROM?: string;
  APP_ORIGIN?: string;
}

interface RequestInfo {
  id: number;
  date: string;
  start_time: string;
  end_time: string;
  status: string;
  member_note: string;
  admin_note: string;
  member_name: string;
  member_type: string;
  member_email: string;
}

const MEMBER_TYPE_LABELS: Record<string, string> = { monthly: '月額会員', ticket: '回数券' };

// リクエストに関する通知メールを送る。絶対に例外を投げない（メール失敗で本処理を失敗させないため）。
// APIキーまたは宛先が無ければ送信せず email_log に skipped を記録する（booking-system の実証パターン）。
export async function sendRequestNotification(
  db: D1Database,
  env: NotifyEnv,
  requestId: number,
  type: EmailType,
  origin: string,
  fetcher: typeof fetch = fetch
): Promise<void> {
  try {
    const r = await db.prepare(
      `SELECT r.id, r.date, r.start_time, r.end_time, r.status, r.member_note, r.admin_note,
              m.name AS member_name, m.member_type, m.email AS member_email
       FROM requests r JOIN members m ON m.id = r.member_id
       WHERE r.id = ?`
    ).bind(requestId).first<RequestInfo>();
    if (!r) return;

    const { staffEmail } = await getSettings(db);
    const when = `${r.date} ${r.start_time}〜${r.end_time}`;
    const typeLabel = MEMBER_TYPE_LABELS[r.member_type] ?? r.member_type;
    // ステップ②持ち越し: 本番は APP_ORIGIN を優先し、無ければリクエストoriginを使う
    const linkBase = env.APP_ORIGIN ?? origin;

    let to: string;
    let subject: string;
    let lines: string[];

    if (type === 'requested' || type === 'cancelled') {
      to = staffEmail;
      if (type === 'requested') {
        subject = `【TORCH 会員予約】新しい利用リクエスト: ${when} ${r.member_name}様`;
        lines = [
          '新しい利用リクエストが届きました。',
          '',
          `会員: ${r.member_name}様（${typeLabel}）`,
          `日時: ${when}`,
          r.member_note ? `メモ: ${r.member_note}` : '',
          '',
          `管理画面で確定/否認してください: ${linkBase}/admin/requests`
        ];
      } else {
        subject = `【TORCH 会員予約】キャンセル: ${when} ${r.member_name}様`;
        lines = [
          '会員がリクエストをキャンセルしました。',
          '',
          `会員: ${r.member_name}様（${typeLabel}）`,
          `日時: ${when}`,
          '',
          `一覧: ${linkBase}/admin/requests/all`
        ];
      }
    } else {
      to = r.member_email;
      if (type === 'confirmed') {
        subject = `【TORCH】ご利用リクエスト確定: ${when}`;
        lines = [
          `${r.member_name}様`,
          '',
          '以下のご利用リクエストが確定しました。当日のご来館をお待ちしております。',
          '',
          `日時: ${when}`,
          r.admin_note ? `スタッフより: ${r.admin_note}` : '',
          '',
          '変更やキャンセルはご自身の専用ページ、またはLINEでご連絡ください。'
        ];
      } else {
        subject = `【TORCH】ご利用リクエストについて: ${when}`;
        lines = [
          `${r.member_name}様`,
          '',
          '申し訳ありません。以下のご利用リクエストは確定できませんでした。',
          '',
          `日時: ${when}`,
          r.admin_note ? `理由: ${r.admin_note}` : '',
          '',
          '別の日時でのリクエストをご検討ください。ご不明な点はLINEでお気軽にご連絡ください。'
        ];
      }
    }

    const text = lines.filter((line) => line !== '').join('\n');

    if (!env.RESEND_API_KEY || !to) {
      await logEmail(db, requestId, to, type, 'skipped', null);
      return;
    }

    try {
      const res = await fetcher('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          from: env.NOTIFY_EMAIL_FROM ?? 'onboarding@resend.dev',
          to: [to],
          subject,
          text
        })
      });
      if (res.ok) {
        await logEmail(db, requestId, to, type, 'sent', null);
      } else {
        await logEmail(db, requestId, to, type, 'error', `HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (e) {
      await logEmail(db, requestId, to, type, 'error', e instanceof Error ? e.message : String(e));
    }
  } catch {
    // ログ書き込みすら失敗しても呼び出し元には影響させない
  }
}

// 同期が24時間以上停止したことをスタッフに知らせる（scheduled から呼ぶ）。
// リクエストに紐づかない通知なので email_log の request_id は 0 で記録する。絶対に例外を投げない。
export async function sendSyncStaleNotification(
  db: D1Database,
  env: NotifyEnv,
  origin: string,
  fetcher: typeof fetch = fetch
): Promise<void> {
  try {
    const { staffEmail } = await getSettings(db);
    const linkBase = env.APP_ORIGIN ?? origin;
    const subject = '【TORCH 会員予約】Squareの空き情報の同期が停止しています';
    const lines = [
      'Squareからの空き情報の取得が24時間以上できていません。',
      '会員ページには前回取得時点の空き状況が表示され続けます。',
      '',
      'Square側の設定（アクセストークン・ロケーション/サービスID）や通信状況をご確認ください。',
      linkBase ? `設定画面: ${linkBase}/admin/settings` : '設定画面: /admin/settings'
    ];
    const text = lines.join('\n');

    if (!env.RESEND_API_KEY || !staffEmail) {
      await logEmail(db, 0, staffEmail, 'sync_stale', 'skipped', null); // request_id 0 = リクエスト非依存
      return;
    }

    try {
      const res = await fetcher('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          from: env.NOTIFY_EMAIL_FROM ?? 'onboarding@resend.dev',
          to: [staffEmail],
          subject,
          text
        })
      });
      if (res.ok) {
        await logEmail(db, 0, staffEmail, 'sync_stale', 'sent', null);
      } else {
        await logEmail(db, 0, staffEmail, 'sync_stale', 'error', `HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (e) {
      await logEmail(db, 0, staffEmail, 'sync_stale', 'error', e instanceof Error ? e.message : String(e));
    }
  } catch {
    // ログ書き込みすら失敗しても呼び出し元には影響させない
  }
}

function logEmail(db: D1Database, requestId: number, to: string, type: string, status: string, error: string | null) {
  return db.prepare(
    `INSERT INTO email_log (request_id, to_address, type, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(requestId, to, type, status, error, new Date().toISOString()).run();
}
```

`src/core/scheduled.ts`:

```ts
import { getSettings } from './settings';
import { syncAvailability, getCacheStatus } from './square';
import { sendSyncStaleNotification } from './notify';

interface ScheduledEnv {
  RESEND_API_KEY?: string;
  NOTIFY_EMAIL_FROM?: string;
  APP_ORIGIN?: string;
  SQUARE_ACCESS_TOKEN?: string;
  SQUARE_API_BASE?: string;
}

const DAY_MS = 24 * 3600_000;

// 15分ごとの cron から呼ばれる定期処理。cron 実行そのものはテストせず、この関数を直接呼ぶ。
// nowMs は 24h 判定・掃除の基準時刻。テストで注入して決定性を保つ。絶対に例外を投げない。
export async function runScheduled(
  db: D1Database,
  env: ScheduledEnv,
  fetcher: typeof fetch = fetch,
  nowMs: number = Date.now()
): Promise<void> {
  try {
    const settings = await getSettings(db);

    // (a) 同期有効なら Square から取得（失敗しても例外にはならない）
    if (settings.syncEnabled) {
      await syncAvailability(db, env, fetcher);
    }

    // (b) ステップ②持ち越し: 1日より古いログイン失敗履歴を掃除する
    const cutoff = new Date(nowMs - DAY_MS).toISOString();
    await db.prepare('DELETE FROM login_failures WHERE created_at < ?').bind(cutoff).run();

    // (c) 同期有効かつ最終取得から24時間超（未取得=null含む）なら、同期停止をスタッフへ通知する。
    //     (a) の同期が成功していれば lastFetched は現在時刻になり stale にならない。
    if (settings.syncEnabled) {
      const { lastFetched } = await getCacheStatus(db);
      const stale = lastFetched === null || nowMs - Date.parse(lastFetched) > DAY_MS;
      if (stale) {
        // 24時間以内に同じ通知を記録済みなら送らない（障害が続く間、15分ごとに通知が飛ぶのを防ぐ）
        const notified = await db
          .prepare(`SELECT id FROM email_log WHERE type = 'sync_stale' AND created_at >= ? LIMIT 1`)
          .bind(cutoff)
          .first();
        if (!notified) {
          await sendSyncStaleNotification(db, env, env.APP_ORIGIN ?? '', fetcher);
        }
      }
    }
  } catch {
    // cron の定期処理は失敗しても握りつぶす（次回15分後に再試行される）
  }
}
```

`src/index.ts`（全文差し替え）:

```ts
import { Hono } from 'hono';
import { admin } from './routes/admin';
import { member } from './routes/member';
import { STYLE_CSS } from './routes/style-css';
import { runScheduled } from './core/scheduled';
import type { Bindings } from './types';

// Hono アプリ本体。テストはこの named export を import して app.request(...) で叩く。
export const app = new Hono<{ Bindings: Bindings }>();

app.get('/health', (c) => c.json({ ok: true }));
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));
app.get('/style.css', (c) => {
  c.header('content-type', 'text/css; charset=utf-8');
  c.header('cache-control', 'public, max-age=3600');
  return c.body(STYLE_CSS);
});
app.route('/admin', admin);
app.route('/m', member);

// Workers のエントリ。fetch は Hono、scheduled は15分ごとの cron（薄いラッパ。実体は runScheduled）。
export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScheduled(env.DB, env));
  }
} satisfies ExportedHandler<Bindings>;
```

`wrangler.jsonc`（全文差し替え。`triggers` を追加しただけ）:

```jsonc
{
  "name": "torch-member-booking",
  "main": "src/index.ts",
  "compatibility_date": "2026-03-10",
  "triggers": {
    "crons": ["*/15 * * * *"]
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "torch-member-booking",
      // ローカル開発・テストではこのIDは使われない。初回デプロイ時に
      // `wrangler d1 create torch-member-booking` の出力IDに差し替えること
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "migrations"
    }
  ]
}
```

`test/env.d.ts`（全文差し替え）:

```ts
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
    ADMIN_PASSWORD: string;
    SESSION_SECRET: string;
    RESEND_API_KEY?: string;
    NOTIFY_EMAIL_FROM?: string;
    APP_ORIGIN?: string;
    SQUARE_ACCESS_TOKEN?: string;
    SQUARE_API_BASE?: string;
  }
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npm test`
Expected: PASS（scheduled 5件＋notify 2件を含む累計 **113 件**（stale通知の重複抑制フィックス2件を含む）。named import に切り替えた既存10ファイルも引き続き通ること）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/core/scheduled.ts src/core/notify.ts src/index.ts wrangler.jsonc test/env.d.ts test/scheduled.test.ts test/notify.test.ts test/helpers.ts test/smoke.test.ts test/admin-auth.test.ts test/admin-members.test.ts test/member-page.test.ts test/member-requests.test.ts test/admin-requests.test.ts test/admin-requests-list.test.ts test/admin-closed-settings.test.ts test/hardening.test.ts
git commit -m "feat: cron（15分）とscheduledコア（同期・ログイン履歴掃除・24h停止通知）／appをnamed export化"
```

---

### Task 4: 会員ページのSquare対応（空き表示・POST照合・取得時刻注記）

**Files:**
- Modify: `src/routes/member.tsx`（全文差し替え）
- Test: `test/member-square.test.ts`

**Interfaces:**
- Consumes: `getCachedStarts`/`getCacheStatus`（Task 2）、`getSettings`（`syncEnabled`）、`weekdayOf`/`formatStampJst`（Task 1）、`availability_cache`
- Produces: 会員ページの同期対応。**同期有効時のみ**表示枠＝テンプレート∩キャッシュ、未取得日は「取得中」でフォーム非表示、満枠日は「空き枠がありません」、取得時刻の注記、POSTのキャッシュ照合（`error=unavailable`）。**同期無効時は現行と完全一致**

- [ ] **Step 1: 失敗するテストを書く**

`test/member-square.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { adminCookie } from './helpers';
import { setSetting } from '../src/core/settings';
import { currentJstDate, addDays } from '../src/core/dates';

async function createMember(name: string): Promise<{ id: number; token: string }> {
  const cookie = await adminCookie();
  await app.request('/admin/members', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ name, email: `${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`, member_type: 'monthly' }).toString()
  }, env);
  const row = await env.DB.prepare('SELECT id, token FROM members WHERE name = ?').bind(name).first<{ id: number; token: string }>();
  if (!row) throw new Error('member not created');
  return row;
}

async function enableSync(): Promise<void> {
  await setSetting(env.DB, 'square_location_id', 'LOC');
  await setSetting(env.DB, 'square_service_variation_id', 'SV');
}

async function seedCache(date: string, starts: string[], fetchedAt = '2026-07-24T00:30:00.000Z'): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO availability_cache (date, slots_json, fetched_at) VALUES (?, ?, ?)')
    .bind(date, JSON.stringify(starts), fetchedAt).run();
}

async function postRequest(token: string, body: Record<string, string>): Promise<Response> {
  return app.request(`/m/${token}/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  }, env);
}

const target = addDays(currentJstDate(), 5);

describe('member page with Square sync', () => {
  it('同期有効: キャッシュにある開始時刻の枠だけ表示される', async () => {
    const { token } = await createMember('同期会員A');
    await enableSync();
    await seedCache(target, ['13:00']); // 10:00 と 17:00 は空きなし
    const res = await app.request(`/m/${token}?date=${target}`, {}, env);
    const html = await res.text();
    expect(html).toContain('13:00〜17:00');
    expect(html).not.toContain('10:00〜13:00');
    expect(html).not.toContain('17:00〜21:00');
    expect(html).toContain('リクエスト送信');
  });

  it('同期有効: キャッシュ行が無い日は「取得中」でフォームを出さない', async () => {
    const { token } = await createMember('同期会員B');
    await enableSync();
    // target のキャッシュは入れない（未取得）
    const res = await app.request(`/m/${token}?date=${target}`, {}, env);
    const html = await res.text();
    expect(html).toContain('空き情報を取得中です');
    expect(html).not.toContain('リクエスト送信');
  });

  it('同期有効: キャッシュにあるが空き枠ゼロの日は「空き枠がありません」', async () => {
    const { token } = await createMember('同期会員C');
    await enableSync();
    await seedCache(target, []); // 満枠
    const res = await app.request(`/m/${token}?date=${target}`, {}, env);
    const html = await res.text();
    expect(html).toContain('空き枠がありません');
    expect(html).not.toContain('リクエスト送信');
  });

  it('同期有効: 取得時刻の注記が表示される', async () => {
    const { token } = await createMember('同期会員D');
    await enableSync();
    await seedCache(target, ['10:00'], '2026-07-24T00:30:00.000Z'); // JST 9:30
    const res = await app.request(`/m/${token}`, {}, env);
    const html = await res.text();
    expect(html).toContain('時点の空き状況');
    expect(html).toContain('7月24日 9時30分');
  });

  it('同期有効: キャッシュに無い枠へのPOSTは unavailable', async () => {
    const { token } = await createMember('同期会員E');
    await enableSync();
    await seedCache(target, ['13:00']); // 10:00 は空いていない
    const res = await postRequest(token, { date: target, start: '10:00', note: '' });
    expect(res.headers.get('location')).toContain('error=unavailable');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM requests').first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it('同期有効: キャッシュにある枠へのPOSTは通常どおり申請できる', async () => {
    const { id, token } = await createMember('同期会員F');
    await enableSync();
    await seedCache(target, ['10:00', '13:00']);
    const res = await postRequest(token, { date: target, start: '10:00', note: '窓側希望' });
    expect(res.headers.get('location')).toContain('ok=requested');
    const row = await env.DB.prepare('SELECT status, end_time FROM requests WHERE member_id = ?')
      .bind(id).first<{ status: string; end_time: string }>();
    expect(row!.status).toBe('pending');
    expect(row!.end_time).toBe('13:00');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（同期有効時のフィルタ・取得中表示・unavailable がまだ無い）

- [ ] **Step 3: 実装 — `src/routes/member.tsx`（全文差し替え）**

```tsx
import { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import type { Bindings, MemberRow, RequestRow, RequestStatus } from '../types';
import { TYPE_LABELS, TYPE_BADGE_CLASSES } from './admin/ui';
import {
  WEEKDAY_LABELS, currentJstDate, addDays, monthOf, addMonths, buildMonthGrid,
  formatMD, isValidDate, isValidMonth, weekdayOf, formatStampJst
} from '../core/dates';
import { getSettings, findSlot } from '../core/settings';
import { getCachedStarts, getCacheStatus } from '../core/square';
import { createRequest, cancelRequestByMember } from '../core/requests';
import { sendRequestNotification } from '../core/notify';

export const member = new Hono<{ Bindings: Bindings }>();

export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  pending: '申請中',
  confirmed: '確定',
  declined: '否認',
  cancelled: 'キャンセル済み'
};

export const REQUEST_BADGE_CLASSES: Record<RequestStatus, string> = {
  pending: 'badge badge-pending',
  confirmed: 'badge badge-confirmed',
  declined: 'badge badge-declined',
  cancelled: 'badge badge-cancelled'
};

const OK_MESSAGES: Record<string, string> = {
  requested: 'リクエストを送信しました。確定/否認の結果はメールでお知らせします',
  cancelled: 'キャンセルしました'
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid: '入力内容に誤りがあります。日付と時間枠をご確認ください',
  closed: 'この日は受付を停止しています',
  duplicate: 'この日時にはすでにリクエスト済みです',
  unavailable: 'この枠は現在ご案内できません'
};

const NOTE_MAX = 500;

const MemberShell = (props: { title: string; children: Child }) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{props.title}</title>
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <header class="site-header">
        <div class="inner">
          <span class="brand">
            TORCH<small>MEMBER BOOKING</small>
          </span>
        </div>
      </header>
      <main class="member-wrap">{props.children}</main>
    </body>
  </html>
);

async function resolveMember(db: D1Database, token: string): Promise<MemberRow | null> {
  return db.prepare('SELECT * FROM members WHERE token = ? AND is_active = 1').bind(token).first<MemberRow>();
}

const InvalidTokenPage = () => (
  <MemberShell title="リンクが無効です | TORCH 会員予約">
    <div class="page-head">
      <h1>このリンクは無効です</h1>
    </div>
    <p>お手数ですが、TORCH（LINE公式アカウント）までお問い合わせください。</p>
  </MemberShell>
);

member.get('/:token', async (c) => {
  const token = c.req.param('token');
  const m = await resolveMember(c.env.DB, token);
  if (!m) return c.html(<InvalidTokenPage />, 404);

  const settings = await getSettings(c.env.DB);
  const syncEnabled = settings.syncEnabled;
  const today = currentJstDate();
  const maxDate = addDays(today, settings.windowDays);

  const monthParam = c.req.query('month');
  const dateParam = c.req.query('date');
  const selectedDate =
    dateParam && isValidDate(dateParam) && dateParam >= today && dateParam <= maxDate ? dateParam : null;

  const minMonth = monthOf(today);
  const maxMonth = monthOf(maxDate);
  let month = monthParam && isValidMonth(monthParam) ? monthParam : selectedDate ? monthOf(selectedDate) : minMonth;
  if (month < minMonth) month = minMonth;
  if (month > maxMonth) month = maxMonth;

  const monthStart = `${month}-01`;
  const monthEnd = addDays(`${addMonths(month, 1)}-01`, -1);
  const [closedResult, requestsResult, selectedClosedRow] = await Promise.all([
    c.env.DB.prepare('SELECT date FROM closed_dates WHERE date >= ? AND date <= ?')
      .bind(monthStart, monthEnd).all<{ date: string }>(),
    c.env.DB.prepare('SELECT * FROM requests WHERE member_id = ? ORDER BY date DESC, start_time DESC, id DESC LIMIT 50')
      .bind(m.id).all<RequestRow>(),
    // 選択日の停止判定は表示中の月に依存させない（?month=別月&date=停止日 の組み合わせ対策）
    selectedDate !== null
      ? c.env.DB.prepare('SELECT date FROM closed_dates WHERE date = ?').bind(selectedDate).first<{ date: string }>()
      : Promise.resolve(null)
  ]);
  const closedSet = new Set(closedResult.results.map((r) => r.date));
  const myRequests = requestsResult.results;

  // Square同期が有効なときだけ、選択日のキャッシュ有無・空き開始時刻と、取得時刻を読む。
  // selectedCacheStarts: null = 未取得（キャッシュ行なし）、[] = 満枠、[...] = 空きあり
  let selectedCacheStarts: string[] | null = null;
  let lastFetched: string | null = null;
  if (syncEnabled) {
    lastFetched = (await getCacheStatus(c.env.DB)).lastFetched;
    if (selectedDate !== null) {
      const starts = await getCachedStarts(c.env.DB, selectedDate, selectedDate);
      selectedCacheStarts = starts.has(selectedDate) ? starts.get(selectedDate)! : null;
    }
  }

  const selectedClosed = selectedClosedRow !== null;
  const grid = buildMonthGrid(month);
  const prevMonth = addMonths(month, -1);
  const nextMonth = addMonths(month, 1);
  const [y, mo] = month.split('-');

  // 同期有効時の表示枠 = テンプレートのうちキャッシュに開始時刻が含まれるもの（無効時は全テンプレート）
  const availableSlots =
    syncEnabled && selectedCacheStarts !== null
      ? settings.slots.filter((s) => selectedCacheStarts!.includes(s.start))
      : [];
  const formSlots = syncEnabled ? availableSlots : settings.slots;

  const okParam = c.req.query('ok');
  const errorParam = c.req.query('error');

  return c.html(
    <MemberShell title={`${m.name}さん | TORCH 会員予約`}>
      <div class="page-head">
        <span class="eyebrow">Member</span>
        <h1>{m.name} さん</h1>
        <span class={TYPE_BADGE_CLASSES[m.member_type]}>{TYPE_LABELS[m.member_type]}</span>
      </div>
      {okParam && OK_MESSAGES[okParam] && <p class="msg-ok">{OK_MESSAGES[okParam]}</p>}
      {errorParam && ERROR_MESSAGES[errorParam] && <p class="msg-error">{ERROR_MESSAGES[errorParam]}</p>}

      <div class="cal-head">
        <h2>
          {y}年{Number(mo)}月
        </h2>
        <div>
          {month > minMonth ? (
            <a class="btn btn-sm" href={`/m/${token}?month=${prevMonth}`}>
              &laquo; 前月
            </a>
          ) : null}{' '}
          {month < maxMonth ? (
            <a class="btn btn-sm" href={`/m/${token}?month=${nextMonth}`}>
              翌月 &raquo;
            </a>
          ) : null}
        </div>
      </div>
      <table class="cal">
        <thead>
          <tr>
            {WEEKDAY_LABELS.map((w, i) => (
              <th class={i === 0 ? 'sun' : i === 6 ? 'sat' : undefined}>{w}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((week) => (
            <tr>
              {week.map((d, i) => {
                const dowClass = i === 0 ? ' sun' : i === 6 ? ' sat' : '';
                if (d === null) return <td class={dowClass.trim() || undefined}></td>;
                const dayNum = String(Number(d.slice(8, 10)));
                if (d < today || d > maxDate) {
                  return (
                    <td class={dowClass.trim() || undefined}>
                      <span class="day-off">{dayNum}</span>
                    </td>
                  );
                }
                if (closedSet.has(d)) {
                  return (
                    <td class={dowClass.trim() || undefined}>
                      <span class="day-off">
                        {dayNum}
                        <span class="mark">停</span>
                      </span>
                    </td>
                  );
                }
                return (
                  <td class={`${d === selectedDate ? 'selected' : ''}${dowClass}`.trim() || undefined}>
                    <a href={`/m/${token}?date=${d}`}>
                      <span class="day-num">{dayNum}</span>
                    </a>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p class="muted small">日付を選ぶと時間枠を選べます（{formatMD(today)}〜{formatMD(maxDate)} 受付）</p>
      {syncEnabled && (
        <p class="muted small">
          {lastFetched
            ? `${formatStampJst(lastFetched)}時点の空き状況です`
            : '空き情報をまだ取得できていません。表示はまもなく更新されます'}
        </p>
      )}

      {selectedDate && selectedClosed && (
        <p class="msg-error">{formatMD(selectedDate)} は受付を停止しています。別の日をお選びください。</p>
      )}

      {selectedDate && !selectedClosed && (
        <>
          <h2>
            {formatMD(selectedDate)}（{weekdayOf(selectedDate)}）のリクエスト
          </h2>
          {syncEnabled && selectedCacheStarts === null ? (
            <p class="muted">この日の空き情報を取得中です。しばらくたってから再度お試しください。</p>
          ) : syncEnabled && formSlots.length === 0 ? (
            <p class="muted">この日は空き枠がありません。別の日をお選びください。</p>
          ) : (
            <form class="card card-pad" method="post" action={`/m/${token}/requests`}>
              <input type="hidden" name="date" value={selectedDate} />
              <div class="field">
                <label>時間枠</label>
                <div class="slot-list">
                  {formSlots.map((s, i) => (
                    <label class="slot-row">
                      <input type="radio" name="start" value={s.start} checked={i === 0} />
                      {s.start}〜{s.end}
                    </label>
                  ))}
                </div>
              </div>
              <div class="field">
                <label>ひとことメモ（任意・人数やご用件など）</label>
                <textarea name="note" maxlength={NOTE_MAX}></textarea>
              </div>
              <button class="btn btn-primary btn-lg" type="submit">
                リクエスト送信
              </button>
              <p class="muted small" style="margin:12px 0 0">
                スタッフ確認後に確定します。結果はメールでお知らせします。
              </p>
            </form>
          )}
        </>
      )}

      <h2>あなたのリクエスト</h2>
      {myRequests.length === 0 ? (
        <p class="muted">まだリクエストはありません。カレンダーから日付を選んで送信してください。</p>
      ) : (
        <div class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>日時</th>
                <th>状態</th>
                <th>メモ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {myRequests.map((r) => {
                const muted = r.status === 'cancelled' || r.status === 'declined';
                return (
                  <tr class={muted ? 'row-muted' : undefined}>
                    <td class="req-when">
                      {formatMD(r.date)} {r.start_time}〜{r.end_time}
                    </td>
                    <td>
                      <span class={REQUEST_BADGE_CLASSES[r.status]}>{REQUEST_STATUS_LABELS[r.status]}</span>
                    </td>
                    <td class="small">
                      {r.member_note}
                      {r.status === 'declined' && r.admin_note ? (
                        <div class="muted">スタッフより: {r.admin_note}</div>
                      ) : null}
                    </td>
                    <td class="actions">
                      {(r.status === 'pending' || r.status === 'confirmed') && (
                        <form method="post" action={`/m/${token}/requests/${r.id}/cancel`}>
                          <button class="btn btn-sm btn-danger" type="submit">
                            キャンセル
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </MemberShell>
  );
});

member.post('/:token/requests', async (c) => {
  const token = c.req.param('token');
  const m = await resolveMember(c.env.DB, token);
  if (!m) return c.html(<InvalidTokenPage />, 404);

  const form = await c.req.parseBody();
  const date = typeof form.date === 'string' ? form.date : '';
  const start = typeof form.start === 'string' ? form.start : '';
  const note = typeof form.note === 'string' ? form.note.trim() : '';

  const settings = await getSettings(c.env.DB);
  const today = currentJstDate();
  const maxDate = addDays(today, settings.windowDays);
  const slot = findSlot(settings.slots, start);

  if (!isValidDate(date) || date < today || date > maxDate || slot === null || note.length > NOTE_MAX) {
    return c.redirect(`/m/${token}?date=${isValidDate(date) ? date : ''}&error=invalid`);
  }

  const closed = await c.env.DB.prepare('SELECT date FROM closed_dates WHERE date = ?').bind(date).first();
  if (closed) return c.redirect(`/m/${token}?error=closed`);

  // 同期有効時のみ、Squareキャッシュにその枠が無ければ受け付けない（無効時は現行どおり素通り）
  if (settings.syncEnabled) {
    const starts = await getCachedStarts(c.env.DB, date, date);
    const available = starts.get(date);
    if (!available || !available.includes(slot.start)) {
      return c.redirect(`/m/${token}?date=${date}&error=unavailable`);
    }
  }

  const result = await createRequest(c.env.DB, {
    memberId: m.id,
    date,
    startTime: slot.start,
    endTime: slot.end,
    memberNote: note
  });
  if (!result.ok) return c.redirect(`/m/${token}?date=${date}&error=duplicate`);

  const origin = new URL(c.req.url).origin;
  await sendRequestNotification(c.env.DB, c.env, result.id, 'requested', origin);
  return c.redirect(`/m/${token}?ok=requested`);
});

member.post('/:token/requests/:id/cancel', async (c) => {
  const token = c.req.param('token');
  const m = await resolveMember(c.env.DB, token);
  if (!m) return c.html(<InvalidTokenPage />, 404);

  const idRaw = c.req.param('id');
  const id = /^\d{1,9}$/.test(idRaw) ? Number(idRaw) : null;
  const ok = id !== null && (await cancelRequestByMember(c.env.DB, id, m.id));
  if (ok && id !== null) {
    const origin = new URL(c.req.url).origin;
    await sendRequestNotification(c.env.DB, c.env, id, 'cancelled', origin);
  }
  return c.redirect(`/m/${token}?${ok ? 'ok=cancelled' : 'error=invalid'}`);
});
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（member square 6件を含む累計 **119 件**。既存 member-requests 8件は同期無効のまま通ること — 同期無効時の描画・POSTは変更していない）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/routes/member.tsx test/member-square.test.ts
git commit -m "feat: 会員ページのSquare対応（空き枠フィルタ・未取得/満枠表示・取得時刻注記・POST照合）"
```

---

### Task 5: 承認画面のSquare警告バッジ（weekdayOf共通化）

**Files:**
- Modify: `src/routes/admin/requests.tsx`（全文差し替え: `getSettings`/`getCachedStarts` を使い pending 行に警告・ローカル `weekdayOf` を廃止して dates.ts から import）
- Modify: `src/routes/style-css.ts`（1行追加: `.badge-warn`）
- Test: `test/admin-requests-square.test.ts`

**Interfaces:**
- Consumes: `getSettings`（Task 1）、`getCachedStarts`（Task 2）、`weekdayOf`（Task 1 dates）、`REQUEST_STATUS_LABELS`/`REQUEST_BADGE_CLASSES`（member.tsx）
- Produces: 承認待ち一覧に、**同期有効時のみ**「⚠ Square側で埋まった可能性」バッジ（ブロックはしない。判断はスタッフ）。判定は「その日がキャッシュ済み（行あり）なのに開始時刻が含まれない」場合のみ（未取得日は誤警告しない）。`weekdayOf` は dates.ts に共通化

- [ ] **Step 1: 失敗するテストを書く**

`test/admin-requests-square.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { adminCookie } from './helpers';
import { setSetting } from '../src/core/settings';
import { currentJstDate, addDays } from '../src/core/dates';

async function seedPending(name: string, date: string, start = '10:00'): Promise<number> {
  const token = crypto.randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
  const m = await env.DB.prepare(
    `INSERT INTO members (name, email, member_type, token, is_active, created_at) VALUES (?, ?, 'monthly', ?, 1, '2026-07-23T00:00:00.000Z')`
  ).bind(name, `${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`, token).run();
  const r = await env.DB.prepare(
    `INSERT INTO requests (member_id, date, start_time, end_time, status, member_note, admin_note, created_at, updated_at)
     VALUES (?, ?, ?, '13:00', 'pending', '', '', '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z')`
  ).bind(m.meta.last_row_id, date, start).run();
  return r.meta.last_row_id as number;
}

async function enableSync(): Promise<void> {
  await setSetting(env.DB, 'square_location_id', 'LOC');
  await setSetting(env.DB, 'square_service_variation_id', 'SV');
}

async function seedCache(date: string, starts: string[]): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO availability_cache (date, slots_json, fetched_at) VALUES (?, ?, ?)')
    .bind(date, JSON.stringify(starts), '2026-07-24T00:00:00.000Z').run();
}

const WARN = 'Square側で埋まった可能性';
const day = addDays(currentJstDate(), 5);

describe('admin requests Square warning', () => {
  it('同期有効: 承認待ちの枠がキャッシュから消えていれば警告バッジを表示', async () => {
    const cookie = await adminCookie();
    await seedPending('埋まり会員', day, '10:00');
    await enableSync();
    await seedCache(day, ['13:00']); // 10:00 は消えている
    const res = await app.request('/admin/requests', { headers: { cookie } }, env);
    expect(await res.text()).toContain(WARN);
  });

  it('同期有効: 承認待ちの枠がキャッシュにあれば警告は出ない', async () => {
    const cookie = await adminCookie();
    await seedPending('空きあり会員', day, '10:00');
    await enableSync();
    await seedCache(day, ['10:00', '13:00']);
    const res = await app.request('/admin/requests', { headers: { cookie } }, env);
    expect(await res.text()).not.toContain(WARN);
  });

  it('同期無効: キャッシュの状態に関わらず警告は一切出ない', async () => {
    const cookie = await adminCookie();
    await seedPending('無効会員', day, '10:00');
    // enableSync しない（同期無効）
    await seedCache(day, ['13:00']); // 枠は消えているが同期無効なので無視される
    const res = await app.request('/admin/requests', { headers: { cookie } }, env);
    expect(await res.text()).not.toContain(WARN);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（警告バッジが未実装で1件目が失敗）

- [ ] **Step 3: 実装 — `src/routes/admin/requests.tsx`（全文差し替え）**

```tsx
import { Hono } from 'hono';
import type { Bindings, MemberType, MemberRow, RequestRow } from '../../types';
import { confirmRequest, declineRequest } from '../../core/requests';
import { sendRequestNotification } from '../../core/notify';
import { getSettings } from '../../core/settings';
import { getCachedStarts } from '../../core/square';
import { REQUEST_STATUS_LABELS, REQUEST_BADGE_CLASSES } from '../member';
import { formatMD, weekdayOf } from '../../core/dates';
import { Layout, TYPE_LABELS, TYPE_BADGE_CLASSES } from './ui';

export const requests = new Hono<{ Bindings: Bindings }>();

const OK_MESSAGES: Record<string, string> = {
  confirmed: '確定しました。会員へメールで通知します',
  declined: '否認しました。会員へメールで通知します'
};

const ERROR_MESSAGES: Record<string, string> = {
  stale: 'このリクエストはすでに処理済みです',
  invalid: '入力内容に誤りがあります'
};

const NOTE_MAX = 500;

export interface RequestWithMember extends RequestRow {
  member_name: string;
  member_type: MemberType;
}

requests.get('/', async (c) => {
  const okParam = c.req.query('ok');
  const errorParam = c.req.query('error');

  const [result, settings] = await Promise.all([
    c.env.DB.prepare(
      `SELECT r.*, m.name AS member_name, m.member_type
       FROM requests r JOIN members m ON m.id = r.member_id
       WHERE r.status = 'pending'
       ORDER BY r.created_at, r.id`
    ).all<RequestWithMember>(),
    getSettings(c.env.DB)
  ]);
  const rows = result.results;

  // 同期有効時のみ: 承認待ちの枠がSquareキャッシュから消えていたら「埋まった可能性」を警告する。
  // 日付がキャッシュ済み（行あり）なのに開始時刻が含まれない＝Square側で埋まった強いサイン。
  // 未取得日（行なし）は判断材料が無いので警告しない（将来日への誤警告を避ける）。
  const cachedByDate = new Map<string, string[]>();
  if (settings.syncEnabled && rows.length > 0) {
    let from = rows[0].date;
    let to = rows[0].date;
    for (const r of rows) {
      if (r.date < from) from = r.date;
      if (r.date > to) to = r.date;
    }
    const map = await getCachedStarts(c.env.DB, from, to);
    for (const [k, v] of map) cachedByDate.set(k, v);
  }
  const mayBeTaken = (r: RequestWithMember): boolean => {
    if (!settings.syncEnabled) return false;
    const starts = cachedByDate.get(r.date);
    return starts !== undefined && !starts.includes(r.start_time);
  };

  return c.html(
    <Layout title="承認待ち | TORCH 会員予約" active="/admin/requests">
      <div class="page-head">
        <span class="eyebrow">Requests</span>
        <h1>承認待ち</h1>
      </div>
      {okParam && OK_MESSAGES[okParam] && <p class="msg-ok">{OK_MESSAGES[okParam]}</p>}
      {errorParam && ERROR_MESSAGES[errorParam] && <p class="msg-error">{ERROR_MESSAGES[errorParam]}</p>}

      {rows.length === 0 ? (
        <p class="muted">承認待ちのリクエストはありません。</p>
      ) : (
        <div class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>利用日時</th>
                <th>会員</th>
                <th>メモ</th>
                <th>申請日時</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr>
                  <td class="req-when">
                    {formatMD(r.date)}（{weekdayOf(r.date)}）{r.start_time}〜{r.end_time}
                    {mayBeTaken(r) && (
                      <div>
                        <span class="badge badge-warn">⚠ Square側で埋まった可能性</span>
                      </div>
                    )}
                  </td>
                  <td>
                    {r.member_name}{' '}
                    <span class={TYPE_BADGE_CLASSES[r.member_type]}>{TYPE_LABELS[r.member_type]}</span>
                  </td>
                  <td class="small">{r.member_note}</td>
                  <td class="small muted">{r.created_at.slice(0, 16).replace('T', ' ')}</td>
                  <td class="actions">
                    <form method="post" action={`/admin/requests/${r.id}/confirm`}>
                      <button class="btn btn-sm btn-primary" type="submit">
                        確定
                      </button>
                    </form>{' '}
                    <form method="post" action={`/admin/requests/${r.id}/decline`}>
                      <input type="text" name="admin_note" placeholder="否認理由（任意）" maxlength={NOTE_MAX} />{' '}
                      <button class="btn btn-sm btn-danger" type="submit">
                        否認
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  );
});

requests.post('/:id/confirm', async (c) => {
  const idRaw = c.req.param('id');
  const id = /^\d{1,9}$/.test(idRaw) ? Number(idRaw) : null;
  if (id === null) return c.redirect('/admin/requests?error=invalid');

  const ok = await confirmRequest(c.env.DB, id);
  if (!ok) return c.redirect('/admin/requests?error=stale');

  await sendRequestNotification(c.env.DB, c.env, id, 'confirmed', new URL(c.req.url).origin);
  return c.redirect('/admin/requests?ok=confirmed');
});

requests.post('/:id/decline', async (c) => {
  const idRaw = c.req.param('id');
  const id = /^\d{1,9}$/.test(idRaw) ? Number(idRaw) : null;
  const form = await c.req.parseBody();
  const adminNote = typeof form.admin_note === 'string' ? form.admin_note.trim() : '';
  if (id === null || adminNote.length > NOTE_MAX) return c.redirect('/admin/requests?error=invalid');

  const ok = await declineRequest(c.env.DB, id, adminNote);
  if (!ok) return c.redirect('/admin/requests?error=stale');

  await sendRequestNotification(c.env.DB, c.env, id, 'declined', new URL(c.req.url).origin);
  return c.redirect('/admin/requests?ok=declined');
});

const STATUS_FILTERS = ['pending', 'confirmed', 'declined', 'cancelled'] as const;
const DATE_PARAM_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIST_LIMIT = 200;

requests.get('/all', async (c) => {
  const statusParam = c.req.query('status');
  const status = (STATUS_FILTERS as readonly string[]).includes(statusParam ?? '') ? statusParam! : null;
  const memberIdParam = c.req.query('member_id');
  const memberId = memberIdParam && /^\d+$/.test(memberIdParam) ? Number(memberIdParam) : null;
  const fromParam = c.req.query('from');
  const from = fromParam && DATE_PARAM_RE.test(fromParam) ? fromParam : null;
  const toParam = c.req.query('to');
  const to = toParam && DATE_PARAM_RE.test(toParam) ? toParam : null;

  const conds: string[] = [];
  const binds: (string | number)[] = [];
  if (status) { conds.push('r.status = ?'); binds.push(status); }
  if (memberId !== null) { conds.push('r.member_id = ?'); binds.push(memberId); }
  if (from) { conds.push('r.date >= ?'); binds.push(from); }
  if (to) { conds.push('r.date <= ?'); binds.push(to); }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

  const [listResult, membersResult] = await Promise.all([
    c.env.DB.prepare(
      `SELECT r.*, m.name AS member_name, m.member_type
       FROM requests r JOIN members m ON m.id = r.member_id
       ${where}
       ORDER BY r.date DESC, r.start_time DESC, r.id DESC
       LIMIT ${LIST_LIMIT}`
    ).bind(...binds).all<RequestWithMember>(),
    c.env.DB.prepare('SELECT * FROM members ORDER BY name').all<MemberRow>()
  ]);
  const rows = listResult.results;

  return c.html(
    <Layout title="リクエスト一覧 | TORCH 会員予約" active="/admin/requests/all">
      <div class="page-head">
        <span class="eyebrow">Requests / All</span>
        <h1>リクエスト一覧</h1>
      </div>

      <form class="card card-pad" method="get" action="/admin/requests/all">
        <div class="form-grid">
          <div class="field">
            <label>状態</label>
            <select name="status">
              <option value="">すべて</option>
              {STATUS_FILTERS.map((s) => (
                <option value={s} selected={status === s}>
                  {REQUEST_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div class="field">
            <label>会員</label>
            <select name="member_id">
              <option value="">すべて</option>
              {membersResult.results.map((m) => (
                <option value={m.id} selected={memberId === m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div class="field">
            <label>利用日 from</label>
            <input type="date" name="from" value={from ?? ''} />
          </div>
          <div class="field">
            <label>利用日 to</label>
            <input type="date" name="to" value={to ?? ''} />
          </div>
          <button class="btn btn-primary" type="submit">
            絞り込む
          </button>
        </div>
      </form>

      {rows.length === 0 ? (
        <p class="muted" style="margin-top:16px">
          条件に合うリクエストはありません。
        </p>
      ) : (
        <div class="tbl-wrap" style="margin-top:16px">
          <table class="tbl">
            <thead>
              <tr>
                <th>利用日時</th>
                <th>会員</th>
                <th>状態</th>
                <th>メモ</th>
                <th>スタッフメモ</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr class={r.status === 'cancelled' || r.status === 'declined' ? 'row-muted' : undefined}>
                  <td class="req-when">
                    {formatMD(r.date)}（{weekdayOf(r.date)}）{r.start_time}〜{r.end_time}
                  </td>
                  <td>
                    {r.member_name}{' '}
                    <span class={TYPE_BADGE_CLASSES[r.member_type]}>{TYPE_LABELS[r.member_type]}</span>
                  </td>
                  <td>
                    <span class={REQUEST_BADGE_CLASSES[r.status]}>{REQUEST_STATUS_LABELS[r.status]}</span>
                  </td>
                  <td class="small">{r.member_note}</td>
                  <td class="small">{r.admin_note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === LIST_LIMIT && (
            <p class="muted small">最新{LIST_LIMIT}件のみ表示しています。期間や状態で絞り込んでください。</p>
          )}
        </div>
      )}
    </Layout>
  );
});
```

`src/routes/style-css.ts` に `.badge-warn` を1行追加する。`.badge-cancelled { ... }` の行の直後に次を挿入:

```
.badge-warn { background: #f6d9a8; color: #8a4b12; }
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（admin requests Square 3件を含む累計 **122 件**。既存 admin-requests 5件・admin-requests-list 4件も同期無効のまま通ること）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/routes/admin/requests.tsx src/routes/style-css.ts test/admin-requests-square.test.ts
git commit -m "feat: 承認画面にSquare埋まり警告バッジ（同期有効時のみ・weekdayOfをdates.tsへ共通化）"
```

---

### Task 6: 管理設定画面のSquareセクション（今すぐ同期）とREADME

**Files:**
- Modify: `src/routes/admin/settings.tsx`（全文差し替え: Squareセクション・状態表示・今すぐ同期・保存の `saveSettings` バッチ化）
- Modify: `README.md`（全文差し替え: Square連携セットアップ・結合確認手順）
- Test: `test/admin-settings-square.test.ts`

**Interfaces:**
- Consumes: `getSettings`/`saveSettings`/`parseSlotsText`/`slotsToText`（Task 1）、`getCacheStatus`/`syncAvailability`（Task 2）、`formatStampJst`（Task 1 dates）
- Produces: 設定画面のSquareセクション（ロケーション/サービスID入力・空で無効化・同期状態表示・「今すぐ同期」）。GET/POST `/admin/settings` と新規 POST `/admin/settings/sync`（`settingsPage` サブアプリ内。`admin.tsx` の変更は不要）。POST `/` は `saveSettings` で5キーを一括保存（ステップ②持ち越しのbatch化）

- [ ] **Step 1: 失敗するテストを書く**

`test/admin-settings-square.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { adminCookie } from './helpers';
import { getSettings } from '../src/core/settings';

async function post(cookie: string, body: Record<string, string>): Promise<Response> {
  return app.request('/admin/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(body).toString()
  }, env);
}

describe('admin settings Square', () => {
  it('設定画面にSquareセクションと同期無効の状態が表示される', async () => {
    const cookie = await adminCookie();
    const res = await app.request('/admin/settings', { headers: { cookie } }, env);
    const html = await res.text();
    expect(html).toContain('Square連携');
    expect(html).toContain('同期無効');
    expect(html).toContain('今すぐ同期');
  });

  it('ロケーションIDとサービスIDを保存すると同期有効になる', async () => {
    const cookie = await adminCookie();
    const res = await post(cookie, {
      staff_email: '', window_days: '60', slots_text: '10:00-13:00',
      square_location_id: 'LOC123', square_service_variation_id: 'SV456'
    });
    expect(res.headers.get('location')).toBe('/admin/settings?ok=saved');
    const s = await getSettings(env.DB);
    expect(s.squareLocationId).toBe('LOC123');
    expect(s.squareServiceVariationId).toBe('SV456');
    expect(s.syncEnabled).toBe(true);
  });

  it('片方だけ入力しても同期無効のまま', async () => {
    const cookie = await adminCookie();
    await post(cookie, {
      staff_email: '', window_days: '60', slots_text: '10:00-13:00',
      square_location_id: 'LOC123', square_service_variation_id: ''
    });
    const s = await getSettings(env.DB);
    expect(s.syncEnabled).toBe(false);
  });

  it('「今すぐ同期」はアクセストークン未設定だと sync_failed にリダイレクトする', async () => {
    const cookie = await adminCookie();
    // 同期有効化（IDは入れるが、テスト環境に SQUARE_ACCESS_TOKEN は無い）
    await post(cookie, {
      staff_email: '', window_days: '60', slots_text: '10:00-13:00',
      square_location_id: 'LOC123', square_service_variation_id: 'SV456'
    });
    const res = await app.request('/admin/settings/sync', { method: 'POST', headers: { cookie } }, env);
    expect(res.headers.get('location')).toBe('/admin/settings?error=sync_failed');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（Squareセクション・/sync が未実装）

- [ ] **Step 3: 実装 — `src/routes/admin/settings.tsx`（全文差し替え）**

```tsx
import { Hono } from 'hono';
import type { Bindings } from '../../types';
import { getSettings, saveSettings, parseSlotsText, slotsToText } from '../../core/settings';
import { getCacheStatus, syncAvailability } from '../../core/square';
import { formatStampJst } from '../../core/dates';
import { Layout } from './ui';

export const settingsPage = new Hono<{ Bindings: Bindings }>();

const OK_MESSAGES: Record<string, string> = {
  saved: '設定を保存しました',
  synced: 'Squareと同期しました'
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid: '入力内容に誤りがあります（メール形式・受付期間1〜365日・時間枠の形式を確認してください）',
  sync_failed: 'Squareとの同期に失敗しました。Square設定（ロケーション/サービスID・アクセストークン）をご確認ください'
};

const ID_MAX = 128;

function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

settingsPage.get('/', async (c) => {
  const okParam = c.req.query('ok');
  const errorParam = c.req.query('error');
  const [s, cache] = await Promise.all([getSettings(c.env.DB), getCacheStatus(c.env.DB)]);

  return c.html(
    <Layout title="設定 | TORCH 会員予約" active="/admin/settings">
      <div class="page-head">
        <span class="eyebrow">Settings</span>
        <h1>設定</h1>
      </div>
      {okParam && OK_MESSAGES[okParam] && <p class="msg-ok">{OK_MESSAGES[okParam]}</p>}
      {errorParam && ERROR_MESSAGES[errorParam] && <p class="msg-error">{ERROR_MESSAGES[errorParam]}</p>}

      <form class="card card-pad" method="post" action="/admin/settings">
        <div class="field">
          <label>スタッフ通知先メールアドレス（リクエスト・キャンセルの通知が届きます。空なら通知しません）</label>
          <input type="email" name="staff_email" value={s.staffEmail} />
        </div>
        <div class="field">
          <label>受付可能期間（何日先まで受け付けるか。1〜365）</label>
          <input type="number" name="window_days" min={1} max={365} value={s.windowDays} required />
        </div>
        <div class="field">
          <label>時間枠テンプレート（1行1枠・「10:00-13:00」の形式・開始時刻順でなくてもOK）</label>
          <textarea name="slots_text" rows={5} required>{slotsToText(s.slots)}</textarea>
        </div>

        <h2>Square連携（両IDを空にすると同期を無効化＝手動モード）</h2>
        <p class="small">
          現在の状態:{' '}
          {s.syncEnabled ? (
            <span class="badge badge-on">同期有効</span>
          ) : (
            <span class="badge badge-off">同期無効（手動モード）</span>
          )}
          {s.syncEnabled && (
            <span class="muted">
              {' '}／ 最終取得: {cache.lastFetched ? `${formatStampJst(cache.lastFetched)}（JST）` : 'まだ取得していません'}
              {' '}／ キャッシュ {cache.days} 日分
            </span>
          )}
        </p>
        <div class="field">
          <label>Square ロケーションID（location_id）</label>
          <input type="text" name="square_location_id" value={s.squareLocationId} maxlength={ID_MAX} />
        </div>
        <div class="field">
          <label>Square サービスバリエーションID（service_variation_id）</label>
          <input type="text" name="square_service_variation_id" value={s.squareServiceVariationId} maxlength={ID_MAX} />
        </div>

        <button class="btn btn-primary btn-lg" type="submit">
          保存
        </button>
        <p class="muted small" style="margin:12px 0 0">
          メールの差出人アドレス・ResendのAPIキー・Squareのアクセストークンはサーバー側の環境変数（RESEND_API_KEY / NOTIFY_EMAIL_FROM / SQUARE_ACCESS_TOKEN）で設定します。
        </p>
      </form>

      <h2>今すぐ同期</h2>
      <form class="card card-pad" method="post" action="/admin/settings/sync">
        <p class="small">
          Squareから最新の空き枠を今すぐ取得します（通常は15分ごとに自動取得）。設定直後の結合確認に使えます。
        </p>
        <button class="btn" type="submit">
          今すぐ同期する
        </button>
      </form>
    </Layout>
  );
});

settingsPage.post('/', async (c) => {
  const form = await c.req.parseBody();
  const staffEmail = typeof form.staff_email === 'string' ? form.staff_email.trim() : '';
  const windowDaysRaw = typeof form.window_days === 'string' ? form.window_days.trim() : '';
  const slotsText = typeof form.slots_text === 'string' ? form.slots_text : '';
  const squareLocationId =
    typeof form.square_location_id === 'string' ? form.square_location_id.trim().slice(0, ID_MAX) : '';
  const squareServiceVariationId =
    typeof form.square_service_variation_id === 'string' ? form.square_service_variation_id.trim().slice(0, ID_MAX) : '';

  const windowDays = Number(windowDaysRaw);
  const slots = parseSlotsText(slotsText);

  if (
    (staffEmail !== '' && !isValidEmail(staffEmail)) ||
    !Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365 ||
    slots === null
  ) {
    return c.redirect('/admin/settings?error=invalid');
  }

  // ステップ②持ち越し: 複数キーを1回のバッチで保存する
  await saveSettings(c.env.DB, [
    { key: 'staff_email', value: staffEmail },
    { key: 'window_days', value: String(windowDays) },
    { key: 'slots', value: JSON.stringify(slots) },
    { key: 'square_location_id', value: squareLocationId },
    { key: 'square_service_variation_id', value: squareServiceVariationId }
  ]);
  return c.redirect('/admin/settings?ok=saved');
});

// 「今すぐ同期」。syncAvailability を即時実行し、結果を画面に反映する（結合確認にも使う）。
settingsPage.post('/sync', async (c) => {
  const result = await syncAvailability(c.env.DB, c.env);
  return c.redirect(`/admin/settings?${result.ok ? 'ok=synced' : 'error=sync_failed'}`);
});
```

- [ ] **Step 4: README を完成させる — `README.md`（全文差し替え）**

```markdown
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
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npm test`
Expected: PASS（admin settings Square 4件を含む累計 **126 件**。既存 admin-closed-settings 6件も引き続き通ること — 保存の `saveSettings` バッチ化で挙動は変わらない）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/routes/admin/settings.tsx README.md test/admin-settings-square.test.ts
git commit -m "feat: 設定画面のSquareセクション（ID入力・同期状態・今すぐ同期）と保存のバッチ化・README更新"
```

---

## 動作確認手順（ステップ③完了後、福田さん向けデモ）

前提: `npm test` が **126件すべて通過**・`npm run typecheck` エラーなし。

```bash
npm run dev
```

**A. 同期無効のまま（後方互換の確認 — Square設定を入れていない状態）**

1. /admin にログイン → 設定 → Square連携の状態が「同期無効（手動モード）」になっている
2. 会員の専用リンクを開き、カレンダーで日付を選ぶ → 時間枠テンプレートがそのまま出る（ステップ②と同じ）
3. リクエスト送信 → 承認待ちに出る → 確定できる。**ステップ②から挙動が変わっていないこと**を確認

**B. 同期有効（Square設定を入れた状態。テストは `.dev.vars` の `SQUARE_ACCESS_TOKEN` を使う）**

4. 設定 → Square連携に location_id / service_variation_id を入力して保存 → 状態が「同期有効」に
5. 「今すぐ同期」→「Squareと同期しました」。会員ページに「◯月◯日 ◯時◯分時点の空き状況です」が表示される
6. 会員ページで日付を選ぶ → Squareで空いている枠だけが選択肢に出る。未取得の日は「取得中」、満枠日は「空き枠がありません」
7. Square側で枠を1つ埋める → 「今すぐ同期」→ 会員ページの該当枠が消える（承認待ちに残っていれば「Square側で埋まった可能性」バッジが出る）
8. 設定でIDを空にして保存 → 手動モードに戻り、A の挙動に戻る

## 補足（実装者向け）

- **同期無効＝現行動作**が本ステップの生命線。会員ページ・承認画面・POST検証はすべて `settings.syncEnabled`（＝2つのSquare ID が両方非空）で分岐し、無効時は分岐に入らない。既存87テストは同期無効前提なので、この分岐に触れなければ壊れない
- `src/index.ts` は `export default { fetch: app.fetch, scheduled }` に変わる。テストは Hono アプリを `import { app } from '../src/index'` の **named import** で使う（Task 3 で既存10ファイルを一括置換）。ローカルの cron 手動起動は `npx wrangler dev` 実行中に別ターミナルで `curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"`（wrangler の scheduled テスト用エンドポイント）で叩ける
- Square API の応答形状（`availabilities[].start_at`）は本計画では**想定形**。実APIとの差異（フィールド名・ページング `cursor` の有無など）はステップ③開始時の結合確認で吸収する。パースは防御的なので、想定外フィールドが増えても落ちない。ページングが必要と判明した場合は `syncAvailability` のチャンクループ内に `cursor` 追従を足す（1日31日ちょうどでも1リクエストの上限件数に収まる想定だが、超える場合の追加対応ポイント）
- `availability_cache` は「行なし＝未取得」「空配列＝満枠」を厳密に区別する。`syncAvailability` は範囲内の**全日**を必ず upsert するので、成功後は今日〜受付期間の全日に行がある
- `fetched_at` は同期実行1回につき1つの時刻を全日に付与する。会員ページの「◯時◯分時点」は `MAX(fetched_at)` を JST 整形したもの
- 24h同期停止のスタッフ通知は「同期が成功していれば `lastFetched` が現在時刻になり発火しない」設計。実質「24時間 sync が一度も成功していない」ときだけ飛ぶ。`request_id` は 0（リクエスト非依存）で `email_log` に記録する
- テストは実行日に依存しないよう、利用日は `addDays(currentJstDate(), n)` で生成する。`fetched_at` を検証するテストだけは固定ISO文字列（`2026-07-24T00:30:00.000Z` → JST 9:30）を使う
- 新規依存は無し（Square連携は fetch のみ）。`db.batch` は D1 の標準機能（`saveSettings`・`syncAvailability`・同期のupsertで使用）
