# メール文面テンプレート編集 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理画面でメール5種（requested/requested_member/cancelled/confirmed/declined）の件名・本文を編集できるようにする（設計書 §19）。空欄なら現行の標準文面のまま。

**Architecture:** 新モジュール `src/core/mailTemplates.ts` にテンプレート型・標準文面プレビュー・取得/置換関数を置き、`notify.ts` は標準文面を組み立てた後にカスタムテンプレートがあれば差し替える（読込失敗時は標準文面で続行＝非例外化不変）。保存先は settings テーブルの `mail_tpl_<type>_subject|body`（10キー）。管理画面は新ページ `/admin/mail`。

**Tech Stack:** 既存と同一（Hono / D1 / vitest）。新規依存なし。migration 不要（settings は key-value なので列追加不要）。

## Global Constraints

- 設計書: `docs/superpowers/specs/2026-07-23-torch-member-booking-design.md` の **§19** がスコープの正。§19以外の機能は作らない
- 作業ディレクトリ: `/Users/daisukefukuda/Projects/coworkingspace_booking_webapp/`
- **メールは絶対に例外を投げない**。テンプレート読込・置換に失敗しても標準文面で送信を続行する
- **カスタム未設定（空欄）時の送信内容は現行と1文字も変わらない**こと（既存 notify.test.ts の9件は無変更で通す。追記のみ）
- 差し込みタグは `{会員名}` `{会員種別}` `{日時}` `{会員メモ}` `{スタッフメモ}` `{管理画面リンク}` の6種。未知のタグはそのまま出力
- `{管理画面リンク}` は cancelled のみ `{linkBase}/admin/requests/all`、他は `{linkBase}/admin/requests`
- 検証: 件名200字以内・本文4000字以内（超過は error=invalid・保存しない）。保存値は trim する
- sync_stale はテンプレート対象外（sendSyncStaleNotification は変更しない）
- 既存テストの改変は notify.test.ts への**追記のみ**（既存9ケースは1文字も変えない）。他の既存テストは変更しない
- UI文言は日本語・丁寧語。コミットは feat:/fix:/chore: プレフィックス＋日本語
- 各タスク完了時: `npm test` と `npm run typecheck` 全通過後にコミット

### テスト件数の見通し（現状139件起点）

| Task | 変更 | 増減 | 累計 |
|---|---|---:|---:|
| 1 | `mail-templates.test.ts` 新規(+3)／`notify.test.ts` +2 | **+5** | **144** |
| 2 | `admin-mail.test.ts` 新規(+4) | **+4** | **148** |

---

### Task 1: テンプレートコア（mailTemplates.ts）と notify.ts への組み込み

**Files:**
- Create: `src/core/mailTemplates.ts`
- Modify: `src/core/settings.ts`（`SettingKey` に `mail_tpl_*` を追加。他は変更しない）
- Modify: `src/core/notify.ts`（全文差し替え: カスタムテンプレート差し替えブロックを追加）
- Test: `test/mail-templates.test.ts`（新規・3件）
- Test: `test/notify.test.ts`（末尾に2件追記して11件。既存9件は無変更）

**Interfaces:**
- Produces:
  - `MAIL_TEMPLATE_TYPES: readonly ['requested','requested_member','cancelled','confirmed','declined']` / `MailTemplateType`
  - `MailTemplate { subject: string; body: string }`（`''` = 未設定）
  - `MAIL_TYPE_LABELS: Record<MailTemplateType, string>`（画面表示用の日本語ラベル）
  - `DEFAULT_MAIL_PREVIEWS: Record<MailTemplateType, MailTemplate>`（編集画面のplaceholder用・タグ表記の標準文面）
  - `getMailTemplates(db): Promise<Record<MailTemplateType, MailTemplate>>`
  - `renderTemplate(text, vars): string`
  - `SettingKey` に `` `mail_tpl_${...}_${'subject'|'body'}` `` が加わる（Task 2 の保存で使う）

- [ ] **Step 1: 失敗するテストを書く**

