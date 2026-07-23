# TORCH会員予約システム ステップ②（リクエストの流れ）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会員が専用リンクから空きカレンダーを見て日付＋時間枠でリクエストを送り、スタッフが管理画面で確定/否認し、双方にメールが自動送信される状態を作る（設計書 §12 ステップ②）。ここまで完成すると**実運用を開始できる**。

**Architecture:** ステップ①の土台の上に、(1) requests/closed_dates/settings/email_log/login_failures テーブル、(2) 純粋ロジックのコア層（日付・設定・状態遷移）、(3) Resendメール通知（絶対に例外を投げない・未設定時はスキップ＋記録）、(4) 会員ページの月カレンダー＋リクエストUI、(5) 管理画面の承認待ち/一覧/受付停止日/設定、(6) 最終レビュー持ち越しのハードニング（robots.txt・ログイン試行制限・テスト補強・偽成功修正）を積む。空き状況は「手動モード」＝時間枠テンプレート − 受付停止日 − 期間外 − 過去日（Square同期はステップ③）。

**Tech Stack:** ステップ①と同一（Hono 4.12.28 / wrangler 4.107.0 / D1 / vitest 3.2.7 + vitest-pool-workers 0.12.21 / TypeScript 6.0.3）。メールは Resend REST API を fetch で直接叩く（SDK不使用。booking-system で実証済み）。

## Global Constraints

- 設計書: `docs/superpowers/specs/2026-07-23-torch-member-booking-design.md` §5〜§11（本計画は §12 ステップ②のみ。Square同期・availability_cache・回数券 ticket_events は**作らない**）
- 作業ディレクトリ: `/Users/daisukefukuda/Projects/coworkingspace_booking_webapp/`（記号入りの旧パスで npm test を実行しない）
- 日付はすべて **JST基準**。「今日」は `currentJstDate()`（UTC+9固定・DSTなし）で求め、`YYYY-MM-DD` 文字列で比較する。`new Date()` の暗黙タイムゾーンに依存した日付判定を書かない
- リクエストの状態遷移は `pending → confirmed | declined | cancelled`、`confirmed → cancelled` のみ。遷移はすべて「現在の状態を WHERE に含む条件付きUPDATE」で原子的に行い、`meta.changes === 0` を失敗として扱う
- 二重リクエスト防止: 同一 `member_id`＋`date`＋`start_time` で状態が pending/confirmed の行は部分UNIQUEインデックスで物理的に禁止
- メール通知は**絶対に例外を投げない**。RESEND_API_KEY か宛先が無ければ送信せず `email_log` に skipped を記録（booking-system の実証パターン）。DBが正でメールは補助
- スタッフ通知先メールは env ではなく **settings テーブル**（管理画面で設定。設計書 §5.2）。差出人 `NOTIFY_EMAIL_FROM` と `RESEND_API_KEY` は env（secret）
- 会員向け文言はすべて日本語・丁寧語。管理画面は簡潔な日本語。アプリ表示名は「TORCH 会員予約」
- member_note / admin_note は最大500文字（超過はサーバー側で invalid 扱い）
- トークン・パスワードを console.log に出さない
- 各タスク完了時: `npm test` と `npm run typecheck` が全部通ってからコミット。コミットメッセージは `feat:`/`chore:` プレフィックス＋日本語
- テスト名は日本語でよい。`MF-Vitest-Source` 非ASCII警告は既知の無害な挙動
- 既存テストの修正は Task 6（admin '/' の転送先変更）と Task 9（Cookie属性・ログアウトlocation の補強）で明示されたものだけ。それ以外の既存テストを書き換えない

---

### Task 1: スキーマv2（requests・closed_dates・settings・email_log・login_failures）

**Files:**
- Create: `migrations/0002_step2.sql`
- Test: `test/schema2.test.ts`

**Interfaces:**
- Consumes: `members` テーブル（ステップ①）
- Produces: `requests`（部分UNIQUE `ux_requests_active` 付き）、`closed_dates`、`settings`（slots/window_days/staff_email をシード済み）、`email_log`、`login_failures` の5テーブル。以降の全タスクが使用

- [ ] **Step 1: 失敗するテストを書く**

`test/schema2.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

async function seedMember(): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO members (name, email, member_type, token, is_active, created_at) VALUES ('会員A', 'a@example.com', 'monthly', ?, 1, '2026-07-23T00:00:00.000Z')`
  ).bind('a'.repeat(40)).run();
  return res.meta.last_row_id as number;
}

const INSERT_REQ = `INSERT INTO requests (member_id, date, start_time, end_time, status, member_note, admin_note, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, '', '', '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z')`;

