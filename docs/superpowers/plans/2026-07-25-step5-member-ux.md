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