`test/mail-templates.test.ts`（新規・3件）:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getMailTemplates, renderTemplate, MAIL_TEMPLATE_TYPES } from '../src/core/mailTemplates';
import { saveSettings } from '../src/core/settings';

describe('mail templates', () => {
  it('renderTemplate はタグを置換し、同一タグ複数回もすべて置換し、未知タグはそのまま残す', () => {
    const out = renderTemplate('{会員名}様 {日時} / {会員名} / {未知タグ}', {
      '会員名': '山田',
      '日時': '2026-08-01 10:00〜13:00'
    });
    expect(out).toBe('山田様 2026-08-01 10:00〜13:00 / 山田 / {未知タグ}');
  });

  it('getMailTemplates は未設定なら全種とも空文字を返す', async () => {
    const t = await getMailTemplates(env.DB);
    for (const type of MAIL_TEMPLATE_TYPES) {
      expect(t[type]).toEqual({ subject: '', body: '' });
    }
  });

  it('保存したテンプレートを種類ごとに読み出せる', async () => {
    await saveSettings(env.DB, [
      { key: 'mail_tpl_confirmed_subject', value: '確定: {日時}' },
      { key: 'mail_tpl_confirmed_body', value: '{会員名}様、確定です' },
      { key: 'mail_tpl_requested_member_subject', value: '受付: {日時}' }
    ]);
    const t = await getMailTemplates(env.DB);
    expect(t.confirmed).toEqual({ subject: '確定: {日時}', body: '{会員名}様、確定です' });
    expect(t.requested_member).toEqual({ subject: '受付: {日時}', body: '' });
    expect(t.declined).toEqual({ subject: '', body: '' }); // 他の種類は影響なし
  });
});
```

`test/notify.test.ts`（既存9件の**末尾**に以下2件を追記して11件。既存部分は1文字も変えない）:

```ts
  it('カスタムテンプレートがあれば件名・本文をタグ置換して送る', async () => {
    const id = await seedRequest();
    await env.DB.prepare(`UPDATE requests SET admin_note = 'お待ちしています' WHERE id = ?`).bind(id).run();
    await setSetting(env.DB, 'mail_tpl_confirmed_subject', '確定です {日時}');
    await setSetting(env.DB, 'mail_tpl_confirmed_body', '{会員名}様（{会員種別}） {スタッフメモ} メモ:{会員メモ}');
    const calls: { init: RequestInit }[] = [];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ init: init! });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await sendRequestNotification(env.DB, { RESEND_API_KEY: 'key' }, id, 'confirmed', 'http://localhost:8787', fetcher);

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.subject).toBe('確定です 2026-08-01 10:00〜13:00');
    expect(body.text).toBe('通知会員様（回数券） お待ちしています メモ:メモです');
    expect((await lastLog())!.status).toBe('sent');
  });

  it('テンプレートが空欄の種類は標準文面のまま送る', async () => {
    const id = await seedRequest();
    await setSetting(env.DB, 'mail_tpl_confirmed_subject', '   '); // 空白のみ = 未設定扱い
    await setSetting(env.DB, 'mail_tpl_requested_member_subject', 'カスタム受付');
    const calls: { init: RequestInit }[] = [];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ init: init! });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    // confirmed は空白のみ → 標準の件名
    await sendRequestNotification(env.DB, { RESEND_API_KEY: 'key' }, id, 'confirmed', 'http://localhost:8787', fetcher);
    expect(JSON.parse(String(calls[0].init.body)).subject).toContain('ご利用リクエスト確定');

    // requested_member は件名だけカスタム・本文は標準
    await sendRequestNotification(env.DB, { RESEND_API_KEY: 'key' }, id, 'requested_member', 'http://localhost:8787', fetcher);
    const second = JSON.parse(String(calls[1].init.body));
    expect(second.subject).toBe('カスタム受付');
    expect(second.text).toContain('受け付けました'); // 本文は標準のまま
  });
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（`../src/core/mailTemplates` が存在しない／`mail_tpl_*` が `SettingKey` に無く typecheck も失敗／カスタム件名が反映されない）