describe('step2 schema', () => {
  it('requests を登録して読み出せる', async () => {
    const memberId = await seedMember();
    await env.DB.prepare(INSERT_REQ).bind(memberId, '2026-08-01', '10:00', '13:00', 'pending').run();
    const row = await env.DB.prepare('SELECT * FROM requests WHERE member_id = ?').bind(memberId).first();
    expect(row).not.toBeNull();
    expect(row!.status).toBe('pending');
    expect(row!.end_time).toBe('13:00');
  });

  it('requests の status は定義外の値を拒否する', async () => {
    const memberId = await seedMember();
    await expect(
      env.DB.prepare(INSERT_REQ).bind(memberId, '2026-08-01', '10:00', '13:00', 'waiting').run()
    ).rejects.toThrow();
  });

  it('同一会員・同一日・同一開始時刻のアクティブな行は重複登録できない', async () => {
    const memberId = await seedMember();
    await env.DB.prepare(INSERT_REQ).bind(memberId, '2026-08-02', '10:00', '13:00', 'pending').run();
    await expect(
      env.DB.prepare(INSERT_REQ).bind(memberId, '2026-08-02', '10:00', '13:00', 'confirmed').run()
    ).rejects.toThrow();
  });

  it('キャンセル済みなら同じ日時に再登録できる', async () => {
    const memberId = await seedMember();
    await env.DB.prepare(INSERT_REQ).bind(memberId, '2026-08-03', '10:00', '13:00', 'cancelled').run();
    await env.DB.prepare(INSERT_REQ).bind(memberId, '2026-08-03', '10:00', '13:00', 'pending').run();
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM requests WHERE member_id = ? AND date = ?')
      .bind(memberId, '2026-08-03').first<{ n: number }>();
    expect(rows!.n).toBe(2);
  });

  it('settings に初期値がシードされている', async () => {
    const rows = await env.DB.prepare('SELECT key, value FROM settings ORDER BY key').all<{ key: string; value: string }>();
    const map = new Map(rows.results.map((r) => [r.key, r.value]));
    expect(map.get('staff_email')).toBe('');
    expect(map.get('window_days')).toBe('60');
    expect(JSON.parse(map.get('slots')!)).toEqual([
      { start: '10:00', end: '13:00' },
      { start: '13:00', end: '17:00' },
      { start: '17:00', end: '21:00' }
    ]);
  });

  it('closed_dates・email_log・login_failures に読み書きできる', async () => {
    await env.DB.prepare(`INSERT INTO closed_dates (date, reason) VALUES ('2026-08-10', '臨時休業')`).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO closed_dates (date, reason) VALUES ('2026-08-10', '設備点検')`).run();
    const cd = await env.DB.prepare(`SELECT reason FROM closed_dates WHERE date = '2026-08-10'`).first<{ reason: string }>();
    expect(cd!.reason).toBe('設備点検');

    await env.DB.prepare(
      `INSERT INTO email_log (request_id, to_address, type, status, error, created_at) VALUES (1, 'x@example.com', 'requested', 'skipped', NULL, '2026-07-23T00:00:00.000Z')`
    ).run();
    const el = await env.DB.prepare('SELECT COUNT(*) AS n FROM email_log').first<{ n: number }>();
    expect(el!.n).toBe(1);

    await env.DB.prepare(`INSERT INTO login_failures (ip, created_at) VALUES ('1.2.3.4', '2026-07-23T00:00:00.000Z')`).run();
    const lf = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures').first<{ n: number }>();
    expect(lf!.n).toBe(1);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（`no such table: requests`）

- [ ] **Step 3: マイグレーションを実装**

`migrations/0002_step2.sql`:

```sql
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
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（schema2 6件を含む累計 34 件）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5: ローカル開発DBにも適用してコミット**

Run: `npx wrangler d1 migrations apply torch-member-booking --local`
Expected: `0002_step2.sql` が適用される（確認プロンプトが出たら y）

```bash
git add migrations/0002_step2.sql test/schema2.test.ts
git commit -m "feat: ステップ②スキーマ（requests/closed_dates/settings/email_log/login_failures）"
```

---

### Task 2: 日付コアと設定コア

**Files:**
- Create: `src/core/dates.ts`
- Create: `src/core/settings.ts`
- Test: `test/dates.test.ts`
- Test: `test/settings.test.ts`

**Interfaces:**
- Consumes: `settings` テーブル（Task 1）
- Produces:
  - `dates.ts`: `DATE_RE: RegExp` / `WEEKDAY_LABELS: string[]` / `currentJstDate(): string` / `addDays(date: string, delta: number): string` / `clampDate(date: string, min: string, max: string): string` / `formatMD(date: string): string` / `monthOf(date: string): string`（'YYYY-MM'） / `addMonths(month: string, delta: number): string` / `buildMonthGrid(month: string): (string | null)[][]`（日曜始まりの週配列）
  - `settings.ts`: `Slot { start: string; end: string }` / `AppSettings { slots: Slot[]; windowDays: number; staffEmail: string }` / `DEFAULT_SLOTS` / `getSettings(db): Promise<AppSettings>` / `setSetting(db, key, value): Promise<void>` / `parseSlotsText(text: string): Slot[] | null` / `slotsToText(slots: Slot[]): string` / `findSlot(slots: Slot[], start: string): Slot | null`

- [ ] **Step 1: 失敗するテストを書く**

`test/dates.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DATE_RE, currentJstDate, addDays, clampDate, formatMD, monthOf, addMonths, buildMonthGrid } from '../src/core/dates';

describe('dates', () => {
  it('currentJstDate は YYYY-MM-DD を返す', () => {
    expect(currentJstDate()).toMatch(DATE_RE);
  });

  it('addDays は月末・年末・うるう年をまたげる', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29'); // うるう年
    expect(addDays('2026-08-01', -1)).toBe('2026-07-31');
  });

  it('clampDate は範囲内に収める', () => {
    expect(clampDate('2026-07-01', '2026-07-10', '2026-07-20')).toBe('2026-07-10');
    expect(clampDate('2026-07-25', '2026-07-10', '2026-07-20')).toBe('2026-07-20');
    expect(clampDate('2026-07-15', '2026-07-10', '2026-07-20')).toBe('2026-07-15');
  });

  it('formatMD と monthOf', () => {
    expect(formatMD('2026-07-05')).toBe('7/5');
    expect(monthOf('2026-07-05')).toBe('2026-07');
  });

  it('addMonths は年をまたげる', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-07', 0)).toBe('2026-07');
  });

  it('buildMonthGrid は日曜始まりで月の全日を並べる', () => {
    const grid = buildMonthGrid('2026-07'); // 2026-07-01 は水曜
    expect(grid.every((week) => week.length === 7)).toBe(true);
    expect(grid[0]).toEqual([null, null, null, '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04']);
    const days = grid.flat().filter((d): d is string => d !== null);
    expect(days.length).toBe(31);
    expect(days[0]).toBe('2026-07-01');
    expect(days[30]).toBe('2026-07-31');
  });
});
```

`test/settings.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getSettings, setSetting, parseSlotsText, slotsToText, findSlot, DEFAULT_SLOTS } from '../src/core/settings';

describe('settings', () => {
  it('シード値を読み出せる', async () => {
    const s = await getSettings(env.DB);
    expect(s.slots).toEqual(DEFAULT_SLOTS);
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

  it('slots が壊れた値（不正JSON・空配列・不正な時刻）でもデフォルトにフォールバックする', async () => {
    await setSetting(env.DB, 'slots', '{broken');
    expect((await getSettings(env.DB)).slots).toEqual(DEFAULT_SLOTS);

    await setSetting(env.DB, 'slots', '[]'); // 枠ゼロは無効
    expect((await getSettings(env.DB)).slots).toEqual(DEFAULT_SLOTS);

    await setSetting(env.DB, 'slots', '[{"start":"zz","end":"99:99"}]'); // 時刻形式不正
    expect((await getSettings(env.DB)).slots).toEqual(DEFAULT_SLOTS);

    await setSetting(env.DB, 'slots', '[{"start":"13:00","end":"10:00"}]'); // 開始>=終了
    expect((await getSettings(env.DB)).slots).toEqual(DEFAULT_SLOTS);
  });

  it('parseSlotsText は「HH:MM-HH:MM」の行を受け付ける', () => {
    expect(parseSlotsText('10:00-13:00\n13:00-17:00')).toEqual([
      { start: '10:00', end: '13:00' },
      { start: '13:00', end: '17:00' }
    ]);
    // 空行と前後空白は無視、開始時刻順に整列
    expect(parseSlotsText(' 17:00-21:00 \n\n10:00-13:00\n')).toEqual([
      { start: '10:00', end: '13:00' },
      { start: '17:00', end: '21:00' }
    ]);
  });

  it('parseSlotsText は不正入力に null を返す', () => {
    expect(parseSlotsText('')).toBeNull();               // 枠ゼロ
    expect(parseSlotsText('10:00')).toBeNull();          // 形式不正
    expect(parseSlotsText('13:00-10:00')).toBeNull();    // 開始>=終了
    expect(parseSlotsText('25:00-26:00')).toBeNull();    // 時刻範囲外
    expect(parseSlotsText('10:00-13:00\n10:00-14:00')).toBeNull(); // 開始時刻重複
  });

  it('slotsToText と findSlot', () => {
    expect(slotsToText(DEFAULT_SLOTS)).toBe('10:00-13:00\n13:00-17:00\n17:00-21:00');
    expect(findSlot(DEFAULT_SLOTS, '13:00')).toEqual({ start: '13:00', end: '17:00' });
    expect(findSlot(DEFAULT_SLOTS, '09:00')).toBeNull();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（`Failed to load ../src/core/dates` 等）

- [ ] **Step 3: 実装**

`src/core/dates.ts`:

```ts
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

// JSTの「今日」。UTC+9固定（日本にDSTはない）。booking-systemで実証済みの方式
export function currentJstDate(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

export function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function clampDate(date: string, min: string, max: string): string {
  if (date < min) return min;
  if (date > max) return max;
  return date;
}

export function formatMD(date: string): string {
  const [, m, d] = date.split('-');
  return `${Number(m)}/${Number(d)}`;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function addMonths(month: string, delta: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + delta;
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
}

// 日曜始まりの週配列。月外のセルは null
export function buildMonthGrid(month: string): (string | null)[][] {
  const firstDow = new Date(`${month}-01T00:00:00Z`).getUTCDay();
  const daysInMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}
```

`src/core/settings.ts`:

```ts
export interface Slot {
  start: string; // 'HH:MM'
  end: string;   // 'HH:MM'
}

export interface AppSettings {
  slots: Slot[];
  windowDays: number;
  staffEmail: string;
}

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

  return { slots, windowDays, staffEmail: map.get('staff_email') ?? '' };
}

export async function setSetting(db: D1Database, key: 'slots' | 'window_days' | 'staff_email', value: string): Promise<void> {
  await db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(key, value).run();
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

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（dates 6件＋settings 6件…あわせて累計 46 件）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/core/dates.ts src/core/settings.ts test/dates.test.ts test/settings.test.ts
git commit -m "feat: 日付コア（JST・月グリッド）と設定コア（時間枠テンプレート）"
```

---

### Task 3: リクエスト状態遷移コア

**Files:**
- Create: `src/core/requests.ts`
- Modify: `src/types.ts`（全文差し替え）
- Test: `test/requests-core.test.ts`

**Interfaces:**
- Consumes: `requests` テーブルと部分UNIQUE（Task 1）
- Produces:
  - `types.ts` 追加分: `RequestStatus = 'pending' | 'confirmed' | 'declined' | 'cancelled'` / `RequestRow`（id, member_id, date, start_time, end_time, status, member_note, admin_note, created_at, updated_at）
  - `requests.ts`: `createRequest(db, input: { memberId: number; date: string; startTime: string; endTime: string; memberNote: string }): Promise<{ ok: true; id: number } | { ok: false; reason: 'duplicate' }>` / `confirmRequest(db, id: number): Promise<boolean>` / `declineRequest(db, id: number, adminNote: string): Promise<boolean>` / `cancelRequestByMember(db, id: number, memberId: number): Promise<boolean>`

- [ ] **Step 1: 失敗するテストを書く**

`test/requests-core.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createRequest, confirmRequest, declineRequest, cancelRequestByMember } from '../src/core/requests';

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
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（`Failed to load ../src/core/requests`）

- [ ] **Step 3: 実装**

`src/types.ts`（全文差し替え）:

```ts
export type Bindings = {
  DB: D1Database;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  RESEND_API_KEY?: string;
  NOTIFY_EMAIL_FROM?: string;
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
```

`src/core/requests.ts`:

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
  } catch {
    // 部分UNIQUE（ux_requests_active）違反 = 同一日・同一枠のアクティブなリクエストが既にある
    return { ok: false, reason: 'duplicate' };
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
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（requests core 7件を含む累計 53 件）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/core/requests.ts src/types.ts test/requests-core.test.ts
git commit -m "feat: リクエスト状態遷移コア（条件付きUPDATE・部分UNIQUEで二重防止）"
```

---

### Task 4: メール通知（Resend）

**Files:**
- Create: `src/core/notify.ts`
- Modify: `test/env.d.ts`（全文差し替え）
- Modify: `vitest.config.ts`（bindings に NOTIFY_EMAIL_FROM 追加・全文差し替え）
- Modify: `.dev.vars.example`（全文差し替え）
- Test: `test/notify.test.ts`

**Interfaces:**
- Consumes: `requests`・`members`・`email_log`・`settings`（staff_email）、`getSettings`（Task 2）
- Produces: `EmailType = 'requested' | 'cancelled' | 'confirmed' | 'declined'` / `sendRequestNotification(db, env: { RESEND_API_KEY?: string; NOTIFY_EMAIL_FROM?: string }, requestId: number, type: EmailType, origin: string, fetcher?: typeof fetch): Promise<void>`。宛先: requested/cancelled → スタッフ（settings.staff_email）、confirmed/declined → 会員本人。**絶対に例外を投げない**

- [ ] **Step 1: 失敗するテストを書く**

`test/notify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { sendRequestNotification } from '../src/core/notify';
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
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（`Failed to load ../src/core/notify`）

- [ ] **Step 3: 実装**

`src/core/notify.ts`:

```ts
import { getSettings } from './settings';

export type EmailType = 'requested' | 'cancelled' | 'confirmed' | 'declined';

interface NotifyEnv {
  RESEND_API_KEY?: string;
  NOTIFY_EMAIL_FROM?: string;
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
          `管理画面で確定/否認してください: ${origin}/admin/requests`
        ];
      } else {
        subject = `【TORCH 会員予約】キャンセル: ${when} ${r.member_name}様`;
        lines = [
          '会員がリクエストをキャンセルしました。',
          '',
          `会員: ${r.member_name}様（${typeLabel}）`,
          `日時: ${when}`,
          '',
          `一覧: ${origin}/admin/requests/all`
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

function logEmail(db: D1Database, requestId: number, to: string, type: string, status: string, error: string | null) {
  return db.prepare(
    `INSERT INTO email_log (request_id, to_address, type, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(requestId, to, type, status, error, new Date().toISOString()).run();
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
  }
}
```

`vitest.config.ts`（全文差し替え。bindings に NOTIFY_EMAIL_FROM を追加しただけ）:

```ts
/// <reference types="vite/client" />
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig(async () => {
  // decodeURIComponent は import.meta.url がスペースや全角文字を含むパス（%20 等）でも
  // 正しいファイルシステムパスに変換するために必要（このリポジトリのパスは両方含む）
  const migrationsPath = decodeURIComponent(new URL('./migrations', import.meta.url).pathname);
  const migrations = await readD1Migrations(migrationsPath);
  return {
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              ADMIN_PASSWORD: 'test-password',
              SESSION_SECRET: 'test-secret',
              NOTIFY_EMAIL_FROM: 'noreply@example.com'
            }
          }
        }
      }
    }
  };
});
```

`.dev.vars.example`（全文差し替え）:

```
ADMIN_PASSWORD=changeme
SESSION_SECRET=changeme-long-random-string
RESEND_API_KEY=
NOTIFY_EMAIL_FROM=onboarding@resend.dev
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（notify 5件を含む累計 58 件）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/core/notify.ts test/notify.test.ts test/env.d.ts vitest.config.ts .dev.vars.example
git commit -m "feat: メール通知（Resend・未設定時skip・email_log記録）"
```

---

### Task 5: 会員ページ（カレンダー・リクエスト送信・一覧・キャンセル）

**Files:**
- Modify: `src/routes/member.tsx`（全文差し替え）
- Modify: `src/routes/style-css.ts`（全文差し替え: カレンダー・バッジ・危険ボタン追加）
- Test: `test/member-requests.test.ts`

**Interfaces:**
- Consumes: `dates.ts`・`settings.ts`（Task 2）、`requests.ts`（Task 3）、`sendRequestNotification`（Task 4）、`closed_dates`、`MemberRow`/`RequestRow`（types）
- Produces: 会員ページ一式
  - GET `/m/:token?month=YYYY-MM&date=YYYY-MM-DD` — 月カレンダー（過去/期間外/停止日は選択不可）、日付選択時は時間枠フォーム、自分のリクエスト一覧（キャンセルボタン付き）
  - POST `/m/:token/requests`（date, start, note）→ ok=requested | error=invalid/closed/duplicate
  - POST `/m/:token/requests/:id/cancel` → ok=cancelled | error=invalid
  - `REQUEST_STATUS_LABELS` / `REQUEST_BADGE_CLASSES`（member.tsx から export。Task 6 の管理画面も使う）

- [ ] **Step 1: 失敗するテストを書く**

`test/member-requests.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../src/index';
import { adminCookie } from './helpers';
import { currentJstDate, addDays, monthOf } from '../src/core/dates';

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

