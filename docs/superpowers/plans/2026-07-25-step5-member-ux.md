# TORCH会員予約システム ステップ⑤（会員UX改善）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 運用開始後のフィードバックに基づく会員UX改善（設計書 §17）。(1) 時間選択を時間枠テンプレートから**30分単位の開始/終了プルダウン**へ、(2) 会員カレンダーに**自分の予約ドット**、(3) **リクエスト受付確認メール**（会員宛）、(4) 「あなたのリクエスト」一覧の**非表示**、(5) 設定画面の**Squareプルダウン**を実装する。完了条件は「会員が10:30〜15:00 のように自由な時間でリクエストでき、自分の予約がカレンダーで一目で分かる」こと。

**Architecture:** ステップ③までの土台に積む。(1) 設定モデルを `slots`（時間枠テンプレート）から `open_start`/`open_end`（受付時間帯）へ置換し、30分刻みの時刻ヘルパー（`isHalfStep`/`halfStepRange`/`timeOptions`/`validTimeRange`）を追加。会員ページのフォームは開始/終了 select、POST は 30分刻み・時間帯内・開始<終了 を検証。(2) Square同期有効時の空き判定を**枠単位から日単位**へ、承認画面の埋まり警告を**レンジ重なり近似**へ変更。(3) `requests.hidden_by_member` 列（migration 0004）と本人限定・終了状態限定の非表示ルート。(4) `EmailType` に `requested_member` を追加。(5) `src/core/square.ts` に `fetchLocations`/`fetchBookableServices`（防御的パース・注入fetcherテスト）を追加し、設定画面をプルダウン化（手入力併存・失敗時は日本語エラー）。**「手動モード（Square未設定）」の意味だけは意図的に変わる**（テンプレート枠 → 受付時間帯の30分レンジ）。

**Tech Stack:** ステップ③と同一（Hono 4.12.28 / wrangler 4.107.0 / D1 / vitest 3.2.7 + vitest-pool-workers 0.12.21 / TypeScript 6.0.3）。Square Locations/Catalog API を `fetch` で直接叩く（SDK不使用・**新規依存なし**）。

## Global Constraints

- 設計書: `docs/superpowers/specs/2026-07-23-torch-member-booking-design.md` の **§17（全6節）** が本計画のスコープの正。§17以外の機能は作らない
- 作業ディレクトリ: `/Users/daisukefukuda/Projects/coworkingspace_booking_webapp/`（記号入りの旧パス `.../Downloads/Often Use/...` では `npm test` を実行しない。従来どおりこの正規パスで作業する）
- **後方互換で1ビットも変えないもの**: 会員トークン方式（`/m/:token`・is_active・再発行）／リクエストの状態遷移（pending→confirmed/declined、pending/confirmed→cancelled の条件付きUPDATE・0行判定）／二重防止の部分UNIQUE `ux_requests_active`（member_id, date, start_time / status IN pending,confirmed）／管理セッション認証／通知の非例外化（メールは絶対に例外を投げない）／Square未設定時は手動モード
- **意図した唯一の仕様変更**: 「手動モード」の中身が変わる。旧＝時間枠テンプレート（`slots`）を出す。新＝受付時間帯 `open_start`〜`open_end` の**30分レンジを会員が自由選択**。Square同期の有無に関わらずフォームは開始/終了 select になる。これは設計書 §17.1 で承認済みの変更
- 日付・時刻はすべて **JST**。「今日」は `currentJstDate()`（UTC+9固定）。30分刻み検証は**分が '00' か '30' のみ**を許可（`isHalfStep`）。`'HH:MM'` はゼロ埋め前提なので時刻の大小は**文字列比較**で判定してよい
- **メールは絶対に例外を投げない**。`RESEND_API_KEY` 未設定または宛先が空なら送信せず `email_log` に `skipped` を記録する（`requested_member` も同じ規約）
- **Square一覧ヘルパー（§17.5）も絶対に例外を投げない**。失敗は `{ ok: false, error }` で返す。実Square APIはテストで叩かず `fetcher` を注入する。応答は**防御的にパース**し、想定外の形状は該当要素だけ無視して継続する。実APIとの形状差は結合確認で吸収する
- **migration は追記のみ**。既に本番適用済みの `0001`〜`0003` は**改変しない**。ステップ⑤の変更は `0004_step5.sql` に集約する
- **`slots` 設定行は消さない**: `migrations/0001_init.sql` が `settings` に `slots` をシードしており本番にも残るが、Task 6 以降 `getSettings` はこれを読まない（無害な残置）。このため `test/schema2.test.ts`（0001シードの `slots` を確認）は**変更しない**
- UI文言はすべて日本語・丁寧語。アプリ表示名「TORCH 会員予約」
- 各タスク完了時: `npm test` と `npm run typecheck` が**全部通ってから**コミット。コミットメッセージは `feat:`/`fix:`/`chore:` プレフィックス＋日本語
- テスト名は日本語でよい。miniflare の `MF-Vitest-Source` 非ASCII警告は既知の無害な挙動
- **既存テストの改変は §17.6 として本計画に明示列挙したものだけ**（Task 1: `settings.test.ts` 全文差し替え／Task 2: `member-requests.test.ts`・`member-square.test.ts`・`notify.test.ts`／Task 3: `member-requests.test.ts` 追記／Task 4: `admin-requests-square.test.ts`／Task 6: `admin-closed-settings.test.ts`・`admin-settings-square.test.ts`）。**リストにない既存テストは1文字も変更しない**（特に `schema.test.ts`・`schema2.test.ts`・`schema3.test.ts`・`dates.test.ts`・`square.test.ts`・`scheduled.test.ts`・`requests-core.test.ts`※・`member-page.test.ts`・`admin-*` の他ファイルは触らない。※ requests-core は Task 1 で1ケース**追記**する）

### テスト件数の見通し（現状126件起点）

| Task | 変更 | 増減 | 累計 |
|---|---|---:|---:|
| 起点 | ステップ③完了時 | — | 126 |
| 1 | `settings.test.ts` 10→9（−1）／`schema4.test.ts` 新規（+2）／`requests-core.test.ts` +1 | **+2** | **128** |
| 2 | `notify.test.ts` +1（`member-requests`・`member-square` は本文修正のみ増減なし） | **+1** | **129** |
| 3 | `member-requests.test.ts` +3（マーク1・非表示2） | **+3** | **132** |
| 4 | `admin-requests-square.test.ts` +1 | **+1** | **133** |
| 5 | `square-helpers.test.ts` 新規（+5） | **+5** | **138** |
| 6 | `admin-closed-settings.test.ts`・`admin-settings-square.test.ts` は本文修正のみ増減なし | **±0** | **138** |

**最終見込み: 138件**（計算根拠: 126 −1 +2 +1 +1 +3 +1 +5 = 138）。
`settings.test.ts` の −1 の内訳: 旧10件のうち `parseSlotsText`受け付け・`parseSlotsText`null・`slotsToText と findSlot` の3件を削除し、30分ヘルパー系2件（`isHalfStep`/`halfStepRange` 統合1件、`timeOptions` 1件）と `open_start/open_end` フォールバック1件を新設（−3 +3 だが、旧「シード値」「slots壊れ値フォールバック」の2枠を新規と入れ替える形で正味 9件）。

---

### Task 1: 設定コア刷新（open_start/open_end・30分ヘルパー）・migration 0004・非表示コア

**Files:**
- Create: `migrations/0004_step5.sql`
- Modify: `src/core/settings.ts`（全文差し替え: `open_start`/`open_end` と30分ヘルパーを追加。`slots` 系は Task 6 まで一時的に残す）
- Modify: `src/types.ts`（全文差し替え: `RequestRow` に `hidden_by_member` を追加）
- Modify: `src/core/requests.ts`（全文差し替え: `hideRequestByMember` を追加）
- Test: `test/schema4.test.ts`（新規）
- Test: `test/settings.test.ts`（全文差し替え・9件）
- Test: `test/requests-core.test.ts`（全文差し替え・1件追記で8件）

**Interfaces:**
- Consumes: `settings` テーブル（0001シード＋0004シード）、`requests` テーブル
- Produces:
  - `settings.ts`: `AppSettings` に `openStart`/`openEnd`。`SettingKey` に `'open_start'`/`'open_end'`。`DEFAULT_OPEN_START`='10:00' / `DEFAULT_OPEN_END`='21:00'。`isHalfStep(t)` / `halfStepRange(from,to)` / `timeOptions(openStart,openEnd)` / `validTimeRange(start,end,openStart,openEnd)`
  - `types.ts`: `RequestRow.hidden_by_member: number`
  - `requests.ts`: `hideRequestByMember(db, id, memberId): Promise<boolean>`（本人・終了状態〔declined/cancelled〕・未非表示のみ true）
  - `availability_cache` は変更なし。`requests.hidden_by_member INTEGER NOT NULL DEFAULT 0`

- [ ] **Step 1: 失敗するテストを書く**

`test/schema4.test.ts`（新規）:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

async function seedMember(): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO members (name, email, member_type, token, is_active, created_at) VALUES ('会員S5', 's5@example.com', 'monthly', ?, 1, '2026-07-25T00:00:00.000Z')`
  ).bind('s5'.padEnd(40, '0')).run();
  return res.meta.last_row_id as number;
}

const INSERT_REQ = `INSERT INTO requests (member_id, date, start_time, end_time, status, member_note, admin_note, created_at, updated_at)
  VALUES (?, '2026-09-01', '10:00', '12:00', 'declined', '', '', '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z')`;

describe('step5 schema', () => {
  it('requests.hidden_by_member は既定0で読み書きできる', async () => {
    const memberId = await seedMember();
    const r = await env.DB.prepare(INSERT_REQ).bind(memberId).run();
    const id = r.meta.last_row_id as number;
    const before = await env.DB.prepare('SELECT hidden_by_member FROM requests WHERE id = ?').bind(id).first<{ hidden_by_member: number }>();
    expect(before!.hidden_by_member).toBe(0);
    await env.DB.prepare('UPDATE requests SET hidden_by_member = 1 WHERE id = ?').bind(id).run();
    const after = await env.DB.prepare('SELECT hidden_by_member FROM requests WHERE id = ?').bind(id).first<{ hidden_by_member: number }>();
    expect(after!.hidden_by_member).toBe(1);
  });

  it('open_start/open_end が settings にシードされている', async () => {
    const rows = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('open_start', 'open_end')").all<{ key: string; value: string }>();
    const map = new Map(rows.results.map((r) => [r.key, r.value]));
    expect(map.get('open_start')).toBe('10:00');
    expect(map.get('open_end')).toBe('21:00');
  });
});
```

`test/settings.test.ts`（全文差し替え・9件）:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  getSettings, setSetting, saveSettings,
  isHalfStep, halfStepRange, timeOptions
} from '../src/core/settings';

describe('settings', () => {
  it('シード値を読み出せる（受付時間帯の既定は10:00〜21:00）', async () => {
    const s = await getSettings(env.DB);
    expect(s.openStart).toBe('10:00');
    expect(s.openEnd).toBe('21:00');
    expect(s.windowDays).toBe(60);
    expect(s.staffEmail).toBe('');
  });

  it('setSetting は上書き保存できる', async () => {
    await setSetting(env.DB, 'staff_email', 'staff@example.com');
    await setSetting(env.DB, 'window_days', '30');
    const s = await getSettings(env.DB);
    expect(s.staffEmail).toBe('staff@example.com');
    expect(s.windowDays).toBe(30);
  });

  it('open_start/open_end が壊れた値（非30分刻み・開始>=終了）でもデフォルトにフォールバックする', async () => {
    await setSetting(env.DB, 'open_start', '10:15'); // 30分刻みでない
    await setSetting(env.DB, 'open_end', '21:00');
    let s = await getSettings(env.DB);
    expect(s.openStart).toBe('10:00'); // 既定へ
    expect(s.openEnd).toBe('21:00');

    await setSetting(env.DB, 'open_start', '21:00'); // 開始>=終了
    await setSetting(env.DB, 'open_end', '10:00');
    s = await getSettings(env.DB);
    expect(s.openStart).toBe('10:00');
    expect(s.openEnd).toBe('21:00');

    await setSetting(env.DB, 'open_start', '09:00'); // 正しい値は反映
    await setSetting(env.DB, 'open_end', '18:30');
    s = await getSettings(env.DB);
    expect(s.openStart).toBe('09:00');
    expect(s.openEnd).toBe('18:30');
  });

  it('isHalfStep と halfStepRange', () => {
    expect(isHalfStep('10:00')).toBe(true);
    expect(isHalfStep('10:30')).toBe(true);
    expect(isHalfStep('10:15')).toBe(false); // 15分は不可
    expect(isHalfStep('24:00')).toBe(false); // 時が範囲外
    expect(isHalfStep('9:00')).toBe(false);  // ゼロ埋めでない
    expect(halfStepRange('10:00', '11:30')).toEqual(['10:00', '10:30', '11:00', '11:30']);
    expect(halfStepRange('10:00', '10:00')).toEqual(['10:00']);
  });

  it('timeOptions は開始（末尾を除く）・終了（先頭を除く）の選択肢を返す', () => {
    const { starts, ends } = timeOptions('10:00', '12:00');
    expect(starts).toEqual(['10:00', '10:30', '11:00', '11:30']); // 12:00 では始められない
    expect(ends).toEqual(['10:30', '11:00', '11:30', '12:00']);   // 10:00 では終われない
  });

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
});
```

`test/requests-core.test.ts`（全文差し替え・末尾に1件追記して8件）:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createRequest, confirmRequest, declineRequest, cancelRequestByMember, hideRequestByMember } from '../src/core/requests';

async function seedMember(name: string): Promise<number> {
  const token = crypto.randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
  const res = await env.DB.prepare(
    `INSERT INTO members (name, email, member_type, token, is_active, created_at) VALUES (?, ?, 'monthly', ?, 1, '2026-07-23T00:00:00.000Z')`
  ).bind(name, `${name}@example.com`, token).run();
  return res.meta.last_row_id as number;
}

const INPUT = { date: '2026-08-01', startTime: '10:00', endTime: '13:00', memberNote: '2名で利用' };

describe('requests core', () => {
  it('リクエストを作成できる（初期状態は申請中）', async () => {
    const memberId = await seedMember('作成');
    const result = await createRequest(env.DB, { memberId, ...INPUT });
    expect(result.ok).toBe(true);
    const row = await env.DB.prepare('SELECT * FROM requests WHERE member_id = ?').bind(memberId).first();
    expect(row!.status).toBe('pending');
    expect(row!.member_note).toBe('2名で利用');
  });

  it('同一日・同一枠の二重リクエストは duplicate で拒否', async () => {
    const memberId = await seedMember('重複');
    await createRequest(env.DB, { memberId, ...INPUT });
    const second = await createRequest(env.DB, { memberId, ...INPUT });
    expect(second).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('キャンセル後なら同じ日時に再リクエストできる', async () => {
    const memberId = await seedMember('再申請');
    const first = await createRequest(env.DB, { memberId, ...INPUT });
    if (!first.ok) throw new Error('unreachable');
    expect(await cancelRequestByMember(env.DB, first.id, memberId)).toBe(true);
    const second = await createRequest(env.DB, { memberId, ...INPUT });
    expect(second.ok).toBe(true);
  });

  it('確定は申請中のみ成功し、二度目は失敗する', async () => {
    const memberId = await seedMember('確定');
    const r = await createRequest(env.DB, { memberId, ...INPUT });
    if (!r.ok) throw new Error('unreachable');
    expect(await confirmRequest(env.DB, r.id)).toBe(true);
    expect(await confirmRequest(env.DB, r.id)).toBe(false); // confirmed → confirmed は不可
    const row = await env.DB.prepare('SELECT status FROM requests WHERE id = ?').bind(r.id).first();
    expect(row!.status).toBe('confirmed');
  });

  it('否認は理由を保存し、申請中以外には効かない', async () => {
    const memberId = await seedMember('否認');
    const r = await createRequest(env.DB, { memberId, ...INPUT });
    if (!r.ok) throw new Error('unreachable');
    expect(await declineRequest(env.DB, r.id, '満席のため')).toBe(true);
    const row = await env.DB.prepare('SELECT status, admin_note FROM requests WHERE id = ?').bind(r.id).first();
    expect(row!.status).toBe('declined');
    expect(row!.admin_note).toBe('満席のため');
    expect(await declineRequest(env.DB, r.id, '再否認')).toBe(false);
  });

  it('確定済みでも会員はキャンセルできるが、他人の分はキャンセルできない', async () => {
    const memberId = await seedMember('本人');
    const otherId = await seedMember('他人');
    const r = await createRequest(env.DB, { memberId, ...INPUT });
    if (!r.ok) throw new Error('unreachable');
    await confirmRequest(env.DB, r.id);
    expect(await cancelRequestByMember(env.DB, r.id, otherId)).toBe(false); // 他人
    expect(await cancelRequestByMember(env.DB, r.id, memberId)).toBe(true);  // 本人・確定済み
    expect(await cancelRequestByMember(env.DB, r.id, memberId)).toBe(false); // 二度目
  });

  it('否認済みはキャンセルできない', async () => {
    const memberId = await seedMember('否認後');
    const r = await createRequest(env.DB, { memberId, ...INPUT });
    if (!r.ok) throw new Error('unreachable');
    await declineRequest(env.DB, r.id, '');
    expect(await cancelRequestByMember(env.DB, r.id, memberId)).toBe(false);
  });

  it('hideRequestByMember は終了状態（否認/キャンセル）の本人の行だけ隠す', async () => {
    const memberId = await seedMember('非表示');
    const otherId = await seedMember('別人');
    const r = await createRequest(env.DB, { memberId, ...INPUT });
    if (!r.ok) throw new Error('unreachable');
    expect(await hideRequestByMember(env.DB, r.id, memberId)).toBe(false); // 申請中は隠せない
    await declineRequest(env.DB, r.id, '満席');
    expect(await hideRequestByMember(env.DB, r.id, otherId)).toBe(false);   // 他人は隠せない
    expect(await hideRequestByMember(env.DB, r.id, memberId)).toBe(true);   // 本人・否認済みは隠せる
    expect(await hideRequestByMember(env.DB, r.id, memberId)).toBe(false);  // 二度目は0行
    const row = await env.DB.prepare('SELECT hidden_by_member FROM requests WHERE id = ?').bind(r.id).first<{ hidden_by_member: number }>();
    expect(row!.hidden_by_member).toBe(1);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（`no such column: hidden_by_member` / `open_start` シード無し / `isHalfStep` 等が未定義 / `hideRequestByMember` が未定義）

- [ ] **Step 3: マイグレーションとコアを実装**

`migrations/0004_step5.sql`（新規）:

```sql
-- ステップ⑤(§17.4): 会員が自分のリクエスト一覧から終了状態の行を隠せるフラグ（記録自体は保全・管理画面には残す）。
ALTER TABLE requests ADD COLUMN hidden_by_member INTEGER NOT NULL DEFAULT 0;