- [ ] **Step 3: 実装する**

`src/core/mailTemplates.ts`（新規）:

```ts
// メール文面テンプレート（§19）。settings テーブルの mail_tpl_* キーに保存する。
// 空文字 = 未設定 = 標準文面（notify.ts 内蔵）を使う。

export const MAIL_TEMPLATE_TYPES = ['requested', 'requested_member', 'cancelled', 'confirmed', 'declined'] as const;
export type MailTemplateType = (typeof MAIL_TEMPLATE_TYPES)[number];

export interface MailTemplate {
  subject: string; // '' = 未設定
  body: string;    // '' = 未設定
}

export const MAIL_TYPE_LABELS: Record<MailTemplateType, string> = {
  requested: '新しいリクエスト（スタッフ宛）',
  requested_member: '受付確認（会員宛）',
  cancelled: 'キャンセル通知（スタッフ宛）',
  confirmed: '確定のお知らせ（会員宛）',
  declined: '否認のお知らせ（会員宛）'
};

// 編集画面に薄く表示する標準文面（タグ表記）。実際の標準文面は notify.ts が組み立てる
// （メモ等が空のとき行ごと省く挙動があるため、ここは表示用の参考テキスト）。
export const DEFAULT_MAIL_PREVIEWS: Record<MailTemplateType, MailTemplate> = {
  requested: {
    subject: '【TORCH 会員予約】新しい利用リクエスト: {日時} {会員名}様',
    body: '新しい利用リクエストが届きました。\n\n会員: {会員名}様（{会員種別}）\n日時: {日時}\nメモ: {会員メモ}\n\n管理画面で確定/否認してください: {管理画面リンク}'
  },
  requested_member: {
    subject: '【TORCH】リクエストを受け付けました: {日時}',
    body: '{会員名}様\n\n以下のご利用リクエストを受け付けました。スタッフが確認のうえ、確定/否認の結果を追ってメールでお知らせします。\n\n日時: {日時}\nメモ: {会員メモ}\n\n変更やキャンセルはご自身の専用ページ、またはLINEでご連絡ください。'
  },
  cancelled: {
    subject: '【TORCH 会員予約】キャンセル: {日時} {会員名}様',
    body: '会員がリクエストをキャンセルしました。\n\n会員: {会員名}様（{会員種別}）\n日時: {日時}\n\n一覧: {管理画面リンク}'
  },
  confirmed: {
    subject: '【TORCH】ご利用リクエスト確定: {日時}',
    body: '{会員名}様\n\n以下のご利用リクエストが確定しました。当日のご来館をお待ちしております。\n\n日時: {日時}\nスタッフより: {スタッフメモ}\n\n変更やキャンセルはご自身の専用ページ、またはLINEでご連絡ください。'
  },
  declined: {
    subject: '【TORCH】ご利用リクエストについて: {日時}',
    body: '{会員名}様\n\n申し訳ありません。以下のご利用リクエストは確定できませんでした。\n\n日時: {日時}\n理由: {スタッフメモ}\n\n別の日時でのリクエストをご検討ください。ご不明な点はLINEでお気軽にご連絡ください。'
  }
};

// 保存済みテンプレートを読み出す。行が無いキーは '' で返す。
export async function getMailTemplates(db: D1Database): Promise<Record<MailTemplateType, MailTemplate>> {
  const result = await db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'mail_tpl_%'`)
    .all<{ key: string; value: string }>();
  const map = new Map(result.results.map((r) => [r.key, r.value]));
  const out = {} as Record<MailTemplateType, MailTemplate>;
  for (const t of MAIL_TEMPLATE_TYPES) {
    out[t] = {
      subject: map.get(`mail_tpl_${t}_subject`) ?? '',
      body: map.get(`mail_tpl_${t}_body`) ?? ''
    };
  }
  return out;
}