function postRequest(token: string, body: Record<string, string>): Promise<Response> {
  return app.request(`/m/${token}/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  }, env);
}

const target = addDays(currentJstDate(), 7);

describe('member requests', () => {
  it('カレンダーに月と時間枠フォームが表示される', async () => {
    const { token } = await createMember('カレンダー会員');
    const res = await app.request(`/m/${token}?date=${target}`, {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    const [ty, tm] = monthOf(target).split('-');
    expect(html).toContain(`${ty}年${Number(tm)}月`); // 例: 2026年7月（先頭ゼロなし）
    expect(html).toContain('10:00〜13:00');
    expect(html).toContain('リクエスト送信');
  });

  it('リクエスト送信で申請中になり、スタッフ通知が記録される', async () => {
    const { id, token } = await createMember('送信会員');
    const res = await postRequest(token, { date: target, start: '10:00', note: '午前利用します' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('ok=requested');

    const row = await env.DB.prepare('SELECT * FROM requests WHERE member_id = ?').bind(id).first();
    expect(row!.status).toBe('pending');
    expect(row!.end_time).toBe('13:00'); // テンプレートから補完
    expect(row!.member_note).toBe('午前利用します');

    const log = await env.DB.prepare('SELECT type, status FROM email_log WHERE request_id = ?').bind(row!.id).first();
    expect(log!.type).toBe('requested');
    expect(log!.status).toBe('skipped'); // テストではRESEND_API_KEY未設定

    const page = await app.request(`/m/${token}`, {}, env);
    const html = await page.text();
    expect(html).toContain('申請中');
    expect(html).toContain('キャンセル');
  });

  it('同じ日・同じ枠の二重リクエストは弾かれる', async () => {
    const { token } = await createMember('重複会員');
    await postRequest(token, { date: target, start: '10:00', note: '' });
    const res = await postRequest(token, { date: target, start: '10:00', note: '' });
    expect(res.headers.get('location')).toContain('error=duplicate');
  });

  it('過去日・期間外・不正な枠・長すぎるメモは invalid', async () => {
    const { token } = await createMember('不正会員');
    expect((await postRequest(token, { date: addDays(currentJstDate(), -1), start: '10:00', note: '' })).headers.get('location')).toContain('error=invalid');
    expect((await postRequest(token, { date: addDays(currentJstDate(), 120), start: '10:00', note: '' })).headers.get('location')).toContain('error=invalid');
    expect((await postRequest(token, { date: target, start: '09:59', note: '' })).headers.get('location')).toContain('error=invalid');
    expect((await postRequest(token, { date: target, start: '10:00', note: 'あ'.repeat(501) })).headers.get('location')).toContain('error=invalid');
  });

  it('受付停止日にはリクエストできず、カレンダーにも停止と表示される', async () => {
    const { token } = await createMember('停止日会員');
    const closed = addDays(currentJstDate(), 10);
    await env.DB.prepare(`INSERT INTO closed_dates (date, reason) VALUES (?, '臨時休業')`).bind(closed).run();

    const res = await postRequest(token, { date: closed, start: '10:00', note: '' });
    expect(res.headers.get('location')).toContain('error=closed');

    const page = await app.request(`/m/${token}?month=${monthOf(closed)}`, {}, env);
    expect(await page.text()).toContain('停');
  });

  it('本人はキャンセルでき、スタッフ通知が記録される', async () => {
    const { id, token } = await createMember('取消会員');
    await postRequest(token, { date: target, start: '13:00', note: '' });
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
    await postRequest(a.token, { date: target, start: '17:00', note: '' });
    const row = await env.DB.prepare('SELECT id FROM requests WHERE member_id = ?').bind(a.id).first<{ id: number }>();

    const res = await app.request(`/m/${b.token}/requests/${row!.id}/cancel`, { method: 'POST' }, env);
    expect(res.headers.get('location')).toContain('error=invalid');
    const after = await env.DB.prepare('SELECT status FROM requests WHERE id = ?').bind(row!.id).first();
    expect(after!.status).toBe('pending');
  });

  it('無効トークンでのPOSTは404', async () => {
    const res = await postRequest('f'.repeat(40), { date: target, start: '10:00', note: '' });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（会員ページに月表示・POSTルートが無いため member-requests の各ケースが失敗）

- [ ] **Step 3: CSSを差し替える**

`src/routes/style-css.ts`（全文差し替え）:

```ts
// ステップ②: カレンダー・状態バッジ・会員ページ用のスタイルを追加
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
`;
```

- [ ] **Step 4: 会員ページを実装**

`src/routes/member.tsx`（全文差し替え）:

```tsx
import { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import type { Bindings, MemberRow, RequestRow, RequestStatus } from '../types';
import { TYPE_LABELS, TYPE_BADGE_CLASSES } from './admin/ui';
import { DATE_RE, WEEKDAY_LABELS, currentJstDate, addDays, monthOf, addMonths, buildMonthGrid, formatMD } from '../core/dates';
import { getSettings, findSlot } from '../core/settings';
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
  duplicate: 'この日時にはすでにリクエスト済みです'
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
  const today = currentJstDate();
  const maxDate = addDays(today, settings.windowDays);

  const monthParam = c.req.query('month');
  const dateParam = c.req.query('date');
  const selectedDate =
    dateParam && DATE_RE.test(dateParam) && dateParam >= today && dateParam <= maxDate ? dateParam : null;

  const minMonth = monthOf(today);
  const maxMonth = monthOf(maxDate);
  let month = monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : selectedDate ? monthOf(selectedDate) : minMonth;
  if (month < minMonth) month = minMonth;
  if (month > maxMonth) month = maxMonth;

  const monthStart = `${month}-01`;
  const monthEnd = addDays(`${addMonths(month, 1)}-01`, -1);
  const [closedResult, requestsResult] = await Promise.all([
    c.env.DB.prepare('SELECT date FROM closed_dates WHERE date >= ? AND date <= ?')
      .bind(monthStart, monthEnd).all<{ date: string }>(),
    c.env.DB.prepare('SELECT * FROM requests WHERE member_id = ? ORDER BY date DESC, start_time DESC, id DESC LIMIT 50')
      .bind(m.id).all<RequestRow>()
  ]);
  const closedSet = new Set(closedResult.results.map((r) => r.date));
  const myRequests = requestsResult.results;

  const selectedClosed = selectedDate !== null && closedSet.has(selectedDate);
  const grid = buildMonthGrid(month);
  const prevMonth = addMonths(month, -1);
  const nextMonth = addMonths(month, 1);
  const [y, mo] = month.split('-');

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

      {selectedDate && !selectedClosed && (
        <>
          <h2>
            {formatMD(selectedDate)}（{WEEKDAY_LABELS[new Date(`${selectedDate}T00:00:00Z`).getUTCDay()]}）のリクエスト
          </h2>
          <form class="card card-pad" method="post" action={`/m/${token}/requests`}>
            <input type="hidden" name="date" value={selectedDate} />
            <div class="field">
              <label>時間枠</label>
              <div class="slot-list">
                {settings.slots.map((s, i) => (
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

  if (!DATE_RE.test(date) || date < today || date > maxDate || slot === null || note.length > NOTE_MAX) {
    return c.redirect(`/m/${token}?date=${DATE_RE.test(date) ? date : ''}&error=invalid`);
  }

  const closed = await c.env.DB.prepare('SELECT date FROM closed_dates WHERE date = ?').bind(date).first();
  if (closed) return c.redirect(`/m/${token}?error=closed`);

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
  const id = /^\d+$/.test(idRaw) ? Number(idRaw) : null;
  const ok = id !== null && (await cancelRequestByMember(c.env.DB, id, m.id));
  if (ok && id !== null) {
    const origin = new URL(c.req.url).origin;
    await sendRequestNotification(c.env.DB, c.env, id, 'cancelled', origin);
  }
  return c.redirect(`/m/${token}?${ok ? 'ok=cancelled' : 'error=invalid'}`);
});
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npm test`
Expected: PASS（member requests 8件を含む累計 66 件。既存 member-page 4件も引き続き通ること — 「準備中」文言のテストは Task 6 の一覧で置き換えたため存在しない。※`test/member-page.test.ts` の「準備中」を期待するケースが失敗する場合は、そのケースの期待文言を `'あなたのリクエスト'` に変更してよい（このタスクで唯一許される既存テスト修正）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/routes/member.tsx src/routes/style-css.ts test/member-requests.test.ts test/member-page.test.ts
git commit -m "feat: 会員ページ（月カレンダー・リクエスト送信/キャンセル・一覧・通知配線）"
```

---

### Task 6: 管理画面 — 承認待ちと確定/否認

**Files:**
- Create: `src/routes/admin/requests.tsx`
- Modify: `src/routes/admin.tsx`（import追加・`admin.route('/requests', requests)` 追加・`'/'` の転送先を `/admin/requests` に変更）
- Modify: `src/routes/admin/ui.tsx`（全文差し替え: NAV最終形）
- Modify: `test/admin-auth.test.ts`（`/admin` の転送先アサーションを `/admin/requests` に変更 — 2箇所）
- Test: `test/admin-requests.test.ts`

**Interfaces:**
- Consumes: `confirmRequest`/`declineRequest`（Task 3）、`sendRequestNotification`（Task 4）、`REQUEST_STATUS_LABELS`/`REQUEST_BADGE_CLASSES`（Task 5・member.tsxからimport）、`TYPE_LABELS`/`TYPE_BADGE_CLASSES`（ui.tsx）
- Produces: GET `/admin/requests`（承認待ち一覧） / POST `/admin/requests/:id/confirm` / POST `/admin/requests/:id/decline`（admin_note任意）。`/admin` はログイン後 `/admin/requests` へ転送。NAV最終形: 承認待ち・リクエスト一覧・会員管理・受付停止日・設定（一覧/停止日/設定のページ実体は Task 7〜8 で追加）

- [ ] **Step 1: 失敗するテストを書く**

`test/admin-requests.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../src/index';
import { adminCookie } from './helpers';
import { currentJstDate, addDays } from '../src/core/dates';

async function seedPending(name: string): Promise<{ requestId: number; email: string }> {
  const token = crypto.randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
  const email = `${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`;
  const m = await env.DB.prepare(
    `INSERT INTO members (name, email, member_type, token, is_active, created_at) VALUES (?, ?, 'monthly', ?, 1, '2026-07-23T00:00:00.000Z')`
  ).bind(name, email, token).run();
  const r = await env.DB.prepare(
    `INSERT INTO requests (member_id, date, start_time, end_time, status, member_note, admin_note, created_at, updated_at)
     VALUES (?, ?, '10:00', '13:00', 'pending', '窓side希望', '', '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z')`
  ).bind(m.meta.last_row_id, addDays(currentJstDate(), 5)).run();
  return { requestId: r.meta.last_row_id as number, email };
}

describe('admin requests', () => {
  it('未ログインでは承認待ちにアクセスできない', async () => {
    const res = await app.request('/admin/requests', {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login');
  });

  it('承認待ち一覧に申請が表示される', async () => {
    const cookie = await adminCookie();
    await seedPending('承認待ち会員');
    const res = await app.request('/admin/requests', { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('承認待ち会員');
    expect(html).toContain('窓side希望');
    expect(html).toContain('確定');
    expect(html).toContain('否認');
  });

  it('確定すると状態が変わり会員宛通知が記録される', async () => {
    const cookie = await adminCookie();
    const { requestId, email } = await seedPending('確定対象');
    const res = await app.request(`/admin/requests/${requestId}/confirm`, { method: 'POST', headers: { cookie } }, env);
    expect(res.headers.get('location')).toBe('/admin/requests?ok=confirmed');

    const row = await env.DB.prepare('SELECT status FROM requests WHERE id = ?').bind(requestId).first();
    expect(row!.status).toBe('confirmed');
    const log = await env.DB.prepare('SELECT to_address, type FROM email_log WHERE request_id = ?').bind(requestId).first();
    expect(log!.type).toBe('confirmed');
    expect(log!.to_address).toBe(email);
  });

  it('処理済みをもう一度確定しようとすると stale エラー', async () => {
    const cookie = await adminCookie();
    const { requestId } = await seedPending('二重処理');
    await app.request(`/admin/requests/${requestId}/confirm`, { method: 'POST', headers: { cookie } }, env);
    const res = await app.request(`/admin/requests/${requestId}/confirm`, { method: 'POST', headers: { cookie } }, env);
    expect(res.headers.get('location')).toBe('/admin/requests?error=stale');
  });

  it('否認は理由を保存し会員宛通知が記録される', async () => {
    const cookie = await adminCookie();
    const { requestId } = await seedPending('否認対象');
    const res = await app.request(`/admin/requests/${requestId}/decline`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ admin_note: '満席のため別日をご検討ください' }).toString()
    }, env);
    expect(res.headers.get('location')).toBe('/admin/requests?ok=declined');

    const row = await env.DB.prepare('SELECT status, admin_note FROM requests WHERE id = ?').bind(requestId).first();
    expect(row!.status).toBe('declined');
    expect(row!.admin_note).toBe('満席のため別日をご検討ください');
    const log = await env.DB.prepare('SELECT type FROM email_log WHERE request_id = ?').bind(requestId).first();
    expect(log!.type).toBe('declined');
  });
});
```

`test/admin-auth.test.ts` の修正（既存テストの転送先変更・**この2箇所のみ**）:

「正しいパスワードでログインでき、Cookie付きの /admin は会員管理へ転送される」のケース名とアサーションを変更:

```ts
  it('正しいパスワードでログインでき、Cookie付きの /admin は承認待ちへ転送される', async () => {
    const res = await login('test-password'); // vitest.config.ts の ADMIN_PASSWORD
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin');
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('admin_session=');
    expect(setCookie).toContain('HttpOnly');
    const cookie = setCookie!.split(';')[0];
    const page = await app.request('/admin', { headers: { cookie } }, env);
    // ログイン済みなら /admin/login ではなく承認待ちへ転送される
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/admin/requests');
  });
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（/admin/requests が未実装。admin-auth の転送先ケースも新アサーションで失敗）

- [ ] **Step 3: 実装**

`src/routes/admin/ui.tsx`（全文差し替え・NAV最終形）:

```tsx
import type { Child } from 'hono/jsx';

const NAV_ITEMS: { href: string; label: string }[] = [
  { href: '/admin/requests', label: '承認待ち' },
  { href: '/admin/requests/all', label: 'リクエスト一覧' },
  { href: '/admin/members', label: '会員管理' },
  { href: '/admin/closed', label: '受付停止日' },
  { href: '/admin/settings', label: '設定' }
];

export const Layout = (props: { title: string; active?: string; children: Child }) => (
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
          <a class="brand" href="/admin">
            TORCH<small>MEMBER BOOKING</small>
          </a>
          <nav class="nav">
            {NAV_ITEMS.map((item) => (
              <a href={item.href} class={item.href === props.active ? 'is-active' : undefined}>
                {item.label}
              </a>
            ))}
          </nav>
          <div class="header-actions">
            <form method="post" action="/admin/logout">
              <button class="btn btn-sm btn-onnavy" type="submit">
                ログアウト
              </button>
            </form>
          </div>
        </div>
      </header>
      <main class="page">{props.children}</main>
    </body>
  </html>
);

export const TYPE_LABELS: Record<'monthly' | 'ticket', string> = {
  monthly: '月額会員',
  ticket: '回数券'
};

export const TYPE_BADGE_CLASSES: Record<'monthly' | 'ticket', string> = {
  monthly: 'badge badge-monthly',
  ticket: 'badge badge-ticket'
};
```

`src/routes/admin/requests.tsx`:

```tsx
import { Hono } from 'hono';
import type { Bindings, MemberType, RequestRow } from '../../types';
import { confirmRequest, declineRequest } from '../../core/requests';
import { sendRequestNotification } from '../../core/notify';
import { REQUEST_STATUS_LABELS, REQUEST_BADGE_CLASSES } from '../member';
import { WEEKDAY_LABELS, formatMD } from '../../core/dates';
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

function weekdayOf(date: string): string {
  return WEEKDAY_LABELS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

requests.get('/', async (c) => {
  const okParam = c.req.query('ok');
  const errorParam = c.req.query('error');

  const result = await c.env.DB.prepare(
    `SELECT r.*, m.name AS member_name, m.member_type
     FROM requests r JOIN members m ON m.id = r.member_id
     WHERE r.status = 'pending'
     ORDER BY r.created_at, r.id`
  ).all<RequestWithMember>();
  const rows = result.results;

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
  const id = /^\d+$/.test(idRaw) ? Number(idRaw) : null;
  if (id === null) return c.redirect('/admin/requests?error=invalid');

  const ok = await confirmRequest(c.env.DB, id);
  if (!ok) return c.redirect('/admin/requests?error=stale');

  await sendRequestNotification(c.env.DB, c.env, id, 'confirmed', new URL(c.req.url).origin);
  return c.redirect('/admin/requests?ok=confirmed');
});

requests.post('/:id/decline', async (c) => {
  const idRaw = c.req.param('id');
  const id = /^\d+$/.test(idRaw) ? Number(idRaw) : null;
  const form = await c.req.parseBody();
  const adminNote = typeof form.admin_note === 'string' ? form.admin_note.trim() : '';
  if (id === null || adminNote.length > NOTE_MAX) return c.redirect('/admin/requests?error=invalid');

  const ok = await declineRequest(c.env.DB, id, adminNote);
  if (!ok) return c.redirect('/admin/requests?error=stale');

  await sendRequestNotification(c.env.DB, c.env, id, 'declined', new URL(c.req.url).origin);
  return c.redirect('/admin/requests?ok=declined');
});
```

`src/routes/admin.tsx` の変更（3箇所）:

冒頭の import 群に追加:

```tsx
import { requests } from './admin/requests';
```

認証ミドルウェア直後の `admin.route('/members', members);` の行の直後に追加:

```tsx
admin.route('/requests', requests);
```

`'/'` の転送を変更（既存行の置き換え）:

```tsx
// 変更前:
// admin.get('/', (c) => c.redirect('/admin/members'));
// 変更後（承認待ちが最優先画面。設計書 §5.2）:
admin.get('/', (c) => c.redirect('/admin/requests'));
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（admin requests 5件を含む累計 71 件。admin-auth の修正済みケースも通ること）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/routes/admin/requests.tsx src/routes/admin/ui.tsx src/routes/admin.tsx test/admin-requests.test.ts test/admin-auth.test.ts
git commit -m "feat: 管理画面の承認待ち（確定/否認・会員宛メール通知・NAV最終形）"
```

---

### Task 7: 管理画面 — リクエスト一覧・絞り込み

**Files:**
- Modify: `src/routes/admin/requests.tsx`（`/all` ルートを追加）
- Test: `test/admin-requests-list.test.ts`

**Interfaces:**
- Consumes: Task 6 の `requests` サブアプリと `RequestWithMember`
- Produces: GET `/admin/requests/all?status=&member_id=&from=&to=` — 全状態の一覧（新しい順・最大200件）と絞り込みフォーム

- [ ] **Step 1: 失敗するテストを書く**

`test/admin-requests-list.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../src/index';
import { adminCookie } from './helpers';

async function seedMemberWithRequests(name: string, rows: { date: string; status: string }[]): Promise<number> {
  const token = crypto.randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
  const m = await env.DB.prepare(
    `INSERT INTO members (name, email, member_type, token, is_active, created_at) VALUES (?, ?, 'ticket', ?, 1, '2026-07-23T00:00:00.000Z')`
  ).bind(name, `${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`, token).run();
  const memberId = m.meta.last_row_id as number;
  for (const r of rows) {
    await env.DB.prepare(
      `INSERT INTO requests (member_id, date, start_time, end_time, status, member_note, admin_note, created_at, updated_at)
       VALUES (?, ?, '10:00', '13:00', ?, '', '', '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z')`
    ).bind(memberId, r.date, r.status).run();
  }
  return memberId;
}

describe('admin requests list', () => {
  it('一覧は全状態を表示する', async () => {
    const cookie = await adminCookie();
    await seedMemberWithRequests('一覧会員', [
      { date: '2026-09-01', status: 'pending' },
      { date: '2026-09-02', status: 'confirmed' },
      { date: '2026-09-03', status: 'declined' }
    ]);
    const res = await app.request('/admin/requests/all', { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('一覧会員');
    expect(html).toContain('申請中');
    expect(html).toContain('確定');
    expect(html).toContain('否認');
  });

  it('状態で絞り込める', async () => {
    const cookie = await adminCookie();
    await seedMemberWithRequests('状態絞込', [
      { date: '2026-09-04', status: 'confirmed' },
      { date: '2026-09-05', status: 'cancelled' }
    ]);
    const res = await app.request('/admin/requests/all?status=cancelled', { headers: { cookie } }, env);
    const html = await res.text();
    expect(html).toContain('9/5');
    expect(html).not.toContain('9/4');
  });

  it('会員と期間で絞り込める', async () => {
    const cookie = await adminCookie();
    const idA = await seedMemberWithRequests('会員甲', [{ date: '2026-09-10', status: 'pending' }]);
    await seedMemberWithRequests('会員乙', [{ date: '2026-09-11', status: 'pending' }]);

    const byMember = await app.request(`/admin/requests/all?member_id=${idA}`, { headers: { cookie } }, env);
    const htmlA = await byMember.text();
    expect(htmlA).toContain('会員甲');
    expect(htmlA).not.toContain('会員乙');

    const byRange = await app.request('/admin/requests/all?from=2026-09-11&to=2026-09-11', { headers: { cookie } }, env);
    const htmlB = await byRange.text();
    expect(htmlB).toContain('9/11');
    expect(htmlB).not.toContain('9/10');
  });

  it('不正なパラメータは無視して全件表示する', async () => {
    const cookie = await adminCookie();
    const res = await app.request('/admin/requests/all?status=bogus&from=notadate&member_id=x', { headers: { cookie } }, env);
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（/admin/requests/all が404）

- [ ] **Step 3: 実装 — requests.tsx に /all を追加**

`src/routes/admin/requests.tsx` の変更（2箇所）:

冒頭の import に追加（`REQUEST_STATUS_LABELS` の行を次のとおり拡張・`MemberRow` を types importに追加）:

```tsx
import type { Bindings, MemberType, MemberRow, RequestRow } from '../../types';
```

ファイル末尾（`requests.post('/:id/decline', ...)` の後）に追加:

```tsx
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

**注意:** ルート登録順の都合で、`/all` は `/:id/confirm` 等より**後に追加してよい**（HonoはGET `/all` とPOST `/:id/confirm` をメソッドとパスで区別できる。GET `/all` が `GET /:id/...` に飲み込まれるルートは存在しない）。

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（admin requests list 4件を含む累計 75 件）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/routes/admin/requests.tsx test/admin-requests-list.test.ts
git commit -m "feat: リクエスト一覧（状態・会員・期間の絞り込み）"
```

---

### Task 8: 管理画面 — 受付停止日と設定

**Files:**
- Create: `src/routes/admin/closed.tsx`
- Create: `src/routes/admin/settings.tsx`
- Modify: `src/routes/admin.tsx`（import 2行と route 2行を追加）
- Test: `test/admin-closed-settings.test.ts`

**Interfaces:**
- Consumes: `setSetting`/`getSettings`/`parseSlotsText`/`slotsToText`（Task 2）、`DATE_RE`（dates.ts）
- Produces:
  - GET/POST `/admin/closed` — 受付停止日の一覧（今日以降・昇順）・追加（date+reason、同日upsert）・削除（POST `/admin/closed/:date/delete`）
  - GET/POST `/admin/settings` — スタッフ通知先メール・受付可能期間（1〜365日）・時間枠テンプレート（1行1枠）の表示と保存

- [ ] **Step 1: 失敗するテストを書く**

`test/admin-closed-settings.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../src/index';
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
  it('設定画面に現在値が表示される', async () => {
    const cookie = await adminCookie();
    const res = await app.request('/admin/settings', { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('10:00-13:00');
    expect(html).toContain('60');
  });

  it('設定を保存できる', async () => {
    const cookie = await adminCookie();
    const res = await app.request('/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({
        staff_email: 'staff@example.com',
        window_days: '30',
        slots_text: '09:00-12:00\n13:00-18:00'
      }).toString()
    }, env);
    expect(res.headers.get('location')).toBe('/admin/settings?ok=saved');

    const s = await getSettings(env.DB);
    expect(s.staffEmail).toBe('staff@example.com');
    expect(s.windowDays).toBe(30);
    expect(s.slots).toEqual([
      { start: '09:00', end: '12:00' },
      { start: '13:00', end: '18:00' }
    ]);
  });

  it('スタッフメールは空でも保存できる（通知スキップ運用）', async () => {
    const cookie = await adminCookie();
    const res = await app.request('/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ staff_email: '', window_days: '60', slots_text: '10:00-13:00' }).toString()
    }, env);
    expect(res.headers.get('location')).toBe('/admin/settings?ok=saved');
  });

  it('不正な時間枠・期間・メール形式は invalid で保存されない', async () => {
    const cookie = await adminCookie();
    const before = await getSettings(env.DB);

    const badSlots = await app.request('/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ staff_email: '', window_days: '60', slots_text: '25:00-26:00' }).toString()
    }, env);
    expect(badSlots.headers.get('location')).toBe('/admin/settings?error=invalid');

    const badDays = await app.request('/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ staff_email: '', window_days: '0', slots_text: '10:00-13:00' }).toString()
    }, env);
    expect(badDays.headers.get('location')).toBe('/admin/settings?error=invalid');

    const badEmail = await app.request('/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ staff_email: 'not-an-email', window_days: '60', slots_text: '10:00-13:00' }).toString()
    }, env);
    expect(badEmail.headers.get('location')).toBe('/admin/settings?error=invalid');

    const after = await getSettings(env.DB);
    expect(after).toEqual(before); // 何も変わっていない
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（/admin/closed と /admin/settings が404）

- [ ] **Step 3: 実装**

`src/routes/admin/closed.tsx`:

```tsx
import { Hono } from 'hono';
import type { Bindings } from '../../types';
import { DATE_RE, currentJstDate, formatMD, WEEKDAY_LABELS } from '../../core/dates';
import { Layout } from './ui';

export const closed = new Hono<{ Bindings: Bindings }>();

const OK_MESSAGES: Record<string, string> = {
  saved: '受付停止日を保存しました',
  deleted: '受付停止日を解除しました'
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid: '日付の形式が正しくありません'
};

closed.get('/', async (c) => {
  const okParam = c.req.query('ok');
  const errorParam = c.req.query('error');
  const today = currentJstDate();

  const result = await c.env.DB.prepare('SELECT date, reason FROM closed_dates WHERE date >= ? ORDER BY date')
    .bind(today).all<{ date: string; reason: string }>();
  const rows = result.results;

  return c.html(
    <Layout title="受付停止日 | TORCH 会員予約" active="/admin/closed">
      <div class="page-head">
        <span class="eyebrow">Closed Dates</span>
        <h1>受付停止日</h1>
        <span class="sub muted">指定した日は会員のカレンダーで選択できなくなります（今日以降の分を表示）</span>
      </div>
      {okParam && OK_MESSAGES[okParam] && <p class="msg-ok">{OK_MESSAGES[okParam]}</p>}
      {errorParam && ERROR_MESSAGES[errorParam] && <p class="msg-error">{ERROR_MESSAGES[errorParam]}</p>}

      <form class="card card-pad" method="post" action="/admin/closed">
        <div class="form-grid">
          <div class="field">
            <label>日付</label>
            <input type="date" name="date" required />
          </div>
          <div class="field">
            <label>理由（任意・会員には表示されません）</label>
            <input type="text" name="reason" maxlength={200} />
          </div>
          <button class="btn btn-primary" type="submit">
            停止日にする
          </button>
        </div>
      </form>

      {rows.length === 0 ? (
        <p class="muted" style="margin-top:16px">
          受付停止日はありません。
        </p>
      ) : (
        <div class="tbl-wrap" style="margin-top:16px">
          <table class="tbl">
            <thead>
              <tr>
                <th>日付</th>
                <th>理由</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr>
                  <td class="req-when">
                    {formatMD(r.date)}（{WEEKDAY_LABELS[new Date(`${r.date}T00:00:00Z`).getUTCDay()]}）
                  </td>
                  <td class="small">{r.reason}</td>
                  <td class="actions">
                    <form method="post" action={`/admin/closed/${r.date}/delete`}>
                      <button class="btn btn-sm" type="submit">
                        解除
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

closed.post('/', async (c) => {
  const form = await c.req.parseBody();
  const date = typeof form.date === 'string' ? form.date : '';
  const reason = typeof form.reason === 'string' ? form.reason.trim().slice(0, 200) : '';

  if (!DATE_RE.test(date)) return c.redirect('/admin/closed?error=invalid');

  await c.env.DB.prepare('INSERT OR REPLACE INTO closed_dates (date, reason) VALUES (?, ?)').bind(date, reason).run();
  return c.redirect('/admin/closed?ok=saved');
});

closed.post('/:date/delete', async (c) => {
  const date = c.req.param('date');
  if (!DATE_RE.test(date)) return c.redirect('/admin/closed?error=invalid');

  await c.env.DB.prepare('DELETE FROM closed_dates WHERE date = ?').bind(date).run();
  return c.redirect('/admin/closed?ok=deleted');
});
```

`src/routes/admin/settings.tsx`:

```tsx
import { Hono } from 'hono';
import type { Bindings } from '../../types';
import { getSettings, setSetting, parseSlotsText, slotsToText } from '../../core/settings';
import { Layout } from './ui';

export const settingsPage = new Hono<{ Bindings: Bindings }>();

const OK_MESSAGES: Record<string, string> = {
  saved: '設定を保存しました'
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid: '入力内容に誤りがあります（メール形式・受付期間1〜365日・時間枠の形式を確認してください）'
};

function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

settingsPage.get('/', async (c) => {
  const okParam = c.req.query('ok');
  const errorParam = c.req.query('error');
  const s = await getSettings(c.env.DB);

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
        <button class="btn btn-primary btn-lg" type="submit">
          保存
        </button>
        <p class="muted small" style="margin:12px 0 0">
          メールの差出人アドレスとResendのAPIキーはサーバー側の環境変数（RESEND_API_KEY / NOTIFY_EMAIL_FROM）で設定します。
        </p>
      </form>
    </Layout>
  );
});

settingsPage.post('/', async (c) => {
  const form = await c.req.parseBody();
  const staffEmail = typeof form.staff_email === 'string' ? form.staff_email.trim() : '';
  const windowDaysRaw = typeof form.window_days === 'string' ? form.window_days.trim() : '';
  const slotsText = typeof form.slots_text === 'string' ? form.slots_text : '';

  const windowDays = Number(windowDaysRaw);
  const slots = parseSlotsText(slotsText);

  if (
    (staffEmail !== '' && !isValidEmail(staffEmail)) ||
    !Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365 ||
    slots === null
  ) {
    return c.redirect('/admin/settings?error=invalid');
  }

  await setSetting(c.env.DB, 'staff_email', staffEmail);
  await setSetting(c.env.DB, 'window_days', String(windowDays));
  await setSetting(c.env.DB, 'slots', JSON.stringify(slots));
  return c.redirect('/admin/settings?ok=saved');
});
```

`src/routes/admin.tsx` の変更（import 2行・route 2行を追加）:

```tsx
import { closed } from './admin/closed';
import { settingsPage } from './admin/settings';
```

`admin.route('/requests', requests);` の直後に追加:

```tsx
admin.route('/closed', closed);
admin.route('/settings', settingsPage);
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（closed 2件＋settings 4件を含む累計 81 件）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/routes/admin/closed.tsx src/routes/admin/settings.tsx src/routes/admin.tsx test/admin-closed-settings.test.ts
git commit -m "feat: 受付停止日と設定（通知先メール・受付期間・時間枠テンプレート）"
```

---

### Task 9: ハードニングと仕上げ

**Files:**
- Create: `src/auth/loginRateLimit.ts`
- Modify: `src/routes/admin.tsx`（ログインPOSTに試行制限を組み込み）
- Modify: `src/index.ts`（全文差し替え: robots.txt 追加）
- Modify: `src/routes/admin/members.tsx`（POST `/:id` と `/:id/reissue` の0行更新を notfound エラーに）
- Modify: `test/admin-auth.test.ts`（Cookie属性とログアウトlocationのアサーション追加 — 明示2箇所）
- Modify: `README.md`（全文差し替え）
- Test: `test/hardening.test.ts`

**Interfaces:**
- Consumes: `login_failures` テーブル（Task 1）、既存 admin.tsx / members.tsx / index.ts
- Produces:
  - `loginRateLimit.ts`: `MAX_FAILURES = 10` / `WINDOW_MS = 15 * 60_000` / `tooManyFailures(db, ip): Promise<boolean>` / `recordFailure(db, ip): Promise<void>` / `clearFailures(db, ip): Promise<void>`
  - `/robots.txt` が `Disallow: /` を返す
  - ログイン失敗が15分間に10回に達したIPは 429 を受ける（成功でリセット）
  - 会員管理のPOST更新/再発行は存在しないIDに `error=notfound` を返す

- [ ] **Step 1: 失敗するテストを書く**

`test/hardening.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../src/index';
import { adminCookie } from './helpers';

function loginAs(ip: string, password: string): Promise<Response> {
  return app.request('/admin/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'CF-Connecting-IP': ip
    },
    body: new URLSearchParams({ password }).toString()
  }, env);
}

describe('hardening', () => {
  it('robots.txt は全クロールを拒否する', async () => {
    const res = await app.request('/robots.txt', {}, env);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('User-agent: *');
    expect(text).toContain('Disallow: /');
  });

  it('ログイン失敗が10回に達すると429になり、正しいパスワードでも弾かれる', async () => {
    const ip = '203.0.113.10';
    for (let i = 0; i < 9; i++) {
      expect((await loginAs(ip, 'wrong')).status).toBe(401);
    }
    expect((await loginAs(ip, 'wrong')).status).toBe(401); // 10回目の失敗
    const blocked = await loginAs(ip, 'test-password');
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain('しばらくしてから');
  });

  it('別IPには影響せず、ログイン成功で失敗履歴はリセットされる', async () => {
    const ip = '203.0.113.20';
    for (let i = 0; i < 3; i++) await loginAs(ip, 'wrong');
    const ok = await loginAs(ip, 'test-password');
    expect(ok.status).toBe(302);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE ip = ?').bind(ip).first<{ n: number }>();
    expect(count!.n).toBe(0);

    const other = await loginAs('203.0.113.21', 'test-password');
    expect(other.status).toBe(302);
  });

  it('存在しない会員IDの更新・再発行は notfound エラー', async () => {
    const cookie = await adminCookie();
    const upd = await app.request('/admin/members/999999', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ name: '誰か', email: 'x@example.com', member_type: 'monthly' }).toString()
    }, env);
    expect(upd.headers.get('location')).toBe('/admin/members?error=notfound');

    const re = await app.request('/admin/members/999999/reissue', { method: 'POST', headers: { cookie } }, env);
    expect(re.headers.get('location')).toBe('/admin/members?error=notfound');
  });
});
```

`test/admin-auth.test.ts` の補強（**この2箇所のみ**）:

「正しいパスワードでログインでき…」のケースの `expect(setCookie).toContain('HttpOnly');` の直後に3行追加:

```ts
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=2592000'); // 30日
```

「ログアウトするとCookieが無効化される」のケースの `expect(out.status).toBe(302);` の直後に1行追加:

```ts
    expect(out.headers.get('location')).toBe('/admin/login');
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（robots.txt 404・429にならない・notfound にならない）

- [ ] **Step 3: 実装**

`src/auth/loginRateLimit.ts`:

```ts
export const MAX_FAILURES = 10;
export const WINDOW_MS = 15 * 60_000; // 15分

export async function tooManyFailures(db: D1Database, ip: string): Promise<boolean> {
  const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();
  const row = await db.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND created_at >= ?')
    .bind(ip, windowStart).first<{ n: number }>();
  return (row?.n ?? 0) >= MAX_FAILURES;
}

export async function recordFailure(db: D1Database, ip: string): Promise<void> {
  await db.prepare('INSERT INTO login_failures (ip, created_at) VALUES (?, ?)')
    .bind(ip, new Date().toISOString()).run();
}

export async function clearFailures(db: D1Database, ip: string): Promise<void> {
  await db.prepare('DELETE FROM login_failures WHERE ip = ?').bind(ip).run();
}
```

`src/routes/admin.tsx` の変更（2箇所）:

冒頭の import 群に追加:

```tsx
import { tooManyFailures, recordFailure, clearFailures } from '../auth/loginRateLimit';
```

`admin.post('/login', ...)` を次の内容に置き換え:

```tsx
admin.post('/login', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  if (await tooManyFailures(c.env.DB, ip)) {
    return c.html(<LoginPage error="試行回数が多すぎます。しばらくしてからお試しください" />, 429);
  }
  const form = await c.req.parseBody();
  const password = typeof form.password === 'string' ? form.password : '';
  if (!(await passwordMatches(c.env.SESSION_SECRET, password, c.env.ADMIN_PASSWORD))) {
    await recordFailure(c.env.DB, ip);
    return c.html(<LoginPage error="パスワードが違います" />, 401);
  }
  await clearFailures(c.env.DB, ip);
  const token = await signSession(c.env.SESSION_SECRET, Date.now() + SESSION_TTL_MS);
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000
  });
  return c.redirect('/admin');
});
```

`src/index.ts`（全文差し替え）:

```ts
import { Hono } from 'hono';
import { admin } from './routes/admin';
import { member } from './routes/member';
import { STYLE_CSS } from './routes/style-css';
import type { Bindings } from './types';