-- ステップ⑤(§17.1): 時間枠テンプレート廃止に伴う「受付時間帯」設定のシード（既定 10:00〜21:00・30分刻み）。
-- 旧 'slots' 行（0001シード）は残置するが getSettings は Task 6 以降読まない（無害）。
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('open_start', '10:00'),
  ('open_end', '21:00');
```

`src/core/settings.ts`（全文差し替え・`slots` 系は Task 6 まで一時残置）:

```ts
export interface Slot {
  start: string; // 'HH:MM'
  end: string;   // 'HH:MM'
}

export interface AppSettings {
  slots: Slot[];        // ステップ⑤ Task 6 で廃止予定（互換のため一時残置。getSettings は読むが UI/POST はもう使わない）
  openStart: string;    // 受付時間帯の開始 'HH:MM'（30分刻み）
  openEnd: string;      // 受付時間帯の終了 'HH:MM'（30分刻み）
  windowDays: number;
  staffEmail: string;
  squareLocationId: string;
  squareServiceVariationId: string;
  syncEnabled: boolean; // squareLocationId と squareServiceVariationId が両方非空なら true
}

export type SettingKey =
  | 'slots'
  | 'open_start'
  | 'open_end'
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
export const DEFAULT_OPEN_START = '10:00';
export const DEFAULT_OPEN_END = '21:00';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const HALF_STEP_RE = /^([01]\d|2[0-3]):(00|30)$/;

// 30分刻みの時刻か（時は00〜23・分は '00' か '30' のみ・ゼロ埋め必須）
export function isHalfStep(t: string): boolean {
  return HALF_STEP_RE.test(t);
}

function toMinutes(t: string): number {
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
}

function toHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// from..to を30分刻みで列挙（両端含む）。from/to は30分刻み・from<=to を前提とする。
export function halfStepRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = toMinutes(from); m <= toMinutes(to); m += 30) out.push(toHHMM(m));
  return out;
}

// 受付時間帯から開始・終了プルダウンの選択肢を作る。
// starts は末尾（openEnd）を除く＝開始は必ず終了より前になる。ends は先頭（openStart）を除く。
export function timeOptions(openStart: string, openEnd: string): { starts: string[]; ends: string[] } {
  const all = halfStepRange(openStart, openEnd);
  return { starts: all.slice(0, -1), ends: all.slice(1) };
}

// 会員リクエストの時間検証: 30分刻み・受付時間帯内・開始<終了。'HH:MM' はゼロ埋めなので文字列比較で順序判定できる。
export function validTimeRange(start: string, end: string, openStart: string, openEnd: string): boolean {
  return isHalfStep(start) && isHalfStep(end) && start >= openStart && end <= openEnd && start < end;
}

export async function getSettings(db: D1Database): Promise<AppSettings> {
  const rows = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const map = new Map(rows.results.map((r) => [r.key, r.value]));

  // slots（一時互換・Task 6 で除去）。壊れた値はデフォルトにフォールバックする多層防御。
  let slots = DEFAULT_SLOTS;
  const slotsRaw = map.get('slots');
  if (slotsRaw) {
    try {
      const parsed = JSON.parse(slotsRaw);
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
      // 壊れた値はデフォルトにフォールバック
    }
  }

  // 受付時間帯。両方が30分刻みで開始<終了のときだけ採用し、そうでなければ既定にフォールバックする。
  let openStart = DEFAULT_OPEN_START;
  let openEnd = DEFAULT_OPEN_END;
  const rawStart = (map.get('open_start') ?? '').trim();
  const rawEnd = (map.get('open_end') ?? '').trim();
  if (isHalfStep(rawStart) && isHalfStep(rawEnd) && rawStart < rawEnd) {
    openStart = rawStart;
    openEnd = rawEnd;
  }

  const windowRaw = Number(map.get('window_days'));
  const windowDays = Number.isInteger(windowRaw) && windowRaw >= 1 && windowRaw <= 365 ? windowRaw : DEFAULT_WINDOW_DAYS;

  const squareLocationId = (map.get('square_location_id') ?? '').trim();
  const squareServiceVariationId = (map.get('square_service_variation_id') ?? '').trim();
  const syncEnabled = squareLocationId !== '' && squareServiceVariationId !== '';

  return {
    slots,
    openStart,
    openEnd,
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
export async function saveSettings(db: D1Database, entries: { key: SettingKey; value: string }[]): Promise<void> {
  if (entries.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  await db.batch(entries.map((e) => stmt.bind(e.key, e.value)));
}

// --- 以下は Task 6 で削除予定（slots テンプレートの旧ヘルパー。UI/POST からの参照が消えるまで残す） ---

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

`src/types.ts`（全文差し替え・`RequestRow` に `hidden_by_member` を追加）:

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
  hidden_by_member: number; // 1 = 会員が一覧から非表示にした（管理画面には残る）
  created_at: string;
  updated_at: string;
}

export interface AvailabilityCacheRow {
  date: string;       // 'YYYY-MM-DD'
  slots_json: string; // JSON配列文字列（開始時刻 'HH:MM' の配列）
  fetched_at: string; // ISO文字列（UTC）
}
```

`src/core/requests.ts`（全文差し替え・`hideRequestByMember` を追加）:

```ts
export type CreateRequestResult = { ok: true; id: number } | { ok: false; reason: 'duplicate' };

export async function createRequest(
  db: D1Database,
  input: { memberId: number; date: string; startTime: string; endTime: string; memberNote: string }
): Promise<CreateRequestResult> {
  const now = new Date().toISOString();
  try {
    const res = await db.prepare(
      `INSERT INTO requests (member_id, date, start_time, end_time, status, member_note, admin_note, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, '', ?, ?)`
    ).bind(input.memberId, input.date, input.startTime, input.endTime, input.memberNote, now, now).run();
    return { ok: true, id: res.meta.last_row_id as number };
  } catch (e) {
    // 部分UNIQUE（ux_requests_active）違反 = 同一日・同一枠のアクティブなリクエストが既にある。
    // それ以外の失敗（FK違反・一時障害など）を duplicate と誤報告しないよう、UNIQUE違反のみを分類する
    if (e instanceof Error && e.message.includes('UNIQUE constraint failed')) {
      return { ok: false, reason: 'duplicate' };
    }
    throw e;
  }
}

// 遷移はすべて「現在の状態をWHEREに含む条件付きUPDATE」。0行更新 = 遷移不可（false）

export async function confirmRequest(db: D1Database, id: number): Promise<boolean> {
  const res = await db.prepare(
    `UPDATE requests SET status = 'confirmed', updated_at = ? WHERE id = ? AND status = 'pending'`
  ).bind(new Date().toISOString(), id).run();
  return res.meta.changes === 1;
}

export async function declineRequest(db: D1Database, id: number, adminNote: string): Promise<boolean> {
  const res = await db.prepare(
    `UPDATE requests SET status = 'declined', admin_note = ?, updated_at = ? WHERE id = ? AND status = 'pending'`
  ).bind(adminNote, new Date().toISOString(), id).run();
  return res.meta.changes === 1;
}

export async function cancelRequestByMember(db: D1Database, id: number, memberId: number): Promise<boolean> {
  const res = await db.prepare(
    `UPDATE requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND member_id = ? AND status IN ('pending', 'confirmed')`
  ).bind(new Date().toISOString(), id, memberId).run();
  return res.meta.changes === 1;
}

// 会員が自分の「終了状態（否認/キャンセル済み）」の行を一覧から非表示にする。本人・終了状態・未非表示のみ true。
// 記録自体は消さない（管理画面の一覧には残る）。0行更新 = 非表示にできない（false）。
export async function hideRequestByMember(db: D1Database, id: number, memberId: number): Promise<boolean> {
  const res = await db.prepare(
    `UPDATE requests SET hidden_by_member = 1, updated_at = ?
     WHERE id = ? AND member_id = ? AND status IN ('declined', 'cancelled') AND hidden_by_member = 0`
  ).bind(new Date().toISOString(), id, memberId).run();
  return res.meta.changes === 1;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（累計 **128件**。`settings.test.ts` 9件・`schema4.test.ts` 2件・`requests-core.test.ts` 8件。既存の `member.tsx`/`settings.tsx` は `slots` 系ヘルパーを残しているためコンパイル・既存テストとも影響なし）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add migrations/0004_step5.sql src/core/settings.ts src/types.ts src/core/requests.ts test/schema4.test.ts test/settings.test.ts test/requests-core.test.ts
git commit -m "feat: 受付時間帯(open_start/open_end)と30分ヘルパー・migration 0004(hidden_by_member)・非表示コアを追加"
```

---

### Task 2: 会員フォームの30分単位化・日単位の空き判定・受付確認メール（requested_member）

**Files:**
- Modify: `src/routes/member.tsx`（全文差し替え: フォームを開始/終了selectに・POST検証を`validTimeRange`に・Square判定を日単位に・会員宛受付確認メールを追加）
- Modify: `src/core/notify.ts`（全文差し替え: `EmailType` に `requested_member` を追加し会員宛の受付確認本文を実装）
- Test: `test/member-requests.test.ts`（全文差し替え・8件のまま）
- Test: `test/member-square.test.ts`（全文差し替え・6件のまま）
- Test: `test/notify.test.ts`（全文差し替え・末尾に1件追記して9件）

**Interfaces:**
- Consumes: Task 1 の `timeOptions(openStart, openEnd)` / `validTimeRange(start, end, openStart, openEnd)`（`src/core/settings.ts`）、`getCachedStarts`（`src/core/square.ts`・変更なし）、`createRequest`/`cancelRequestByMember`（変更なし）
- Produces:
  - `notify.ts`: `EmailType = 'requested' | 'requested_member' | 'cancelled' | 'confirmed' | 'declined' | 'sync_stale'`。`requested_member` は会員本人宛・件名「【TORCH】リクエストを受け付けました: {日時}」
  - `member.tsx`: POST `/m/:token/requests` のフォームフィールドは `date`/`start`/`end`/`note`（旧: `date`/`start`/`note`。`end` が新規必須）。Task 3 はこの版の `member.tsx` に予約マークと非表示を積む
  - 同期有効時の空き判定は**日単位**: キャッシュ行なし=取得中（フォーム非表示・POSTは`unavailable`）、空配列=「この日はSquare側で空きがありません」（POSTは`unavailable`）、1つでも空きがあれば受付時間帯の全選択肢を表示

- [ ] **Step 1: 失敗するテストを書く**

`test/member-requests.test.ts`（全文差し替え・8件）:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { adminCookie } from './helpers';
import { currentJstDate, addDays, monthOf, addMonths } from '../src/core/dates';

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

async function postRequest(token: string, body: Record<string, string>): Promise<Response> {
  return app.request(`/m/${token}/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  }, env);
}

const target = addDays(currentJstDate(), 7);