// {タグ} を実際の値に置換する。未知のタグはそのまま残す（送信は失敗させない）。
export function renderTemplate(text: string, vars: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, v);
  }
  return out;
}
```

`src/core/settings.ts` の変更（`SettingKey` の定義だけを以下に差し替える。他の行は変更しない）:

```ts
export type SettingKey =
  | 'open_start'
  | 'open_end'
  | 'window_days'
  | 'staff_email'
  | 'square_location_id'
  | 'square_service_variation_id'
  | `mail_tpl_${'requested' | 'requested_member' | 'cancelled' | 'confirmed' | 'declined'}_${'subject' | 'body'}`;
```

`src/core/notify.ts`（全文差し替え）:

```ts
import { getSettings } from './settings';
import { getMailTemplates, renderTemplate, MAIL_TEMPLATE_TYPES } from './mailTemplates';
import type { MailTemplateType } from './mailTemplates';

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

    let text = lines.filter((line) => line !== '').join('\n');

    // §19: 管理画面で編集されたテンプレートがあれば件名・本文を差し替える。
    // 読込や置換に失敗しても標準文面で続行する（メールは絶対に例外を投げない）。
    try {
      if ((MAIL_TEMPLATE_TYPES as readonly string[]).includes(type)) {
        const templates = await getMailTemplates(db);
        const tpl = templates[type as MailTemplateType];
        const vars: Record<string, string> = {
          '会員名': r.member_name,
          '会員種別': typeLabel,
          '日時': when,
          '会員メモ': r.member_note,
          'スタッフメモ': r.admin_note,
          '管理画面リンク': `${linkBase}${type === 'cancelled' ? '/admin/requests/all' : '/admin/requests'}`
        };
        if (tpl.subject.trim() !== '') subject = renderTemplate(tpl.subject, vars);
        if (tpl.body.trim() !== '') text = renderTemplate(tpl.body, vars);
      }
    } catch {
      // テンプレートが読めなくても標準文面のまま送る
    }

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
// §19対象外: システム通知のため文面は固定。
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

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（累計 **144件**。notify 11件・mail-templates 3件。既存 notify 9件は無変更で通ること）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/core/mailTemplates.ts src/core/settings.ts src/core/notify.ts test/mail-templates.test.ts test/notify.test.ts
git commit -m "feat: メール文面テンプレートのコア（mail_tpl_*設定・タグ置換・notify組み込み）を追加"
```

---

### Task 2: 管理画面「メール文面」ページ（/admin/mail）

**Files:**
- Create: `src/routes/admin/mail.tsx`
- Modify: `src/routes/admin/ui.tsx`（NAV_ITEMS に「メール文面」を追加。他は変更しない）
- Modify: `src/routes/admin.tsx`（mailPage の import と route 登録を追加。他は変更しない）
- Test: `test/admin-mail.test.ts`（新規・4件）

**Interfaces:**
- Consumes: Task 1 の `MAIL_TEMPLATE_TYPES` / `MAIL_TYPE_LABELS` / `DEFAULT_MAIL_PREVIEWS` / `getMailTemplates`、`saveSettings`（`SettingKey` は Task 1 で拡張済み）
- Produces: GET/POST `/admin/mail`（認証配下）。フォームフィールド名は `${type}_subject` / `${type}_body`（例 `confirmed_subject`）

- [ ] **Step 1: 失敗するテストを書く**

`test/admin-mail.test.ts`（新規・4件）:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { adminCookie } from './helpers';
import { getMailTemplates } from '../src/core/mailTemplates';

async function post(cookie: string, body: Record<string, string>): Promise<Response> {
  return app.request('/admin/mail', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(body).toString()
  }, env);
}

describe('admin mail templates page', () => {
  it('編集画面に5種のラベルと差し込みタグの説明が表示される', async () => {
    const cookie = await adminCookie();
    const res = await app.request('/admin/mail', { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('メール文面');
    expect(html).toContain('受付確認（会員宛）');
    expect(html).toContain('確定のお知らせ（会員宛）');
    expect(html).toContain('否認のお知らせ（会員宛）');
    expect(html).toContain('新しいリクエスト（スタッフ宛）');
    expect(html).toContain('キャンセル通知（スタッフ宛）');
    expect(html).toContain('{会員名}');
    expect(html).toContain('{スタッフメモ}');
    expect(html).toContain('空欄'); // 空欄なら標準文面の案内
  });

  it('保存すると設定に反映され、再表示で入力欄に出る', async () => {
    const cookie = await adminCookie();
    const res = await post(cookie, {
      confirmed_subject: '確定しました {日時}',
      confirmed_body: '{会員名}様 確定です',
      requested_member_subject: '', requested_member_body: '',
      requested_subject: '', requested_body: '',
      cancelled_subject: '', cancelled_body: '',
      declined_subject: '', declined_body: ''
    });
    expect(res.headers.get('location')).toBe('/admin/mail?ok=saved');

    const t = await getMailTemplates(env.DB);
    expect(t.confirmed.subject).toBe('確定しました {日時}');
    expect(t.requested_member).toEqual({ subject: '', body: '' });

    const page = await app.request('/admin/mail', { headers: { cookie } }, env);
    expect(await page.text()).toContain('確定しました {日時}');
  });

  it('件名200字超・本文4000字超は invalid で保存されない', async () => {
    const cookie = await adminCookie();
    const before = await getMailTemplates(env.DB);
    const res = await post(cookie, { confirmed_subject: 'あ'.repeat(201) });
    expect(res.headers.get('location')).toBe('/admin/mail?error=invalid');
    const res2 = await post(cookie, { confirmed_body: 'あ'.repeat(4001) });
    expect(res2.headers.get('location')).toBe('/admin/mail?error=invalid');
    expect(await getMailTemplates(env.DB)).toEqual(before); // 何も変わらない
  });

  it('未認証ではログイン画面へリダイレクトされる', async () => {
    const res = await app.request('/admin/mail', {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（/admin/mail が404 → 302想定のテストが失敗）

- [ ] **Step 3: 実装する**

`src/routes/admin/mail.tsx`（新規）:

```tsx
import { Hono } from 'hono';
import type { Bindings } from '../../types';
import { saveSettings } from '../../core/settings';
import type { SettingKey } from '../../core/settings';
import { MAIL_TEMPLATE_TYPES, MAIL_TYPE_LABELS, DEFAULT_MAIL_PREVIEWS, getMailTemplates } from '../../core/mailTemplates';
import { Layout } from './ui';