const app = new Hono<{ Bindings: Bindings }>();

app.get('/health', (c) => c.json({ ok: true }));
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));
app.get('/style.css', (c) => {
  c.header('content-type', 'text/css; charset=utf-8');
  c.header('cache-control', 'public, max-age=3600');
  return c.body(STYLE_CSS);
});
app.route('/admin', admin);
app.route('/m', member);

export default app;
```

`src/routes/admin/members.tsx` の変更（3箇所）:

`ERROR_MESSAGES` に1行追加:

```tsx
const ERROR_MESSAGES: Record<string, string> = {
  invalid: '入力内容に誤りがあります（名前・正しいメールアドレス・種別が必要です）',
  notfound: '対象の会員が見つかりません'
};
```

`members.post('/:id', ...)` の `UPDATE` 実行部分を、結果を確認する形に置き換え:

```tsx
  const res = await c.env.DB.prepare(
    `UPDATE members SET name = ?, email = ?, member_type = ?, is_active = ? WHERE id = ?`
  )
    .bind(name, email, memberType, isActive, id)
    .run();
  if (res.meta.changes === 0) return c.redirect('/admin/members?error=notfound');

  return c.redirect('/admin/members?ok=updated');
```

`members.post('/:id/reissue', ...)` の `UPDATE` 実行部分を同様に置き換え:

```tsx
  const res = await c.env.DB.prepare(`UPDATE members SET token = ? WHERE id = ?`).bind(newMemberToken(), id).run();
  if (res.meta.changes === 0) return c.redirect('/admin/members?error=notfound');

  return c.redirect('/admin/members?ok=reissued');
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（hardening 4件を含む累計 85 件。admin-auth の補強アサーションも通ること）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5: README を完成させる**

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
```

- [ ] **Step 6: 最終確認とコミット**

Run: `npm test`
Expected: PASS（85件）

Run: `npm run typecheck`
Expected: エラーなし

```bash
git add src test README.md
git commit -m "feat: ハードニング（robots.txt・ログイン試行制限・Cookie属性テスト・会員更新のnotfound）とREADME"
```

---

## 動作確認手順（ステップ②完了後、福田さん向けデモ）

```bash
npm run dev
```

1. http://localhost:8787/admin にログイン → 「承認待ち」がトップに出る
2. 設定 → スタッフ通知先メール・時間枠を確認（Resend未設定でも動作する。メールは送られず記録のみ）
3. 会員管理 → 会員の専用リンクをコピーして別タブで開く
4. カレンダーで日付を選ぶ → 時間枠を選んでリクエスト送信
5. 管理画面の承認待ちに表示される → 「確定」を押す
6. 会員ページを再読み込み → 状態が「確定」になっている
7. 会員ページからキャンセル → 管理画面のリクエスト一覧で「キャンセル済み」を確認
8. 受付停止日に明日を追加 → 会員カレンダーで「停」表示になり選べないことを確認

## 補足（実装者向け）

- Resend の実送信はステップ②のコードでは RESEND_API_KEY が設定されている場合のみ発生する。ローカル検証では未設定のまま email_log の記録で確認する
- `requests.tsx` は member.tsx から `REQUEST_STATUS_LABELS` / `REQUEST_BADGE_CLASSES` を import する（ラベル定義の二重化を避けるため）。循環importにはならない（member.tsx は admin 配下を import するが requests.tsx は member.tsx のみ参照…ではなく、member.tsx が `./admin/ui` を、requests.tsx が `../member` を参照する一方向×2本で循環しない）
- テストは実行日に依存しないよう、利用日は常に `addDays(currentJstDate(), n)` で生成する（Task 5・6）。固定日付を使うのは過去日不要のテーブル直INSERT（Task 1・3・7・8）のみ