describe('member requests', () => {
  it('カレンダーに月と開始・終了の時間プルダウンが表示される', async () => {
    const { token } = await createMember('カレンダー会員');
    const res = await app.request(`/m/${token}?date=${target}`, {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    const [ty, tm] = monthOf(target).split('-');
    expect(html).toContain(`${ty}年${Number(tm)}月`); // 例: 2026年7月（先頭ゼロなし）
    expect(html).toContain('開始時刻');
    expect(html).toContain('終了時刻');
    expect(html).toContain('<option value="10:00">10:00</option>'); // 既定の受付時間帯 10:00〜21:00 の開始側先頭
    expect(html).toContain('<option value="21:00">21:00</option>'); // 終了側の最終選択肢
    expect(html).toContain('リクエスト送信');

    // 不正な月パラメータは無視して当月にフォールバックする
    const badMonth = await app.request(`/m/${token}?month=2026-99`, {}, env);
    expect(badMonth.status).toBe(200);
  });

  it('リクエスト送信で申請中になり、スタッフ通知と会員宛の受付確認が記録される', async () => {
    const { id, token } = await createMember('送信会員');
    const res = await postRequest(token, { date: target, start: '10:30', end: '15:00', note: '午前から利用します' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('ok=requested');

    const row = await env.DB.prepare('SELECT * FROM requests WHERE member_id = ?').bind(id).first();
    expect(row!.status).toBe('pending');
    expect(row!.start_time).toBe('10:30');
    expect(row!.end_time).toBe('15:00'); // 会員が選んだ終了時刻がそのまま入る（テンプレート補完は廃止）
    expect(row!.member_note).toBe('午前から利用します');

    const logs = await env.DB.prepare('SELECT type, status FROM email_log WHERE request_id = ? ORDER BY id')
      .bind(row!.id).all<{ type: string; status: string }>();
    expect(logs.results.map((l) => l.type)).toEqual(['requested', 'requested_member']); // スタッフ宛→会員宛の順
    expect(logs.results.every((l) => l.status === 'skipped')).toBe(true); // テストではRESEND_API_KEY未設定

    const page = await app.request(`/m/${token}`, {}, env);
    const html = await page.text();
    expect(html).toContain('申請中');
    expect(html).toContain('キャンセル');
  });

  it('同じ日・同じ開始時刻の二重リクエストは弾かれる', async () => {
    const { token } = await createMember('重複会員');
    await postRequest(token, { date: target, start: '10:00', end: '13:00', note: '' });
    const res = await postRequest(token, { date: target, start: '10:00', end: '13:00', note: '' });
    expect(res.headers.get('location')).toContain('error=duplicate');
  });

  it('過去日・期間外・30分単位でない/時間帯外/逆転の時間・長すぎるメモは invalid', async () => {
    const { token } = await createMember('不正会員');
    const base = { start: '10:00', end: '13:00', note: '' };
    expect((await postRequest(token, { date: addDays(currentJstDate(), -1), ...base })).headers.get('location')).toContain('error=invalid');
    expect((await postRequest(token, { date: addDays(currentJstDate(), 120), ...base })).headers.get('location')).toContain('error=invalid');
    expect((await postRequest(token, { date: target, start: '10:15', end: '13:00', note: '' })).headers.get('location')).toContain('error=invalid'); // 30分単位でない
    expect((await postRequest(token, { date: target, start: '09:30', end: '13:00', note: '' })).headers.get('location')).toContain('error=invalid'); // 受付開始前
    expect((await postRequest(token, { date: target, start: '10:00', end: '21:30', note: '' })).headers.get('location')).toContain('error=invalid'); // 受付終了後
    expect((await postRequest(token, { date: target, start: '13:00', end: '13:00', note: '' })).headers.get('location')).toContain('error=invalid'); // 開始=終了
    expect((await postRequest(token, { date: target, start: '10:00', end: '13:00', note: 'あ'.repeat(501) })).headers.get('location')).toContain('error=invalid');
    expect((await postRequest(token, { date: `${monthOf(target)}-32`, ...base })).headers.get('location')).toContain('error=invalid'); // 窓内相当だが暦に存在しない日付
  });

  it('受付停止日にはリクエストできず、カレンダーにも停止と表示される', async () => {
    const { token } = await createMember('停止日会員');
    const closed = addDays(currentJstDate(), 10);
    await env.DB.prepare(`INSERT INTO closed_dates (date, reason) VALUES (?, '臨時休業')`).bind(closed).run();

    const res = await postRequest(token, { date: closed, start: '10:00', end: '13:00', note: '' });
    expect(res.headers.get('location')).toContain('error=closed');

    const page = await app.request(`/m/${token}?month=${monthOf(closed)}`, {}, env);
    expect(await page.text()).toContain('停');

    // 表示月が別でも選択日の停止判定は独立している（?month と ?date の組み合わせ対策）
    const cross = await app.request(`/m/${token}?month=${addMonths(monthOf(closed), 1)}&date=${closed}`, {}, env);
    const crossHtml = await cross.text();
    expect(crossHtml).toContain('受付を停止しています');
    expect(crossHtml).not.toContain('リクエスト送信');
  });

  it('本人はキャンセルでき、スタッフ通知が記録される', async () => {
    const { id, token } = await createMember('取消会員');
    await postRequest(token, { date: target, start: '13:00', end: '17:00', note: '' });
    const row = await env.DB.prepare('SELECT id FROM requests WHERE member_id = ?').bind(id).first<{ id: number }>();

    const res = await app.request(`/m/${token}/requests/${row!.id}/cancel`, { method: 'POST' }, env);
    expect(res.headers.get('location')).toContain('ok=cancelled');

    const after = await env.DB.prepare('SELECT status FROM requests WHERE id = ?').bind(row!.id).first();
    expect(after!.status).toBe('cancelled');
    const log = await env.DB.prepare('SELECT type FROM email_log WHERE request_id = ? ORDER BY id DESC LIMIT 1').bind(row!.id).first();
    expect(log!.type).toBe('cancelled');
  });

  it('他人のリクエストはキャンセルできない', async () => {
    const a = await createMember('会員AA');
    const b = await createMember('会員BB');
    await postRequest(a.token, { date: target, start: '17:00', end: '19:00', note: '' });
    const row = await env.DB.prepare('SELECT id FROM requests WHERE member_id = ?').bind(a.id).first<{ id: number }>();

    const res = await app.request(`/m/${b.token}/requests/${row!.id}/cancel`, { method: 'POST' }, env);
    expect(res.headers.get('location')).toContain('error=invalid');
    const after = await env.DB.prepare('SELECT status FROM requests WHERE id = ?').bind(row!.id).first();
    expect(after!.status).toBe('pending');
  });

  it('無効トークンでのPOSTは404', async () => {
    const res = await postRequest('f'.repeat(40), { date: target, start: '10:00', end: '13:00', note: '' });
    expect(res.status).toBe(404);
  });
});
```

`test/member-square.test.ts`（全文差し替え・6件）:

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
  it('同期有効: 空きが1つでもある日はフォームが出て、時間は受付時間帯から選べる', async () => {
    const { token } = await createMember('同期会員A');
    await enableSync();
    await seedCache(target, ['13:00']); // 空きは1件だけだが日単位判定なのでフォームは出る
    const res = await app.request(`/m/${token}?date=${target}`, {}, env);
    const html = await res.text();
    expect(html).toContain('リクエスト送信');
    expect(html).toContain('開始時刻');
    expect(html).toContain('<option value="10:00">10:00</option>'); // 選択肢はキャッシュに関係なく受付時間帯の全30分刻み
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

  it('同期有効: 空き開始時刻がゼロの日は「Square側で空きがありません」', async () => {
    const { token } = await createMember('同期会員C');
    await enableSync();
    await seedCache(target, []); // 満枠
    const res = await app.request(`/m/${token}?date=${target}`, {}, env);
    const html = await res.text();
    expect(html).toContain('この日はSquare側で空きがありません');
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

  it('同期有効: 空きゼロの日・未取得の日へのPOSTは unavailable', async () => {
    const { token } = await createMember('同期会員E');
    await enableSync();
    await seedCache(target, []); // 満枠
    const res = await postRequest(token, { date: target, start: '10:00', end: '13:00', note: '' });
    expect(res.headers.get('location')).toContain('error=unavailable');

    const unfetched = addDays(target, 1); // キャッシュ未取得の日
    const res2 = await postRequest(token, { date: unfetched, start: '10:00', end: '13:00', note: '' });
    expect(res2.headers.get('location')).toContain('error=unavailable');

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM requests').first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it('同期有効: 空きがある日へのPOSTはキャッシュに無い時間帯でも申請できる（日単位判定）', async () => {
    const { id, token } = await createMember('同期会員F');
    await enableSync();
    await seedCache(target, ['13:00']); // 10:30 の開始時刻はキャッシュに無いが、日に空きがあれば受け付ける
    const res = await postRequest(token, { date: target, start: '10:30', end: '12:00', note: '窓側希望' });
    expect(res.headers.get('location')).toContain('ok=requested');
    const row = await env.DB.prepare('SELECT status, start_time, end_time FROM requests WHERE member_id = ?')
      .bind(id).first<{ status: string; start_time: string; end_time: string }>();
    expect(row!.status).toBe('pending');
    expect(row!.start_time).toBe('10:30');
    expect(row!.end_time).toBe('12:00');
  });
});
```

`test/notify.test.ts`（全文差し替え・末尾に1件追記して9件）:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { sendRequestNotification, sendSyncStaleNotification } from '../src/core/notify';
import { setSetting } from '../src/core/settings';

async function seedRequest(): Promise<number> {
  const token = crypto.randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
  const m = await env.DB.prepare(
    `INSERT INTO members (name, email, member_type, token, is_active, created_at) VALUES ('通知会員', 'member@example.com', 'ticket', ?, 1, '2026-07-23T00:00:00.000Z')`
  ).bind(token).run();
  const r = await env.DB.prepare(
    `INSERT INTO requests (member_id, date, start_time, end_time, status, member_note, admin_note, created_at, updated_at)
     VALUES (?, '2026-08-01', '10:00', '13:00', 'pending', 'メモです', '', '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z')`
  ).bind(m.meta.last_row_id).run();
  return r.meta.last_row_id as number;
}

async function lastLog(): Promise<{ to_address: string; type: string; status: string } | null> {
  return env.DB.prepare('SELECT to_address, type, status FROM email_log ORDER BY id DESC LIMIT 1').first();
}

describe('notify', () => {
  it('APIキー未設定なら送信せず skipped を記録する', async () => {
    const id = await seedRequest();
    await setSetting(env.DB, 'staff_email', 'staff@example.com');
    await sendRequestNotification(env.DB, {}, id, 'requested', 'http://localhost:8787');
    const log = await lastLog();
    expect(log).toEqual({ to_address: 'staff@example.com', type: 'requested', status: 'skipped' });
  });

  it('スタッフ宛先が未設定でも skipped を記録して落ちない', async () => {
    const id = await seedRequest();
    await setSetting(env.DB, 'staff_email', '');
    await sendRequestNotification(env.DB, { RESEND_API_KEY: 'key' }, id, 'requested', 'http://localhost:8787');
    const log = await lastLog();
    expect(log!.status).toBe('skipped');
  });

  it('requested はスタッフ宛に送信し sent を記録する', async () => {
    const id = await seedRequest();
    await setSetting(env.DB, 'staff_email', 'staff@example.com');
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await sendRequestNotification(env.DB, { RESEND_API_KEY: 'key', NOTIFY_EMAIL_FROM: 'noreply@example.com' }, id, 'requested', 'http://localhost:8787', fetcher);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer key');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.to).toEqual(['staff@example.com']);
    expect(body.subject).toContain('利用リクエスト');
    expect(body.text).toContain('通知会員');
    expect(body.text).toContain('2026-08-01');
    expect(body.text).toContain('http://localhost:8787/admin/requests');
    expect((await lastLog())!.status).toBe('sent');
  });

  it('confirmed は会員本人宛に送信する', async () => {
    const id = await seedRequest();
    const calls: { init: RequestInit }[] = [];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ init: init! });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await sendRequestNotification(env.DB, { RESEND_API_KEY: 'key' }, id, 'confirmed', 'http://localhost:8787', fetcher);

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.to).toEqual(['member@example.com']);
    expect(body.subject).toContain('確定');
  });

  it('API失敗や例外でも呼び出し元には投げず error を記録する', async () => {
    const id = await seedRequest();
    await setSetting(env.DB, 'staff_email', 'staff@example.com');
    const failFetcher = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    await sendRequestNotification(env.DB, { RESEND_API_KEY: 'key' }, id, 'cancelled', 'http://localhost:8787', failFetcher);
    expect((await lastLog())!.status).toBe('error');

    const throwFetcher = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    await expect(
      sendRequestNotification(env.DB, { RESEND_API_KEY: 'key' }, id, 'cancelled', 'http://localhost:8787', throwFetcher)
    ).resolves.toBeUndefined();
    expect((await lastLog())!.status).toBe('error');
  });

  it('declined は会員本人宛に理由付きで送信する', async () => {
    const id = await seedRequest();
    await env.DB.prepare(`UPDATE requests SET status = 'declined', admin_note = '満席のため' WHERE id = ?`).bind(id).run();
    const calls: { init: RequestInit }[] = [];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ init: init! });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await sendRequestNotification(env.DB, { RESEND_API_KEY: 'key' }, id, 'declined', 'http://localhost:8787', fetcher);

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.to).toEqual(['member@example.com']);
    expect(body.subject).toContain('リクエストについて');
    expect(body.text).toContain('満席のため');
  });

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

  it('requested_member は会員本人宛に受付確認を送信する', async () => {
    const id = await seedRequest();
    const calls: { init: RequestInit }[] = [];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ init: init! });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await sendRequestNotification(env.DB, { RESEND_API_KEY: 'key' }, id, 'requested_member', 'http://localhost:8787', fetcher);

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.to).toEqual(['member@example.com']);
    expect(body.subject).toContain('受け付けました');
    expect(body.text).toContain('2026-08-01 10:00〜13:00');
    expect(body.text).toContain('メモです');
    expect(await lastLog()).toEqual({ to_address: 'member@example.com', type: 'requested_member', status: 'sent' });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（会員ページに「開始時刻」select が無い／`end` フィールド未対応で `end_time` が想定と異なる／`requested_member` が未実装で email_log に記録されない／日単位判定未実装で `unavailable`・「Square側で空きがありません」にならない）

- [ ] **Step 3: 実装する**

`src/core/notify.ts`（全文差し替え）:

```ts
import { getSettings } from './settings';

export type EmailType = 'requested' | 'requested_member' | 'cancelled' | 'confirmed' | 'declined' | 'sync_stale';

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
    } else if (type === 'requested_member') {
      // ステップ⑤(§17.3): 会員本人への受付確認（スタッフ宛 requested とは別に送る）
      to = r.member_email;
      subject = `【TORCH】リクエストを受け付けました: ${when}`;
      lines = [
        `${r.member_name}様`,
        '',
        '以下のご利用リクエストを受け付けました。スタッフが確認のうえ、確定/否認の結果を追ってメールでお知らせします。',
        '',
        `日時: ${when}`,
        r.member_note ? `メモ: ${r.member_note}` : '',
        '',
        '変更やキャンセルはご自身の専用ページ、またはLINEでご連絡ください。'
      ];
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

`src/routes/member.tsx`（全文差し替え）:

```tsx
import { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import type { Bindings, MemberRow, RequestRow, RequestStatus } from '../types';
import { TYPE_LABELS, TYPE_BADGE_CLASSES } from './admin/ui';
import {
  WEEKDAY_LABELS, currentJstDate, addDays, monthOf, addMonths, buildMonthGrid,
  formatMD, isValidDate, isValidMonth, weekdayOf, formatStampJst
} from '../core/dates';
import { getSettings, timeOptions, validTimeRange } from '../core/settings';
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
  invalid: '入力内容に誤りがあります。日付と時間（30分単位・終了は開始より後）をご確認ください',
  closed: 'この日は受付を停止しています',
  duplicate: 'この日時にはすでにリクエスト済みです',
  unavailable: 'この日はSquare側の空きがないため、現在ご案内できません'
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

  // ステップ⑤(§17.1): 時間枠テンプレートを廃止し、受付時間帯の30分刻みから開始/終了を自由に選ぶ
  const { starts: startOptions, ends: endOptions } = timeOptions(settings.openStart, settings.openEnd);

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
      <p class="muted small">日付を選ぶと開始・終了時刻を選べます（{formatMD(today)}〜{formatMD(maxDate)} 受付）</p>
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
          ) : syncEnabled && selectedCacheStarts !== null && selectedCacheStarts.length === 0 ? (
            <p class="muted">この日はSquare側で空きがありません。別の日をお選びください。</p>
          ) : (
            <form class="card card-pad" method="post" action={`/m/${token}/requests`}>
              <input type="hidden" name="date" value={selectedDate} />
              <div class="field">
                <label>開始時刻</label>
                <select name="start">
                  {startOptions.map((t) => (
                    <option value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div class="field">
                <label>終了時刻</label>
                <select name="end">
                  {endOptions.map((t) => (
                    <option value={t}>{t}</option>
                  ))}
                </select>
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
  const end = typeof form.end === 'string' ? form.end : '';
  const note = typeof form.note === 'string' ? form.note.trim() : '';

  const settings = await getSettings(c.env.DB);
  const today = currentJstDate();
  const maxDate = addDays(today, settings.windowDays);

  // 30分刻み・受付時間帯内・開始<終了は validTimeRange で一括検証（§17.1）
  if (
    !isValidDate(date) || date < today || date > maxDate ||
    !validTimeRange(start, end, settings.openStart, settings.openEnd) ||
    note.length > NOTE_MAX
  ) {
    return c.redirect(`/m/${token}?date=${isValidDate(date) ? date : ''}&error=invalid`);
  }

  const closed = await c.env.DB.prepare('SELECT date FROM closed_dates WHERE date = ?').bind(date).first();
  if (closed) return c.redirect(`/m/${token}?error=closed`);

  // 同期有効時は日単位で判定: その日の空き開始時刻が1つも無ければ受け付けない（未取得日も同様）。
  // 枠単位の照合は廃止（席に余裕がある運用・最終判断はスタッフの承認で行う）
  if (settings.syncEnabled) {
    const starts = await getCachedStarts(c.env.DB, date, date);
    const available = starts.get(date);
    if (available === undefined || available.length === 0) {
      return c.redirect(`/m/${token}?date=${date}&error=unavailable`);
    }
  }

  const result = await createRequest(c.env.DB, {
    memberId: m.id,
    date,
    startTime: start,
    endTime: end,
    memberNote: note
  });
  if (!result.ok) return c.redirect(`/m/${token}?date=${date}&error=duplicate`);

  // スタッフ宛の新規リクエスト通知に加え、会員本人へ受付確認を送る（§17.3。どちらも絶対に例外を投げない）
  const origin = new URL(c.req.url).origin;
  await sendRequestNotification(c.env.DB, c.env, result.id, 'requested', origin);
  await sendRequestNotification(c.env.DB, c.env, result.id, 'requested_member', origin);
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
Expected: PASS（累計 **129件**。member-requests 8件・member-square 6件・notify 9件。`settings.slots` は getSettings に残っているが member.tsx はもう参照しない）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/routes/member.tsx src/core/notify.ts test/member-requests.test.ts test/member-square.test.ts test/notify.test.ts
git commit -m "feat: 会員フォームを30分単位の開始・終了選択に変更し、日単位の空き判定と受付確認メール(requested_member)を追加"
```

---

### Task 3: 会員カレンダーの予約マーク・「あなたのリクエスト」の非表示ボタン

**Files:**
- Modify: `src/routes/member.tsx`（全文差し替え: Task 2 の版に、月内リクエストのドット表示・凡例・非表示ボタン・`/hide` ルートを追加）
- Modify: `src/routes/style-css.ts`（全文差し替え: ドット・凡例のスタイルを末尾に追加）
- Test: `test/member-requests.test.ts`（全文差し替え: Task 2 の8件の末尾に3件追記して11件）

**Interfaces:**
- Consumes: Task 1 の `hideRequestByMember(db, id, memberId)`（`src/core/requests.ts`）、`RequestRow.hidden_by_member`（`src/types.ts`）
- Produces:
  - POST `/m/:token/requests/:id/hide` — 本人・終了状態（declined/cancelled）・未非表示のみ成功し `ok=hidden`、それ以外は `error=invalid`。メールは送らない
  - 会員ページの一覧・カレンダーのマークは `hidden_by_member = 0` の行だけを対象にする（管理画面の一覧は変更なし＝隠した行も残る）
  - カレンダーの日セルに1点だけドット表示: 優先度 確定(`dot-confirmed`緑) > 申請中(`dot-pending`橙) > 否認(`dot-declined`赤)。凡例をカレンダー直下に表示
  - CSSクラス `cal-dot` / `cal-legend` / `legend-item` / `dot-pending` / `dot-confirmed` / `dot-declined`（`style-css.ts`）

- [ ] **Step 1: 失敗するテストを書く**

`test/member-requests.test.ts`（全文差し替え。Task 2 の8件はそのまま、`describe` 末尾に以下の3件を追記して11件）:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { adminCookie } from './helpers';
import { currentJstDate, addDays, monthOf, addMonths } from '../src/core/dates';

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

async function postRequest(token: string, body: Record<string, string>): Promise<Response> {
  return app.request(`/m/${token}/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  }, env);
}

const target = addDays(currentJstDate(), 7);

describe('member requests', () => {
  it('カレンダーに月と開始・終了の時間プルダウンが表示される', async () => {
    const { token } = await createMember('カレンダー会員');
    const res = await app.request(`/m/${token}?date=${target}`, {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    const [ty, tm] = monthOf(target).split('-');
    expect(html).toContain(`${ty}年${Number(tm)}月`); // 例: 2026年7月（先頭ゼロなし）
    expect(html).toContain('開始時刻');
    expect(html).toContain('終了時刻');
    expect(html).toContain('<option value="10:00">10:00</option>'); // 既定の受付時間帯 10:00〜21:00 の開始側先頭
    expect(html).toContain('<option value="21:00">21:00</option>'); // 終了側の最終選択肢
    expect(html).toContain('リクエスト送信');

    // 不正な月パラメータは無視して当月にフォールバックする
    const badMonth = await app.request(`/m/${token}?month=2026-99`, {}, env);
    expect(badMonth.status).toBe(200);
  });

  it('リクエスト送信で申請中になり、スタッフ通知と会員宛の受付確認が記録される', async () => {
    const { id, token } = await createMember('送信会員');
    const res = await postRequest(token, { date: target, start: '10:30', end: '15:00', note: '午前から利用します' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('ok=requested');

    const row = await env.DB.prepare('SELECT * FROM requests WHERE member_id = ?').bind(id).first();
    expect(row!.status).toBe('pending');
    expect(row!.start_time).toBe('10:30');
    expect(row!.end_time).toBe('15:00'); // 会員が選んだ終了時刻がそのまま入る（テンプレート補完は廃止）
    expect(row!.member_note).toBe('午前から利用します');

    const logs = await env.DB.prepare('SELECT type, status FROM email_log WHERE request_id = ? ORDER BY id')
      .bind(row!.id).all<{ type: string; status: string }>();
    expect(logs.results.map((l) => l.type)).toEqual(['requested', 'requested_member']); // スタッフ宛→会員宛の順
    expect(logs.results.every((l) => l.status === 'skipped')).toBe(true); // テストではRESEND_API_KEY未設定

    const page = await app.request(`/m/${token}`, {}, env);
    const html = await page.text();
    expect(html).toContain('申請中');
    expect(html).toContain('キャンセル');
  });

  it('同じ日・同じ開始時刻の二重リクエストは弾かれる', async () => {
    const { token } = await createMember('重複会員');
    await postRequest(token, { date: target, start: '10:00', end: '13:00', note: '' });
    const res = await postRequest(token, { date: target, start: '10:00', end: '13:00', note: '' });
    expect(res.headers.get('location')).toContain('error=duplicate');
  });

  it('過去日・期間外・30分単位でない/時間帯外/逆転の時間・長すぎるメモは invalid', async () => {
    const { token } = await createMember('不正会員');
    const base = { start: '10:00', end: '13:00', note: '' };
    expect((await postRequest(token, { date: addDays(currentJstDate(), -1), ...base })).headers.get('location')).toContain('error=invalid');
    expect((await postRequest(token, { date: addDays(currentJstDate(), 120), ...base })).headers.get('location')).toContain('error=invalid');
    expect((await postRequest(token, { date: target, start: '10:15', end: '13:00', note: '' })).headers.get('location')).toContain('error=invalid'); // 30分単位でない
    expect((await postRequest(token, { date: target, start: '09:30', end: '13:00', note: '' })).headers.get('location')).toContain('error=invalid'); // 受付開始前
    expect((await postRequest(token, { date: target, start: '10:00', end: '21:30', note: '' })).headers.get('location')).toContain('error=invalid'); // 受付終了後
    expect((await postRequest(token, { date: target, start: '13:00', end: '13:00', note: '' })).headers.get('location')).toContain('error=invalid'); // 開始=終了
    expect((await postRequest(token, { date: target, start: '10:00', end: '13:00', note: 'あ'.repeat(501) })).headers.get('location')).toContain('error=invalid');
    expect((await postRequest(token, { date: `${monthOf(target)}-32`, ...base })).headers.get('location')).toContain('error=invalid'); // 窓内相当だが暦に存在しない日付
  });

  it('受付停止日にはリクエストできず、カレンダーにも停止と表示される', async () => {
    const { token } = await createMember('停止日会員');
    const closed = addDays(currentJstDate(), 10);
    await env.DB.prepare(`INSERT INTO closed_dates (date, reason) VALUES (?, '臨時休業')`).bind(closed).run();

    const res = await postRequest(token, { date: closed, start: '10:00', end: '13:00', note: '' });
    expect(res.headers.get('location')).toContain('error=closed');

    const page = await app.request(`/m/${token}?month=${monthOf(closed)}`, {}, env);
    expect(await page.text()).toContain('停');

    // 表示月が別でも選択日の停止判定は独立している（?month と ?date の組み合わせ対策）
    const cross = await app.request(`/m/${token}?month=${addMonths(monthOf(closed), 1)}&date=${closed}`, {}, env);
    const crossHtml = await cross.text();
    expect(crossHtml).toContain('受付を停止しています');
    expect(crossHtml).not.toContain('リクエスト送信');
  });

  it('本人はキャンセルでき、スタッフ通知が記録される', async () => {
    const { id, token } = await createMember('取消会員');
    await postRequest(token, { date: target, start: '13:00', end: '17:00', note: '' });
    const row = await env.DB.prepare('SELECT id FROM requests WHERE member_id = ?').bind(id).first<{ id: number }>();

    const res = await app.request(`/m/${token}/requests/${row!.id}/cancel`, { method: 'POST' }, env);
    expect(res.headers.get('location')).toContain('ok=cancelled');

    const after = await env.DB.prepare('SELECT status FROM requests WHERE id = ?').bind(row!.id).first();
    expect(after!.status).toBe('cancelled');
    const log = await env.DB.prepare('SELECT type FROM email_log WHERE request_id = ? ORDER BY id DESC LIMIT 1').bind(row!.id).first();
    expect(log!.type).toBe('cancelled');
  });

  it('他人のリクエストはキャンセルできない', async () => {
    const a = await createMember('会員AA');
    const b = await createMember('会員BB');
    await postRequest(a.token, { date: target, start: '17:00', end: '19:00', note: '' });
    const row = await env.DB.prepare('SELECT id FROM requests WHERE member_id = ?').bind(a.id).first<{ id: number }>();

    const res = await app.request(`/m/${b.token}/requests/${row!.id}/cancel`, { method: 'POST' }, env);
    expect(res.headers.get('location')).toContain('error=invalid');
    const after = await env.DB.prepare('SELECT status FROM requests WHERE id = ?').bind(row!.id).first();
    expect(after!.status).toBe('pending');
  });

  it('無効トークンでのPOSTは404', async () => {
    const res = await postRequest('f'.repeat(40), { date: target, start: '10:00', end: '13:00', note: '' });
    expect(res.status).toBe(404);
  });

  it('カレンダーに自分の予約マークが表示され、同日は確定が優先される', async () => {
    const { id, token } = await createMember('マーク会員');
    const now = '2026-07-25T00:00:00.000Z';
    await env.DB.prepare(
      `INSERT INTO requests (member_id, date, start_time, end_time, status, member_note, admin_note, created_at, updated_at)
       VALUES (?, ?, '10:00', '11:00', 'pending', '', '', ?, ?), (?, ?, '13:00', '14:00', 'confirmed', '', '', ?, ?)`
    ).bind(id, target, now, now, id, target, now, now).run();

    const res = await app.request(`/m/${token}?month=${monthOf(target)}`, {}, env);
    const html = await res.text();
    const count = (needle: string) => html.split(needle).length - 1;
    expect(count('dot-confirmed')).toBe(2); // 凡例1 + 同日セルは確定優先で1
    expect(count('dot-pending')).toBe(1);   // 凡例のみ（同日セルには出ない）
    expect(count('dot-declined')).toBe(1);  // 凡例のみ
  });

  it('否認済みの行は非表示にでき、一覧・マークから消えるが管理画面には残る', async () => {
    const { id, token } = await createMember('整理会員');
    await postRequest(token, { date: target, start: '10:00', end: '13:00', note: '' });
    const row = await env.DB.prepare('SELECT id FROM requests WHERE member_id = ?').bind(id).first<{ id: number }>();
    await env.DB.prepare(`UPDATE requests SET status = 'declined', admin_note = '満席' WHERE id = ?`).bind(row!.id).run();

    const before = await app.request(`/m/${token}?month=${monthOf(target)}`, {}, env);
    const beforeHtml = await before.text();
    expect(beforeHtml).toContain(`/m/${token}/requests/${row!.id}/hide`); // 非表示ボタンが出る
    expect(beforeHtml.split('dot-declined').length - 1).toBe(2); // 凡例1 + セル1

    const res = await app.request(`/m/${token}/requests/${row!.id}/hide`, { method: 'POST' }, env);
    expect(res.headers.get('location')).toContain('ok=hidden');

    const after = await app.request(`/m/${token}?month=${monthOf(target)}`, {}, env);
    const afterHtml = await after.text();
    expect(afterHtml).toContain('まだリクエストはありません'); // 一覧から消えた
    expect(afterHtml.split('dot-declined').length - 1).toBe(1); // マークも消えた（凡例のみ）

    const db = await env.DB.prepare('SELECT hidden_by_member FROM requests WHERE id = ?').bind(row!.id).first<{ hidden_by_member: number }>();
    expect(db!.hidden_by_member).toBe(1);

    // 管理画面の一覧には残る（記録保全）
    const cookie = await adminCookie();
    const adminList = await app.request('/admin/requests/all', { headers: { cookie } }, env);
    expect(await adminList.text()).toContain('整理会員');
  });

  it('申請中の行は非表示にできず、他人のリクエストも非表示にできない', async () => {
    const a = await createMember('非表示不可会員');
    const b = await createMember('第三者会員');
    await postRequest(a.token, { date: target, start: '17:00', end: '19:00', note: '' });
    const row = await env.DB.prepare('SELECT id FROM requests WHERE member_id = ?').bind(a.id).first<{ id: number }>();

    // 申請中は非表示にできない
    const pending = await app.request(`/m/${a.token}/requests/${row!.id}/hide`, { method: 'POST' }, env);
    expect(pending.headers.get('location')).toContain('error=invalid');

    // 否認後でも他人は非表示にできない
    await env.DB.prepare(`UPDATE requests SET status = 'declined' WHERE id = ?`).bind(row!.id).run();
    const other = await app.request(`/m/${b.token}/requests/${row!.id}/hide`, { method: 'POST' }, env);
    expect(other.headers.get('location')).toContain('error=invalid');

    const db = await env.DB.prepare('SELECT hidden_by_member FROM requests WHERE id = ?').bind(row!.id).first<{ hidden_by_member: number }>();
    expect(db!.hidden_by_member).toBe(0);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（`dot-confirmed` 等がHTMLに無い／`/hide` ルートが404で location ヘッダが null／一覧から消えない）

- [ ] **Step 3: 実装する**

`src/routes/style-css.ts`（全文差し替え・末尾にドットと凡例のスタイルを追加）:

```ts
// ステップ②: カレンダー・状態バッジ・会員ページ用のスタイルを追加
// ステップ⑤: 予約マーク（ドット）と凡例のスタイルを追加
export const STYLE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif; color: #1a2233; background: #f4f4ef; }
a { color: #1a3a6b; }
.site-header { background: #1a2a4a; color: #fff; }
.site-header .inner { max-width: 960px; margin: 0 auto; padding: 10px 16px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.brand, .brand-lg { font-weight: 700; text-decoration: none; color: inherit; }
.brand small, .brand-lg small { display: block; font-size: 10px; letter-spacing: .15em; opacity: .7; font-weight: 400; }
.brand-lg { font-size: 22px; }
.nav { display: flex; gap: 4px; flex: 1; flex-wrap: wrap; }
.nav a { color: #dfe6f2; text-decoration: none; padding: 6px 10px; border-radius: 6px; font-size: 14px; }
.nav a.is-active, .nav a:hover { background: rgba(255,255,255,.14); color: #fff; }
.page { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
.page-head { margin-bottom: 20px; }
.page-head .eyebrow { font-size: 11px; letter-spacing: .18em; color: #7a8299; text-transform: uppercase; }
.page-head h1 { margin: 2px 0 0; font-size: 24px; }
.page-head .sub { font-size: 13px; }
h2 { font-size: 18px; margin: 32px 0 12px; }
.card { background: #fff; border: 1px solid #dcdcd2; border-radius: 10px; }
.card-pad { padding: 20px; }
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.field label { font-size: 13px; color: #565f75; }
.field input, .field select, .field textarea { padding: 8px 10px; border: 1px solid #c6c6bb; border-radius: 6px; font-size: 15px; background: #fff; }
.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; align-items: end; }
.check { font-size: 14px; }
.btn { display: inline-block; padding: 7px 14px; border: 1px solid #1a2a4a; border-radius: 6px; background: #fff; color: #1a2a4a; font-size: 14px; cursor: pointer; text-decoration: none; }
.btn-primary { background: #1a2a4a; color: #fff; }
.btn-danger { border-color: #8f1f1f; color: #8f1f1f; }
.btn-sm { padding: 4px 10px; font-size: 13px; }
.btn-lg { padding: 10px 18px; font-size: 16px; }
.btn-block { width: 100%; }
.btn-onnavy { border-color: rgba(255,255,255,.5); background: transparent; color: #fff; }
.tbl-wrap { overflow-x: auto; }
.tbl { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #dcdcd2; border-radius: 10px; overflow: hidden; }
.tbl th, .tbl td { padding: 10px 12px; border-bottom: 1px solid #ecece4; text-align: left; font-size: 14px; vertical-align: middle; }
.tbl th { background: #f8f8f3; font-size: 12px; color: #565f75; }
.row-muted { opacity: .5; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 12px; background: #e8e8df; }
.badge-monthly { background: #dbe7fb; color: #1a3a6b; }
.badge-ticket { background: #fdeacc; color: #7a4b12; }
.badge-on { background: #dcf2e0; color: #1c6b34; }
.badge-off { background: #fbdddd; color: #8f1f1f; }
.badge-pending { background: #fdeacc; color: #7a4b12; }
.badge-confirmed { background: #dcf2e0; color: #1c6b34; }
.badge-declined { background: #fbdddd; color: #8f1f1f; }
.badge-cancelled { background: #e8e8df; color: #565f75; }
.badge-warn { background: #f6d9a8; color: #8a4b12; }
.copy-link input { width: 100%; min-width: 260px; font-size: 12px; padding: 4px 6px; border: 1px solid #c6c6bb; border-radius: 4px; color: #565f75; }
.msg-ok { background: #dcf2e0; color: #1c6b34; padding: 10px 14px; border-radius: 8px; }
.msg-error { background: #fbdddd; color: #8f1f1f; padding: 10px 14px; border-radius: 8px; }
.muted { color: #7a8299; }
.small { font-size: 13px; }
.actions form { display: inline; }
.login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
.login-card { width: 100%; max-width: 360px; background: #fff; border: 1px solid #dcdcd2; border-radius: 12px; padding: 32px 28px; text-align: center; }
.member-wrap { max-width: 640px; margin: 0 auto; padding: 24px 16px 64px; }
.cal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.cal-head h2 { margin: 0; }
.cal { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #dcdcd2; border-radius: 10px; overflow: hidden; }
.cal th { padding: 6px 0; font-size: 12px; color: #565f75; background: #f8f8f3; text-align: center; }
.cal th.sun, .cal td.sun .day-num { color: #b0453a; }
.cal th.sat, .cal td.sat .day-num { color: #1a5f9e; }
.cal td { border: 1px solid #ecece4; height: 52px; width: 14.28%; vertical-align: top; padding: 0; text-align: center; }
.cal td a, .cal td .day-off { display: block; height: 100%; padding: 6px 4px; text-decoration: none; color: inherit; font-size: 13px; }
.cal td a:hover { background: #eef2fa; }
.cal td.selected a { background: #1a2a4a; color: #fff; }
.cal td .day-off { color: #b8b8ad; }
.cal td .mark { display: block; font-size: 10px; margin-top: 2px; }
.slot-list { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
.slot-row { display: flex; align-items: center; gap: 10px; font-size: 15px; }
.req-when { font-weight: 700; }
.cal-dot { width: 6px; height: 6px; border-radius: 50%; }
.cal td .cal-dot { display: block; margin: 3px auto 0; }
.cal-legend { display: flex; gap: 16px; align-items: center; margin: 8px 0 0; color: #565f75; }
.legend-item { display: inline-flex; align-items: center; gap: 5px; }
.legend-item .cal-dot { display: inline-block; }
.dot-pending { background: #d97b1f; }
.dot-confirmed { background: #1c6b34; }
.dot-declined { background: #b0453a; }
`;
```

`src/routes/member.tsx`（全文差し替え。Task 2 の版との差分: `hideRequestByMember` import・`ok=hidden` メッセージ・マーク用クエリと `markByDate`・一覧/マークの `hidden_by_member = 0` 絞り込み・セルのドット・凡例・非表示ボタン・`/hide` ルート）:

```tsx
import { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import type { Bindings, MemberRow, RequestRow, RequestStatus } from '../types';
import { TYPE_LABELS, TYPE_BADGE_CLASSES } from './admin/ui';
import {
  WEEKDAY_LABELS, currentJstDate, addDays, monthOf, addMonths, buildMonthGrid,
  formatMD, isValidDate, isValidMonth, weekdayOf, formatStampJst
} from '../core/dates';
import { getSettings, timeOptions, validTimeRange } from '../core/settings';
import { getCachedStarts, getCacheStatus } from '../core/square';
import { createRequest, cancelRequestByMember, hideRequestByMember } from '../core/requests';
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
  cancelled: 'キャンセルしました',
  hidden: '一覧から非表示にしました'
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid: '入力内容に誤りがあります。日付と時間（30分単位・終了は開始より後）をご確認ください',
  closed: 'この日は受付を停止しています',
  duplicate: 'この日時にはすでにリクエスト済みです',
  unavailable: 'この日はSquare側の空きがないため、現在ご案内できません'
};

const NOTE_MAX = 500;

// 同日に複数の状態があるときのドットの優先度（確定 > 申請中 > 否認）
const MARK_PRIORITY: Record<string, number> = { confirmed: 3, pending: 2, declined: 1 };

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
  const [closedResult, requestsResult, marksResult, selectedClosedRow] = await Promise.all([
    c.env.DB.prepare('SELECT date FROM closed_dates WHERE date >= ? AND date <= ?')
      .bind(monthStart, monthEnd).all<{ date: string }>(),
    // 一覧は会員が非表示にした行を出さない（§17.4。管理画面には残る）
    c.env.DB.prepare('SELECT * FROM requests WHERE member_id = ? AND hidden_by_member = 0 ORDER BY date DESC, start_time DESC, id DESC LIMIT 50')
      .bind(m.id).all<RequestRow>(),
    // カレンダーのマーク用: 表示月内の申請中/確定/否認（非表示行は出さない・キャンセル済みは出さない）
    c.env.DB.prepare(
      `SELECT date, status FROM requests
       WHERE member_id = ? AND date >= ? AND date <= ?
         AND status IN ('pending', 'confirmed', 'declined') AND hidden_by_member = 0`
    ).bind(m.id, monthStart, monthEnd).all<{ date: string; status: RequestStatus }>(),
    // 選択日の停止判定は表示中の月に依存させない（?month=別月&date=停止日 の組み合わせ対策）
    selectedDate !== null
      ? c.env.DB.prepare('SELECT date FROM closed_dates WHERE date = ?').bind(selectedDate).first<{ date: string }>()
      : Promise.resolve(null)
  ]);
  const closedSet = new Set(closedResult.results.map((r) => r.date));
  const myRequests = requestsResult.results;

  // 日付ごとに優先度最上位の状態を1つだけ選ぶ（§17.2: 1日1点）
  const markByDate = new Map<string, RequestStatus>();
  for (const r of marksResult.results) {
    const cur = markByDate.get(r.date);
    if (!cur || MARK_PRIORITY[r.status] > MARK_PRIORITY[cur]) markByDate.set(r.date, r.status);
  }

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

  // ステップ⑤(§17.1): 時間枠テンプレートを廃止し、受付時間帯の30分刻みから開始/終了を自由に選ぶ
  const { starts: startOptions, ends: endOptions } = timeOptions(settings.openStart, settings.openEnd);

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
                const mark = markByDate.get(d);
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
                        {mark && <span class={`cal-dot dot-${mark}`}></span>}
                      </span>
                    </td>
                  );
                }
                return (
                  <td class={`${d === selectedDate ? 'selected' : ''}${dowClass}`.trim() || undefined}>
                    <a href={`/m/${token}?date=${d}`}>
                      <span class="day-num">{dayNum}</span>
                      {mark && <span class={`cal-dot dot-${mark}`}></span>}
                    </a>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p class="cal-legend small">
        <span class="legend-item">
          <span class="cal-dot dot-pending"></span>申請中
        </span>
        <span class="legend-item">
          <span class="cal-dot dot-confirmed"></span>確定
        </span>
        <span class="legend-item">
          <span class="cal-dot dot-declined"></span>否認
        </span>
      </p>
      <p class="muted small">日付を選ぶと開始・終了時刻を選べます（{formatMD(today)}〜{formatMD(maxDate)} 受付）</p>
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
          ) : syncEnabled && selectedCacheStarts !== null && selectedCacheStarts.length === 0 ? (
            <p class="muted">この日はSquare側で空きがありません。別の日をお選びください。</p>
          ) : (
            <form class="card card-pad" method="post" action={`/m/${token}/requests`}>
              <input type="hidden" name="date" value={selectedDate} />
              <div class="field">
                <label>開始時刻</label>
                <select name="start">
                  {startOptions.map((t) => (
                    <option value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div class="field">
                <label>終了時刻</label>
                <select name="end">
                  {endOptions.map((t) => (
                    <option value={t}>{t}</option>
                  ))}
                </select>
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
                      {(r.status === 'declined' || r.status === 'cancelled') && (
                        <form method="post" action={`/m/${token}/requests/${r.id}/hide`}>
                          <button class="btn btn-sm" type="submit">
                            非表示
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
  const end = typeof form.end === 'string' ? form.end : '';
  const note = typeof form.note === 'string' ? form.note.trim() : '';

  const settings = await getSettings(c.env.DB);
  const today = currentJstDate();
  const maxDate = addDays(today, settings.windowDays);

  // 30分刻み・受付時間帯内・開始<終了は validTimeRange で一括検証（§17.1）
  if (
    !isValidDate(date) || date < today || date > maxDate ||
    !validTimeRange(start, end, settings.openStart, settings.openEnd) ||
    note.length > NOTE_MAX
  ) {
    return c.redirect(`/m/${token}?date=${isValidDate(date) ? date : ''}&error=invalid`);
  }

  const closed = await c.env.DB.prepare('SELECT date FROM closed_dates WHERE date = ?').bind(date).first();
  if (closed) return c.redirect(`/m/${token}?error=closed`);

  // 同期有効時は日単位で判定: その日の空き開始時刻が1つも無ければ受け付けない（未取得日も同様）。
  // 枠単位の照合は廃止（席に余裕がある運用・最終判断はスタッフの承認で行う）
  if (settings.syncEnabled) {
    const starts = await getCachedStarts(c.env.DB, date, date);
    const available = starts.get(date);
    if (available === undefined || available.length === 0) {
      return c.redirect(`/m/${token}?date=${date}&error=unavailable`);
    }
  }

  const result = await createRequest(c.env.DB, {
    memberId: m.id,
    date,
    startTime: start,
    endTime: end,
    memberNote: note
  });
  if (!result.ok) return c.redirect(`/m/${token}?date=${date}&error=duplicate`);

  // スタッフ宛の新規リクエスト通知に加え、会員本人へ受付確認を送る（§17.3。どちらも絶対に例外を投げない）
  const origin = new URL(c.req.url).origin;
  await sendRequestNotification(c.env.DB, c.env, result.id, 'requested', origin);
  await sendRequestNotification(c.env.DB, c.env, result.id, 'requested_member', origin);
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

// ステップ⑤(§17.4): 終了状態（否認/キャンセル済み）の自分の行を一覧から非表示にする。メールは送らない。
member.post('/:token/requests/:id/hide', async (c) => {
  const token = c.req.param('token');
  const m = await resolveMember(c.env.DB, token);
  if (!m) return c.html(<InvalidTokenPage />, 404);

  const idRaw = c.req.param('id');
  const id = /^\d{1,9}$/.test(idRaw) ? Number(idRaw) : null;
  const ok = id !== null && (await hideRequestByMember(c.env.DB, id, m.id));
  return c.redirect(`/m/${token}?${ok ? 'ok=hidden' : 'error=invalid'}`);
});
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（累計 **132件**。member-requests 11件）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/routes/member.tsx src/routes/style-css.ts test/member-requests.test.ts
git commit -m "feat: 会員カレンダーに予約マーク（申請中/確定/否認）と一覧の非表示ボタンを追加"
```

---

### Task 4: 承認画面のSquare埋まり警告をレンジ重なり近似に変更

**Files:**
- Modify: `src/routes/admin/requests.tsx`（全文差し替え: `mayBeTaken` の判定を「開始時刻一致」から「レンジ重なり」へ）
- Test: `test/admin-requests-square.test.ts`（全文差し替え: 既存3件を30分レンジ前提に修正し、1件追記して4件）

**Interfaces:**
- Consumes: `getCachedStarts`（変更なし）、`getSettings().syncEnabled`（変更なし）
- Produces: `mayBeTaken(r)` の新定義 — その日のキャッシュ行があり、かつ空き開始時刻 `t` のうち `r.start_time <= t < r.end_time` を満たすものが1つも無いとき true（警告表示）。未取得日（行なし）は従来どおり警告しない。ルート・URL・他の画面要素は一切変えない

- [ ] **Step 1: 失敗するテストを書く**

`test/admin-requests-square.test.ts`（全文差し替え・4件）:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { adminCookie } from './helpers';
import { setSetting } from '../src/core/settings';
import { currentJstDate, addDays } from '../src/core/dates';

async function seedPending(name: string, date: string, start = '10:00', end = '13:00'): Promise<number> {
  const token = crypto.randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
  const m = await env.DB.prepare(
    `INSERT INTO members (name, email, member_type, token, is_active, created_at) VALUES (?, ?, 'monthly', ?, 1, '2026-07-23T00:00:00.000Z')`
  ).bind(name, `${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`, token).run();
  const r = await env.DB.prepare(
    `INSERT INTO requests (member_id, date, start_time, end_time, status, member_note, admin_note, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', '', '', '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z')`
  ).bind(m.meta.last_row_id, date, start, end).run();
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
  it('同期有効: リクエストの時間帯に重なる空きが無ければ警告バッジを表示', async () => {
    const cookie = await adminCookie();
    await seedPending('埋まり会員', day, '10:00', '13:00');
    await enableSync();
    // 13:00 は終了時刻ちょうど（start<=t<end を満たさない）、09:30 は開始前 → どちらも重ならない
    await seedCache(day, ['09:30', '13:00']);
    const res = await app.request('/admin/requests', { headers: { cookie } }, env);
    expect(await res.text()).toContain(WARN);
  });

  it('同期有効: 時間帯に重なる空きがあれば警告は出ない', async () => {
    const cookie = await adminCookie();
    await seedPending('空きあり会員', day, '10:00', '13:00');
    await enableSync();
    await seedCache(day, ['10:00']); // 開始時刻ちょうどは重なり扱い
    const res = await app.request('/admin/requests', { headers: { cookie } }, env);
    expect(await res.text()).not.toContain(WARN);
  });

  it('同期無効: キャッシュの状態に関わらず警告は一切出ない', async () => {
    const cookie = await adminCookie();
    await seedPending('無効会員', day, '10:00', '13:00');
    // enableSync しない（同期無効）
    await seedCache(day, ['13:00']); // 重なりゼロ相当だが同期無効なので無視される
    const res = await app.request('/admin/requests', { headers: { cookie } }, env);
    expect(await res.text()).not.toContain(WARN);
  });

  it('30分単位の自由な時間帯でもレンジ重なりで判定される', async () => {
    const cookie = await adminCookie();
    await seedPending('境界会員', day, '10:30', '15:00');
    await enableSync();

    // 09:00 は開始前・15:00 は終了ちょうど → 重ならないので警告
    await seedCache(day, ['09:00', '15:00']);
    const warned = await app.request('/admin/requests', { headers: { cookie } }, env);
    expect(await warned.text()).toContain(WARN);

    // 14:30 は 10:30<=14:30<15:00 で重なる → 警告なし
    await seedCache(day, ['14:30']);
    const clear = await app.request('/admin/requests', { headers: { cookie } }, env);
    expect(await clear.text()).not.toContain(WARN);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（テスト1: 旧ロジックは `starts.includes('10:00')` の開始時刻一致判定ではないため…ではなく、旧ロジックでは `['09:30','13:00']` に `10:00` が無いので警告は出る＝テスト1は通るが、**テスト4の後半**（`['14:30']` で警告なし）が旧ロジックでは `10:30` が含まれず警告が出てしまい FAIL する）

- [ ] **Step 3: 実装する**

`src/routes/admin/requests.tsx`（全文差し替え・変更点は `mayBeTaken` とそのコメントのみ）:

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

  // 同期有効時のみ: 承認待ちの時間帯がSquareキャッシュの空きと重ならなければ「埋まった可能性」を警告する。
  // ステップ⑤(§17.1)でレンジ重なり近似に変更: 空き開始時刻 t のうち start<=t<end に入るものが1つも無ければ警告。
  // 日付がキャッシュ済み（行あり）であることが前提。未取得日（行なし）は判断材料が無いので警告しない（将来日への誤警告を避ける）。
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
    return starts !== undefined && !starts.some((t) => t >= r.start_time && t < r.end_time);
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

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（累計 **133件**。admin-requests-square 4件）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/routes/admin/requests.tsx test/admin-requests-square.test.ts
git commit -m "feat: 承認画面のSquare埋まり警告をレンジ重なり近似に変更"
```

---

### Task 5: Square一覧ヘルパー（fetchLocations / fetchBookableServices）

**Files:**
- Modify: `src/core/square.ts`（全文差し替え: 既存の同期関数はそのまま、末尾に一覧ヘルパー2関数と型を追加）
- Test: `test/square-helpers.test.ts`（新規・5件）

**Interfaces:**
- Consumes: `SquareEnv`（`SQUARE_ACCESS_TOKEN` / `SQUARE_API_BASE`・既存のまま）
- Produces:
  - `SquareOption { id: string; name: string }`
  - `SquareListResult = { ok: true; items: SquareOption[] } | { ok: false; error: string }`
  - `fetchLocations(env, fetcher?)`: GET `/v2/locations` → `locations[]` の `id`/`name` を返す。`name` 欠落は `id` で代用
  - `fetchBookableServices(env, fetcher?)`: POST `/v2/catalog/search-catalog-items`（body `{ product_types: ['APPOINTMENTS_SERVICE'] }`）→ 各アイテムのバリエーションを平坦化し `id` = variation id、`name` = `アイテム名（バリエーション名）`（同名なら括弧なし）で返す
  - どちらも**絶対に例外を投げない**: トークン未設定は `{ ok: false, error: 'no_token' }`（fetcher 未呼び出し）、HTTP失敗は `{ ok: false, error: 'HTTP xxx' }`、例外はメッセージ文字列。不正要素は該当要素だけ無視。Task 6 の設定画面が使う

- [ ] **Step 1: 失敗するテストを書く**

`test/square-helpers.test.ts`（新規・5件）:

```ts
import { describe, it, expect } from 'vitest';
import { fetchLocations, fetchBookableServices } from '../src/core/square';

const ENV = { SQUARE_ACCESS_TOKEN: 'tok' };

// 固定のJSONを返すモック fetcher。呼び出し記録も返す。
function jsonFetcher(payload: unknown, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;
  return { fetcher, calls };
}

describe('square list helpers', () => {
  it('fetchLocations は locations のIDと名前を返す（URL・ヘッダも正しい）', async () => {
    const { fetcher, calls } = jsonFetcher({
      locations: [
        { id: 'L1', name: 'TORCH日光' },
        { id: 'L2' } // name欠落はIDで代用
      ]
    });
    const result = await fetchLocations(ENV, fetcher);
    expect(result).toEqual({ ok: true, items: [{ id: 'L1', name: 'TORCH日光' }, { id: 'L2', name: 'L2' }] });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://connect.squareup.com/v2/locations');
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['square-version']).toBe('2024-08-21');
  });

  it('fetchLocations はトークン未設定なら fetcher を呼ばず、HTTP失敗・例外も ok:false', async () => {
    let called = false;
    const spy = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
    expect(await fetchLocations({}, spy)).toEqual({ ok: false, error: 'no_token' });
    expect(called).toBe(false);

    const fail = (async () => new Response('denied', { status: 401 })) as typeof fetch;
    expect(await fetchLocations(ENV, fail)).toEqual({ ok: false, error: 'HTTP 401' });

    const boom = (async () => { throw new Error('network down'); }) as typeof fetch;
    expect(await fetchLocations(ENV, boom)).toEqual({ ok: false, error: 'network down' });
  });

  it('fetchLocations は想定外の形状でも不正要素だけ無視して継続する', async () => {
    const { fetcher } = jsonFetcher({ locations: [{ id: 'L1', name: 'OK' }, { name: 'idなし' }, 'ただの文字列', { id: 42 }] });
    expect(await fetchLocations(ENV, fetcher)).toEqual({ ok: true, items: [{ id: 'L1', name: 'OK' }] });

    const { fetcher: noList } = jsonFetcher({ nonsense: true });
    expect(await fetchLocations(ENV, noList)).toEqual({ ok: true, items: [] }); // locations欠落は空一覧
  });

  it('fetchBookableServices は予約サービスのバリエーションを平坦化して返す', async () => {
    const { fetcher, calls } = jsonFetcher({
      items: [
        {
          item_data: {
            name: 'コワーキング利用',
            variations: [
              { id: 'V1', item_variation_data: { name: 'ドロップイン' } },
              { id: 'V2', item_variation_data: { name: '半日' } }
            ]
          }
        },
        { item_data: { name: '単一サービス', variations: [{ id: 'V3', item_variation_data: { name: '単一サービス' } }] } }
      ]
    });
    const result = await fetchBookableServices(ENV, fetcher);
    expect(result).toEqual({
      ok: true,
      items: [
        { id: 'V1', name: 'コワーキング利用（ドロップイン）' },
        { id: 'V2', name: 'コワーキング利用（半日）' },
        { id: 'V3', name: '単一サービス' } // アイテム名とバリエーション名が同じなら括弧は付けない
      ]
    });
    expect(calls[0].url).toBe('https://connect.squareup.com/v2/catalog/search-catalog-items');
    expect(calls[0].init!.method).toBe('POST');
    const body = JSON.parse(String(calls[0].init!.body));
    expect(body.product_types).toEqual(['APPOINTMENTS_SERVICE']);
  });

  it('fetchBookableServices は失敗・不正形状でも例外を投げない', async () => {
    expect(await fetchBookableServices({}, (async () => new Response('{}')) as typeof fetch)).toEqual({ ok: false, error: 'no_token' });

    const fail = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    expect(await fetchBookableServices(ENV, fail)).toEqual({ ok: false, error: 'HTTP 500' });

    const { fetcher } = jsonFetcher({
      items: [
        { item_data: { name: 'X', variations: [{ item_variation_data: {} }, { id: 'V9', item_variation_data: { name: 7 } }] } },
        { no_item_data: true }
      ]
    });
    // id の無いバリエーション・name不正・item_data欠落は無視し、拾えるものだけ返す
    expect(await fetchBookableServices(ENV, fetcher)).toEqual({ ok: true, items: [{ id: 'V9', name: 'X' }] });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（`fetchLocations` / `fetchBookableServices` が `../src/core/square` にエクスポートされていない）

- [ ] **Step 3: 実装する**

`src/core/square.ts`（全文差し替え・既存関数は変更なし、末尾にヘルパーを追加）:

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

// --- ステップ⑤(§17.5): 設定画面用の一覧ヘルパー。絶対に例外を投げない・実APIはテストで叩かず fetcher を注入する ---

export interface SquareOption {
  id: string;
  name: string;
}

export type SquareListResult = { ok: true; items: SquareOption[] } | { ok: false; error: string };

// Square Locations API からロケーション一覧を取得する。name 欠落は id で代用。
// 想定外の形状は該当要素だけ無視して継続する（実APIとの形状差は結合確認で吸収）。
export async function fetchLocations(env: SquareEnv, fetcher: typeof fetch = fetch): Promise<SquareListResult> {
  try {
    if (!env.SQUARE_ACCESS_TOKEN) return { ok: false, error: 'no_token' };
    const base = (env.SQUARE_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    const res = await fetcher(`${base}/v2/locations`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'square-version': '2024-08-21'
      }
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const json = (await res.json()) as { locations?: unknown };
    const items: SquareOption[] = [];
    if (Array.isArray(json.locations)) {
      for (const l of json.locations) {
        const id = (l as { id?: unknown })?.id;
        const name = (l as { name?: unknown })?.name;
        if (typeof id === 'string' && id !== '') {
          items.push({ id, name: typeof name === 'string' && name !== '' ? name : id });
        }
      }
    }
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Square Catalog API から予約可能サービス（APPOINTMENTS_SERVICE）のバリエーション一覧を取得する。
// id はバリエーションID（= service_variation_id として設定に保存する値）、name は「アイテム名（バリエーション名）」。
export async function fetchBookableServices(env: SquareEnv, fetcher: typeof fetch = fetch): Promise<SquareListResult> {
  try {
    if (!env.SQUARE_ACCESS_TOKEN) return { ok: false, error: 'no_token' };
    const base = (env.SQUARE_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    const res = await fetcher(`${base}/v2/catalog/search-catalog-items`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'content-type': 'application/json',
        'square-version': '2024-08-21'
      },
      body: JSON.stringify({ product_types: ['APPOINTMENTS_SERVICE'] })
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const json = (await res.json()) as { items?: unknown };
    const items: SquareOption[] = [];
    if (Array.isArray(json.items)) {
      for (const item of json.items) {
        const itemData = (item as { item_data?: unknown })?.item_data as
          | { name?: unknown; variations?: unknown }
          | undefined;
        const rawItemName = itemData?.name;
        const itemName = typeof rawItemName === 'string' ? rawItemName : '';
        const rawVariations = itemData?.variations;
        const variations = Array.isArray(rawVariations) ? rawVariations : [];
        for (const v of variations) {
          const vid = (v as { id?: unknown })?.id;
          if (typeof vid !== 'string' || vid === '') continue;
          const vData = (v as { item_variation_data?: unknown })?.item_variation_data as
            | { name?: unknown }
            | undefined;
          const rawVName = vData?.name;
          const vName = typeof rawVName === 'string' ? rawVName : '';
          const name =
            itemName !== '' && vName !== '' && vName !== itemName
              ? `${itemName}（${vName}）`
              : itemName !== ''
                ? itemName
                : vName !== ''
                  ? vName
                  : vid;
          items.push({ id: vid, name });
        }
      }
    }
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（累計 **138件**。square-helpers 5件。既存の square.test.ts 8件は無変更で通ること）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/core/square.ts test/square-helpers.test.ts
git commit -m "feat: Square一覧ヘルパー(fetchLocations/fetchBookableServices)を追加"
```

---

### Task 6: 設定画面の刷新（受付時間帯・Squareプルダウン）と slots テンプレートの廃止

**Files:**
- Modify: `src/core/settings.ts`（全文差し替え: `slots`・`DEFAULT_SLOTS`・`parseSlotsText`・`slotsToText`・`findSlot`・`TIME_RE` を削除。`SettingKey` から `'slots'` を除去）
- Modify: `src/routes/admin/settings.tsx`（全文差し替え: 時間枠テンプレート欄→受付時間帯プルダウン・Square一覧ヘルパー `?square=1`）
- Modify: `README.md`（全文差し替え: ステップ⑤の機能を反映）
- Test: `test/admin-closed-settings.test.ts`（全文差し替え・6件のまま）
- Test: `test/admin-settings-square.test.ts`（全文差し替え・4件のまま）

**Interfaces:**
- Consumes: Task 1 の `isHalfStep` / `halfStepRange`、Task 5 の `fetchLocations` / `fetchBookableServices` / `SquareListResult`
- Produces:
  - `AppSettings` から `slots` が消える（`openStart`/`openEnd`/`windowDays`/`staffEmail`/`squareLocationId`/`squareServiceVariationId`/`syncEnabled` のみ）
  - 設定POSTのフィールドは `staff_email` / `window_days` / `open_start` / `open_end` / `square_location_id` / `square_service_variation_id`（`slots_text` は廃止）
  - GET `/admin/settings?square=1` で Square から一覧を取得しプルダウン表示。失敗時は日本語エラー＋従来の手入力欄
  - 0001シードの `settings.slots` 行はDBに残置（どこからも読まれない・`test/schema2.test.ts` は無変更で通る）

- [ ] **Step 1: 失敗するテストを書く**

`test/admin-closed-settings.test.ts`（全文差し替え・6件）:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { adminCookie } from './helpers';
import { getSettings } from '../src/core/settings';

describe('admin closed dates', () => {
  it('停止日を追加・上書き・削除できる', async () => {
    const cookie = await adminCookie();

    const add = await app.request('/admin/closed', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ date: '2026-09-20', reason: '臨時休業' }).toString()
    }, env);
    expect(add.headers.get('location')).toBe('/admin/closed?ok=saved');

    // 同じ日をもう一度保存すると理由が上書きされる
    await app.request('/admin/closed', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ date: '2026-09-20', reason: '設備点検' }).toString()
    }, env);
    const row = await env.DB.prepare(`SELECT reason FROM closed_dates WHERE date = '2026-09-20'`).first();
    expect(row!.reason).toBe('設備点検');

    const page = await app.request('/admin/closed', { headers: { cookie } }, env);
    expect(await page.text()).toContain('設備点検');

    const del = await app.request('/admin/closed/2026-09-20/delete', { method: 'POST', headers: { cookie } }, env);
    expect(del.headers.get('location')).toBe('/admin/closed?ok=deleted');
    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM closed_dates WHERE date = '2026-09-20'`).first<{ n: number }>();
    expect(after!.n).toBe(0);
  });

  it('不正な日付は invalid', async () => {
    const cookie = await adminCookie();
    const res = await app.request('/admin/closed', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ date: '2026/09/20', reason: '' }).toString()
    }, env);
    expect(res.headers.get('location')).toBe('/admin/closed?error=invalid');
  });
});

describe('admin settings', () => {
  it('設定画面に受付時間帯と現在値が表示される（時間枠テンプレートは廃止）', async () => {
    const cookie = await adminCookie();
    const res = await app.request('/admin/settings', { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('受付時間帯');
    expect(html).toContain('60');
    expect(html).not.toContain('時間枠テンプレート');
  });

  it('設定を保存できる（受付時間帯は30分単位）', async () => {
    const cookie = await adminCookie();
    const res = await app.request('/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({
        staff_email: 'staff@example.com',
        window_days: '30',
        open_start: '09:00',
        open_end: '18:30'
      }).toString()
    }, env);
    expect(res.headers.get('location')).toBe('/admin/settings?ok=saved');

    const s = await getSettings(env.DB);
    expect(s.staffEmail).toBe('staff@example.com');
    expect(s.windowDays).toBe(30);
    expect(s.openStart).toBe('09:00');
    expect(s.openEnd).toBe('18:30');
  });

  it('スタッフメールは空でも保存できる（通知スキップ運用）', async () => {
    const cookie = await adminCookie();
    const res = await app.request('/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ staff_email: '', window_days: '60', open_start: '10:00', open_end: '21:00' }).toString()
    }, env);
    expect(res.headers.get('location')).toBe('/admin/settings?ok=saved');
  });

  it('不正な受付時間帯・期間・メール形式は invalid で保存されない', async () => {
    const cookie = await adminCookie();
    const before = await getSettings(env.DB);

    const badStep = await app.request('/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ staff_email: '', window_days: '60', open_start: '10:15', open_end: '21:00' }).toString()
    }, env);
    expect(badStep.headers.get('location')).toBe('/admin/settings?error=invalid');

    const badOrder = await app.request('/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ staff_email: '', window_days: '60', open_start: '21:00', open_end: '10:00' }).toString()
    }, env);
    expect(badOrder.headers.get('location')).toBe('/admin/settings?error=invalid');

    const badDays = await app.request('/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ staff_email: '', window_days: '0', open_start: '10:00', open_end: '21:00' }).toString()
    }, env);
    expect(badDays.headers.get('location')).toBe('/admin/settings?error=invalid');

    const badEmail = await app.request('/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ staff_email: 'not-an-email', window_days: '60', open_start: '10:00', open_end: '21:00' }).toString()
    }, env);
    expect(badEmail.headers.get('location')).toBe('/admin/settings?error=invalid');

    const after = await getSettings(env.DB);
    expect(after).toEqual(before); // 何も変わっていない
  });
});
```

`test/admin-settings-square.test.ts`（全文差し替え・4件）:

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

const BASE = { staff_email: '', window_days: '60', open_start: '10:00', open_end: '21:00' };

describe('admin settings Square', () => {
  it('Squareセクションが表示され、トークン未設定の一覧取得はエラー案内＋手入力継続', async () => {
    const cookie = await adminCookie();
    const res = await app.request('/admin/settings', { headers: { cookie } }, env);
    const html = await res.text();
    expect(html).toContain('Square連携');
    expect(html).toContain('同期無効');
    expect(html).toContain('今すぐ同期');
    expect(html).toContain('Squareから一覧を取得');

    // テスト環境に SQUARE_ACCESS_TOKEN は無い → ?square=1 は日本語エラー案内を出し、手入力欄は残る
    const helper = await app.request('/admin/settings?square=1', { headers: { cookie } }, env);
    expect(helper.status).toBe(200);
    const helperHtml = await helper.text();
    expect(helperHtml).toContain('一覧を取得できませんでした');
    expect(helperHtml).toContain('name="square_location_id"'); // 手入力欄は残る
    expect(helperHtml).toContain('name="square_service_variation_id"');
  });

  it('ロケーションIDとサービスIDを保存すると同期有効になる', async () => {
    const cookie = await adminCookie();
    const res = await post(cookie, { ...BASE, square_location_id: 'LOC123', square_service_variation_id: 'SV456' });
    expect(res.headers.get('location')).toBe('/admin/settings?ok=saved');
    const s = await getSettings(env.DB);
    expect(s.squareLocationId).toBe('LOC123');
    expect(s.squareServiceVariationId).toBe('SV456');
    expect(s.syncEnabled).toBe(true);
  });

  it('片方だけ入力しても同期無効のまま', async () => {
    const cookie = await adminCookie();
    await post(cookie, { ...BASE, square_location_id: 'LOC123', square_service_variation_id: '' });
    const s = await getSettings(env.DB);
    expect(s.syncEnabled).toBe(false);
  });

  it('「今すぐ同期」はアクセストークン未設定だと sync_failed にリダイレクトする', async () => {
    const cookie = await adminCookie();
    // 同期有効化（IDは入れるが、テスト環境に SQUARE_ACCESS_TOKEN は無い）
    await post(cookie, { ...BASE, square_location_id: 'LOC123', square_service_variation_id: 'SV456' });
    const res = await app.request('/admin/settings/sync', { method: 'POST', headers: { cookie } }, env);
    expect(res.headers.get('location')).toBe('/admin/settings?error=sync_failed');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（設定画面に「受付時間帯」欄が無い・「時間枠テンプレート」が残っている／`open_start`/`open_end` フィールドのPOSTが保存されない（旧POSTは `slots_text` 必須で invalid になる）／`?square=1` のエラー案内が無い）

- [ ] **Step 3: 実装する**

`src/core/settings.ts`（全文差し替え・slots 系を完全に削除）:

```ts
export interface AppSettings {
  openStart: string;    // 受付時間帯の開始 'HH:MM'（30分刻み）
  openEnd: string;      // 受付時間帯の終了 'HH:MM'（30分刻み）
  windowDays: number;
  staffEmail: string;
  squareLocationId: string;
  squareServiceVariationId: string;
  syncEnabled: boolean; // squareLocationId と squareServiceVariationId が両方非空なら true
}

export type SettingKey =
  | 'open_start'
  | 'open_end'
  | 'window_days'
  | 'staff_email'
  | 'square_location_id'
  | 'square_service_variation_id';

export const DEFAULT_WINDOW_DAYS = 60;
export const DEFAULT_OPEN_START = '10:00';
export const DEFAULT_OPEN_END = '21:00';

const HALF_STEP_RE = /^([01]\d|2[0-3]):(00|30)$/;

// 30分刻みの時刻か（時は00〜23・分は '00' か '30' のみ・ゼロ埋め必須）
export function isHalfStep(t: string): boolean {
  return HALF_STEP_RE.test(t);
}

function toMinutes(t: string): number {
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
}

function toHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// from..to を30分刻みで列挙（両端含む）。from/to は30分刻み・from<=to を前提とする。
export function halfStepRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = toMinutes(from); m <= toMinutes(to); m += 30) out.push(toHHMM(m));
  return out;
}

// 受付時間帯から開始・終了プルダウンの選択肢を作る。
// starts は末尾（openEnd）を除く＝開始は必ず終了より前になる。ends は先頭（openStart）を除く。
export function timeOptions(openStart: string, openEnd: string): { starts: string[]; ends: string[] } {
  const all = halfStepRange(openStart, openEnd);
  return { starts: all.slice(0, -1), ends: all.slice(1) };
}

// 会員リクエストの時間検証: 30分刻み・受付時間帯内・開始<終了。'HH:MM' はゼロ埋めなので文字列比較で順序判定できる。
export function validTimeRange(start: string, end: string, openStart: string, openEnd: string): boolean {
  return isHalfStep(start) && isHalfStep(end) && start >= openStart && end <= openEnd && start < end;
}

export async function getSettings(db: D1Database): Promise<AppSettings> {
  const rows = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const map = new Map(rows.results.map((r) => [r.key, r.value]));

  // 受付時間帯。両方が30分刻みで開始<終了のときだけ採用し、そうでなければ既定にフォールバックする。
  // 0001シードの 'slots' 行はDBに残っているが、ステップ⑤以降どこからも読まない（無害な残置）。
  let openStart = DEFAULT_OPEN_START;
  let openEnd = DEFAULT_OPEN_END;
  const rawStart = (map.get('open_start') ?? '').trim();
  const rawEnd = (map.get('open_end') ?? '').trim();
  if (isHalfStep(rawStart) && isHalfStep(rawEnd) && rawStart < rawEnd) {
    openStart = rawStart;
    openEnd = rawEnd;
  }

  const windowRaw = Number(map.get('window_days'));
  const windowDays = Number.isInteger(windowRaw) && windowRaw >= 1 && windowRaw <= 365 ? windowRaw : DEFAULT_WINDOW_DAYS;

  const squareLocationId = (map.get('square_location_id') ?? '').trim();
  const squareServiceVariationId = (map.get('square_service_variation_id') ?? '').trim();
  const syncEnabled = squareLocationId !== '' && squareServiceVariationId !== '';

  return {
    openStart,
    openEnd,
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
export async function saveSettings(db: D1Database, entries: { key: SettingKey; value: string }[]): Promise<void> {
  if (entries.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  await db.batch(entries.map((e) => stmt.bind(e.key, e.value)));
}
```

`src/routes/admin/settings.tsx`（全文差し替え）:

```tsx
import { Hono } from 'hono';
import type { Bindings } from '../../types';
import { getSettings, saveSettings, isHalfStep, halfStepRange } from '../../core/settings';
import { getCacheStatus, syncAvailability, fetchLocations, fetchBookableServices } from '../../core/square';
import type { SquareListResult } from '../../core/square';
import { formatStampJst } from '../../core/dates';
import { Layout } from './ui';

export const settingsPage = new Hono<{ Bindings: Bindings }>();

const OK_MESSAGES: Record<string, string> = {
  saved: '設定を保存しました',
  synced: 'Squareと同期しました'
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid: '入力内容に誤りがあります（メール形式・受付期間1〜365日・受付時間帯は開始<終了の30分単位）',
  sync_failed: 'Squareとの同期に失敗しました。Square設定（ロケーション/サービスID・アクセストークン）をご確認ください'
};

const ID_MAX = 128;

// 受付時間帯プルダウンの選択肢（00:00〜23:30 の30分刻み・全48個）
const OPEN_TIME_CHOICES = halfStepRange('00:00', '23:30');

function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

// SquareのID入力欄。一覧取得に成功していればプルダウン、それ以外は従来の手入力（§17.5）。
// 現在値が一覧に無い場合も「現在の値」として選択肢に残し、保存で消えないようにする。
const SquareIdField = (props: { label: string; manualLabel: string; name: string; value: string; result: SquareListResult | null }) => {
  const { result } = props;
  if (result && result.ok) {
    const inList = result.items.some((o) => o.id === props.value);
    return (
      <div class="field">
        <label>{props.label}</label>
        <select name={props.name}>
          <option value="" selected={props.value === ''}>
            （未設定）
          </option>
          {props.value !== '' && !inList && (
            <option value={props.value} selected>
              現在の値: {props.value}
            </option>
          )}
          {result.items.map((o) => (
            <option value={o.id} selected={o.id === props.value}>
              {o.name}（{o.id}）
            </option>
          ))}
        </select>
      </div>
    );
  }
  return (
    <div class="field">
      <label>{props.manualLabel}</label>
      <input type="text" name={props.name} value={props.value} maxlength={ID_MAX} />
    </div>
  );
};

settingsPage.get('/', async (c) => {
  const okParam = c.req.query('ok');
  const errorParam = c.req.query('error');
  const useSquareHelper = c.req.query('square') === '1';
  const [s, cache] = await Promise.all([getSettings(c.env.DB), getCacheStatus(c.env.DB)]);

  // 「Squareから一覧を取得」が押されたときだけAPIを呼ぶ（通常表示では呼ばない）。失敗しても例外は出ない
  let locations: SquareListResult | null = null;
  let services: SquareListResult | null = null;
  if (useSquareHelper) {
    [locations, services] = await Promise.all([fetchLocations(c.env), fetchBookableServices(c.env)]);
  }
  const helperErrors: string[] = [];
  if (locations && !locations.ok) helperErrors.push(`ロケーション: ${locations.error}`);
  if (services && !services.ok) helperErrors.push(`サービス: ${services.error}`);

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
          <label>受付時間帯（開始）— 会員はこの範囲から30分単位で時間を選びます</label>
          <select name="open_start">
            {OPEN_TIME_CHOICES.map((t) => (
              <option value={t} selected={t === s.openStart}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label>受付時間帯（終了）— 開始より後の時刻を選んでください</label>
          <select name="open_end">
            {OPEN_TIME_CHOICES.map((t) => (
              <option value={t} selected={t === s.openEnd}>
                {t}
              </option>
            ))}
          </select>
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
        <p class="small">
          <a class="btn btn-sm" href="/admin/settings?square=1">
            Squareから一覧を取得
          </a>{' '}
          <span class="muted">アクセストークン設定済みなら、ロケーションとサービスをプルダウンで選べます</span>
        </p>
        {helperErrors.length > 0 && (
          <p class="msg-error">
            Squareから一覧を取得できませんでした（{helperErrors.join(' / ')}）。
            アクセストークン（SQUARE_ACCESS_TOKEN）の設定をご確認ください。IDの直接入力は引き続き使えます。
          </p>
        )}
        <SquareIdField
          label="Square ロケーション（プルダウンで選択）"
          manualLabel="Square ロケーションID（location_id）"
          name="square_location_id"
          value={s.squareLocationId}
          result={locations}
        />
        <SquareIdField
          label="Square サービス（プルダウンで選択）"
          manualLabel="Square サービスバリエーションID（service_variation_id）"
          name="square_service_variation_id"
          value={s.squareServiceVariationId}
          result={services}
        />

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
  const openStart = typeof form.open_start === 'string' ? form.open_start.trim() : '';
  const openEnd = typeof form.open_end === 'string' ? form.open_end.trim() : '';
  const squareLocationId =
    typeof form.square_location_id === 'string' ? form.square_location_id.trim().slice(0, ID_MAX) : '';
  const squareServiceVariationId =
    typeof form.square_service_variation_id === 'string' ? form.square_service_variation_id.trim().slice(0, ID_MAX) : '';

  const windowDays = Number(windowDaysRaw);

  if (
    (staffEmail !== '' && !isValidEmail(staffEmail)) ||
    !Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365 ||
    !isHalfStep(openStart) || !isHalfStep(openEnd) || openStart >= openEnd
  ) {
    return c.redirect('/admin/settings?error=invalid');
  }

  // ステップ②持ち越し: 複数キーを1回のバッチで保存する
  await saveSettings(c.env.DB, [
    { key: 'staff_email', value: staffEmail },
    { key: 'window_days', value: String(windowDays) },
    { key: 'open_start', value: openStart },
    { key: 'open_end', value: openEnd },
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

`README.md`（全文差し替え）:

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

## 現在の機能（ステップ⑤まで）

### 会員ページ（専用リンク・ログイン不要）
- 月カレンダーで空き確認（過去・受付期間外・受付停止日は選択不可）
- 自分の予約マーク: カレンダーの日付に色付きドット（申請中=橙・確定=緑・否認=赤）と凡例
- 日付を選び、開始・終了時刻を30分単位のプルダウンで指定してリクエスト送信（ひとことメモ付き・二重リクエスト防止）
- リクエスト送信時に本人へ受付確認メール、確定/否認の結果もメールで自動通知
- 自分のリクエスト一覧（申請中/確定/否認/キャンセル済み）とキャンセル。否認・キャンセル済みの行は「非表示」で一覧から片づけられる（管理画面の記録には残る）

### 管理画面
- 承認待ち一覧から確定/否認（否認理由を添えられる。Square同期中はリクエストの時間帯に重なる空きが無いと「埋まった可能性」を警告表示）
- リクエスト一覧（状態・会員・期間で絞り込み。会員が非表示にした行も残る）
- 会員管理: 登録・編集・無効化・専用リンク発行/再発行
- 受付停止日の設定/解除
- 設定: スタッフ通知先メール・受付可能期間・受付時間帯（30分単位）・Square連携（「Squareから一覧を取得」でロケーション/サービスをプルダウン選択。手入力も可）
- ログイン試行制限（15分に10回失敗で一時ブロック）

### Square自動同期（ステップ③・読み取り専用）
- 15分ごとの cron で Bookings API から空き枠を取得し `availability_cache` に保存
- 同期有効時は日単位で判定: その日にSquareの空きが1つも無ければ受付不可、未取得日は「取得中」
- 取得が24時間以上止まるとスタッフへ通知メール
- **Square設定（ロケーション/サービスID）が未設定の間は手動モード**（受付時間帯の30分レンジから自由選択）

### メール通知（Resend）
- リクエスト送信 → スタッフ宛＋会員宛（受付確認）、キャンセル → スタッフ宛、確定/否認 → 会員宛、同期停止(24h) → スタッフ宛
- RESEND_API_KEY 未設定時は送信せず email_log に記録のみ（開発中の誤送信防止）

## Square連携のセットアップ

Square の空き枠をアプリに取り込むための初期設定です。ロケーション/サービスIDを入れるまでは同期無効（手動モード）のままなので、準備ができてから設定してください。

1. **アクセストークンを発行**: Square Developer ダッシュボード（developer.squareup.com）→ アプリを作成 → 本番用の Production Access Token を取得（読み取りのみで可・無料・5分程度）
2. **トークンをサーバーに登録**: 本番は `npx wrangler secret put SQUARE_ACCESS_TOKEN`／ローカルは `.dev.vars` の `SQUARE_ACCESS_TOKEN`
3. **管理画面で ID を選択**: /admin → 設定 → Square連携 の「Squareから一覧を取得」を押すと、ロケーションとサービスをプルダウンで選べます（IDの手入力も可）。両方選んで保存すると「同期有効」になります
4. **結合確認**: 設定画面の「今すぐ同期」を押す → 「Squareと同期しました」が出れば成功。会員ページを開き、空き状況がSquareの内容と一致することを確認

> sandbox で試す場合は env `SQUARE_API_BASE` を `https://connect.squareupsandbox.com` に設定します（既定は本番 `https://connect.squareup.com`）。

## 本番デプロイ（初回）

1. `wrangler d1 create torch-member-booking` を実行し、出力の database_id を wrangler.jsonc に反映
2. `npx wrangler d1 migrations apply torch-member-booking --remote`
3. `npx wrangler secret put ADMIN_PASSWORD` / `SESSION_SECRET` / `RESEND_API_KEY` / `NOTIFY_EMAIL_FROM`（Square連携する場合は `SQUARE_ACCESS_TOKEN` も）
4. （任意）`npx wrangler secret put APP_ORIGIN` にメールのリンク用の絶対URL（例 https://torch-member-booking.example.workers.dev）を設定
5. `npm run deploy`（cron `*/15 * * * *` も一緒に登録される）
6. 管理画面 → 設定 でスタッフ通知先メールと受付時間帯を確認。Square連携する場合はロケーション/サービスも選択

## 福田さん向け: Square同期の動作確認手順

エンジニアでなくても確認できます（管理画面と会員ページだけで完結します）。

1. /admin → 設定 → Square連携 の「Squareから一覧を取得」を押し、ロケーションとサービスをプルダウンで選んで「保存」
2. 状態が「同期有効」になることを確認
3. 「今すぐ同期」を押す → 「Squareと同期しました」と出る（出ない場合はアクセストークンを確認）
4. 会員の専用リンクを開き、カレンダーで日付を選ぶ → Squareで空きが無い日は「この日はSquare側で空きがありません」と表示されることを確認
5. Square側で終日埋まっている日（クローズ日）を選んでみて、受付不可になっていれば同期は成功
6. IDを「（未設定）」にして保存すれば、いつでも手動モードに戻せます

## 開発ステップ

1. 基盤 — 会員管理と専用リンク発行（完了）
2. リクエストの流れ — 空き表示・リクエスト・確定/否認・メール通知（完了・運用開始可能）
3. Square自動同期 — Bookings APIで空き枠を15分ごとに取得（完了）
4. 会員UX改善（ステップ⑤） — 30分単位の時間選択・予約マーク・受付確認メール・非表示・Square設定ヘルパー（完了）
5. 回数券の残数管理 ← 次
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（累計 **138件**。admin-closed-settings 6件・admin-settings-square 4件。`settings.test.ts`（Task 1 の9件）は slots を参照していないので無変更で通る。`schema2.test.ts` の 0001 シード確認も無変更で通る）

Run: `npm run typecheck`
Expected: エラーなし（`parseSlotsText`/`slotsToText`/`findSlot`/`DEFAULT_SLOTS`/`Slot` への参照はもうどこにも無い）

- [ ] **Step 5: コミット**

```bash
git add src/core/settings.ts src/routes/admin/settings.tsx README.md test/admin-closed-settings.test.ts test/admin-settings-square.test.ts
git commit -m "feat: 設定画面を受付時間帯とSquareプルダウン選択に刷新し、時間枠テンプレート(slots)を廃止"
```

---

## 動作確認手順（ステップ⑤完了後、福田さん向けデモ）

前提: `npm test` が **138件すべて通過**・`npm run typecheck` エラーなし。

```bash
npm run dev
```

**A. 30分単位の時間選択と受付確認メール（同期無効のまま）**

1. 会員の専用リンクを開き、カレンダーで日付を選ぶ → 「開始時刻」「終了時刻」のプルダウンが出る（既定 10:00〜21:00 の30分刻み）
2. 10:30〜15:00 のような自由な組み合わせでリクエスト送信 → 「あなたのリクエスト」に 10:30〜15:00 が申請中で並ぶ
3. /admin → 管理画面の email_log（またはResend設定済みなら受信箱）に、スタッフ宛 `requested` と会員宛 `requested_member` の2通が記録されている
4. 終了時刻を開始より前にして送信できないこと（ブラウザで選べても invalid でエラー表示）

**B. カレンダーのマークと非表示**

5. リクエスト送信後、カレンダーの該当日に橙のドット（申請中）が出る。凡例（申請中/確定/否認）がカレンダー下に出る
6. /admin → 承認待ちで確定 → 会員ページのドットが緑（確定）に変わる
7. 別の日のリクエストを否認 → 赤ドット。一覧の否認行に「非表示」ボタンが出る → 押すと行とドットが消える
8. /admin → リクエスト一覧では非表示にした行も引き続き見える（記録保全）

**C. 設定画面（受付時間帯・Squareヘルパー）**

9. /admin → 設定 → 「時間枠テンプレート」欄が消え、「受付時間帯」の開始/終了プルダウンになっている
10. 受付時間帯を 09:00〜18:30 に変更して保存 → 会員ページの選択肢が 09:00〜18:30 の範囲に変わる
11. 「Squareから一覧を取得」→ アクセストークン未設定なら日本語のエラー案内＋手入力欄のまま。`.dev.vars` にトークンがあればロケーション/サービスがプルダウンで選べる
12. （同期有効時）Squareで空きが1つも無い日を選ぶ → 「この日はSquare側で空きがありません」。承認待ちの時間帯に重なる空きが無ければ「埋まった可能性」バッジ

## 補足（実装者向け）

- **唯一の意図した仕様変更**は「手動モード」の中身（時間枠テンプレート → 受付時間帯の30分レンジ自由選択）。それ以外（トークン方式・状態遷移・部分UNIQUE・通知の非例外化・管理セッション）は1ビットも変えない
- 二重防止の部分UNIQUE `ux_requests_active` は（member_id, date, start_time）のまま。**レンジの重なりは禁止しない**（席に余裕がある運用・スタッフが承認画面で判断）。同じ開始時刻で終了だけ違うリクエストは duplicate になるのが正しい挙動
- Square同期有効時の空き判定は**日単位**（§17.1）: 行なし=取得中、空配列=案内不可、1つでもあれば受付時間帯全体を出す。POST側も同じ判定。**枠単位の照合はもう存在しない**
- 承認画面の警告は**レンジ重なり近似**: `start<=t<end` に入る空き開始時刻が1つも無ければ警告。終了時刻ちょうど（`t === end`）は重なりに数えない
- `requested_member` は `requested`（スタッフ宛）の**後**に送る。テストは email_log の記録順（requested → requested_member）に依存している
- メール2通はどちらも `sendRequestNotification` なので**絶対に例外を投げない**規約はそのまま。Resend未設定時は2通とも `skipped` 記録
- 非表示（hide）は `hidden_by_member = 1` にするだけ。DELETE はしない。会員ページの一覧とマークのクエリだけが `hidden_by_member = 0` で絞る。管理画面のクエリは触らない
- カレンダーのドットは受付範囲内（今日〜受付期限）と停止日セルに出す。過去日セルには出さない（範囲外セルは `day-off` 表示のみ）
- `fetchLocations`/`fetchBookableServices` の応答形状（`locations[]`・`items[].item_data.variations[]`）は**想定形**。実APIとの差異は §17.5 の結合確認（実トークンで `?square=1` を開く）で吸収する。パースは防御的なので想定外フィールドで落ちない
- `?square=1` は認証配下のGET。トークンが無ければ `{ ok:false, error:'no_token' }` が返り、画面は日本語エラー＋手入力にフォールバックする（テストはこの経路を使うので実APIを叩かない）
- 0001シードの `settings.slots` 行は**消さない**（migrationの改変禁止）。Task 6 以降どこからも読まれない。`schema2.test.ts` はこのシードを検証しているので触らない
- テストの利用日は実行日に依存しないよう `addDays(currentJstDate(), n)` で生成。`fetched_at` 検証だけ固定ISO文字列（JST 9:30 = `2026-07-24T00:30:00.000Z`）
- 新規依存なし。migration は `0004_step5.sql` の追記のみ（`hidden_by_member` 列と `open_start`/`open_end` シード）