export const mailPage = new Hono<{ Bindings: Bindings }>();

const OK_MESSAGES: Record<string, string> = {
  saved: 'メール文面を保存しました'
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid: '入力内容に誤りがあります（件名200字以内・本文4000字以内）'
};

const SUBJECT_MAX = 200;
const BODY_MAX = 4000;

mailPage.get('/', async (c) => {
  const okParam = c.req.query('ok');
  const errorParam = c.req.query('error');
  const templates = await getMailTemplates(c.env.DB);

  return c.html(
    <Layout title="メール文面 | TORCH 会員予約" active="/admin/mail">
      <div class="page-head">
        <span class="eyebrow">Mail</span>
        <h1>メール文面</h1>
      </div>
      {okParam && OK_MESSAGES[okParam] && <p class="msg-ok">{OK_MESSAGES[okParam]}</p>}
      {errorParam && ERROR_MESSAGES[errorParam] && <p class="msg-error">{ERROR_MESSAGES[errorParam]}</p>}

      <p class="small">
        空欄のまま保存すると標準の文面が使われます。文面には次のタグが書けます（送信時に実際の内容へ置き換わります）:
      </p>
      <p class="small muted">
        {'{会員名}'}（会員の名前・「様」は文面側で付ける） {'{会員種別}'}（月額会員/回数券） {'{日時}'}（利用日時）{' '}
        {'{会員メモ}'}（会員のひとことメモ） {'{スタッフメモ}'}（確定時のひとこと・否認理由） {'{管理画面リンク}'}（スタッフ宛メール用）
      </p>

      <form class="card card-pad" method="post" action="/admin/mail">
        {MAIL_TEMPLATE_TYPES.map((t) => (
          <>
            <h2>{MAIL_TYPE_LABELS[t]}</h2>
            <div class="field">
              <label>件名（空欄なら標準の件名）</label>
              <input
                type="text"
                name={`${t}_subject`}
                value={templates[t].subject}
                maxlength={SUBJECT_MAX}
                placeholder={DEFAULT_MAIL_PREVIEWS[t].subject}
              />
            </div>
            <div class="field">
              <label>本文（空欄なら標準の本文）</label>
              <textarea name={`${t}_body`} rows={8} maxlength={BODY_MAX} placeholder={DEFAULT_MAIL_PREVIEWS[t].body}>
                {templates[t].body}
              </textarea>
            </div>
          </>
        ))}
        <button class="btn btn-primary btn-lg" type="submit">
          保存
        </button>
        <p class="muted small" style="margin:12px 0 0">
          タグに対応する内容が空のとき（メモ未入力など）は、その部分が空欄のまま送られます。
        </p>
      </form>
    </Layout>
  );
});

mailPage.post('/', async (c) => {
  const form = await c.req.parseBody();
  const entries: { key: SettingKey; value: string }[] = [];
  for (const t of MAIL_TEMPLATE_TYPES) {
    const subjectRaw = form[`${t}_subject`];
    const bodyRaw = form[`${t}_body`];
    const subject = typeof subjectRaw === 'string' ? subjectRaw.trim() : '';
    const body = typeof bodyRaw === 'string' ? bodyRaw.trim() : '';
    if (subject.length > SUBJECT_MAX || body.length > BODY_MAX) {
      return c.redirect('/admin/mail?error=invalid');
    }
    entries.push({ key: `mail_tpl_${t}_subject`, value: subject });
    entries.push({ key: `mail_tpl_${t}_body`, value: body });
  }
  await saveSettings(c.env.DB, entries);
  return c.redirect('/admin/mail?ok=saved');
});
```

`src/routes/admin/ui.tsx` の変更（`NAV_ITEMS` だけを以下に差し替える。他は変更しない）:

```ts
const NAV_ITEMS: { href: string; label: string }[] = [
  { href: '/admin/requests', label: '承認待ち' },
  { href: '/admin/requests/all', label: 'リクエスト一覧' },
  { href: '/admin/members', label: '会員管理' },
  { href: '/admin/closed', label: '受付停止日' },
  { href: '/admin/mail', label: 'メール文面' },
  { href: '/admin/settings', label: '設定' }
];
```

`src/routes/admin.tsx` の変更（2行追加のみ。他は変更しない）:

import 群の `import { settingsPage } from './admin/settings';` の直後に:

```ts
import { mailPage } from './admin/mail';
```

`admin.route('/settings', settingsPage);` の直後に:

```ts
admin.route('/mail', mailPage);
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（累計 **148件**。admin-mail 4件）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/routes/admin/mail.tsx src/routes/admin/ui.tsx src/routes/admin.tsx test/admin-mail.test.ts
git commit -m "feat: 管理画面にメール文面編集ページ(/admin/mail)を追加"
```

---

## 補足（実装者向け）

- カスタム未設定時の送信内容は現行と完全に同一であること（既存 notify.test.ts 9件が無変更で通ることがその証明）
- `DEFAULT_MAIL_PREVIEWS` は**編集画面の参考表示用**。実際の標準文面は notify.ts の分岐が組み立てる（メモ等が空なら行ごと省く挙動を保つため二重管理を許容する。文言を変えるときは両方を直す）
- `renderTemplate` の未知タグ非置換は仕様（送信を失敗させない）。テンプレート適用ブロック全体も try/catch で包み、失敗時は標準文面で続行
- migration は不要（settings は key-value）。`mail_tpl_*` キーは保存時に自動作成される
