# TORCH会員予約システム ステップ①（基盤）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理画面で会員（月額/回数券）を登録し、ログイン不要の専用リンクを発行できる状態を作る（設計書 §12 ステップ①）。会員が専用リンクを開くと本人名入りの「準備中」ページが表示され、無効リンクは弾かれるところまで含む。

**Architecture:** Cloudflare Workers 上の単一 Hono アプリ。サーバーレンダリング（hono/jsx）のみでクライアントJSなし。データは D1（SQLite）。管理画面は `ADMIN_PASSWORD` ＋ HMAC署名Cookieセッション、会員ページは URL トークン（40桁hex）で認証。実装パターンはすべて `Projects/booking-system`（Sup!Sup!予約管理）で実証済みのものを踏襲する。

**Tech Stack:** Hono 4.12.28 / Cloudflare Workers (wrangler 4.107.0) / D1 / vitest 3.2.7 + @cloudflare/vitest-pool-workers 0.12.21 / TypeScript 6.0.3 (strict) — バージョン完全固定（Task 1参照）

## Global Constraints

- 設計書: `docs/superpowers/specs/2026-07-23-torch-member-booking-design.md`（本計画はその §12 ステップ①のみを実装。requests/closed_dates/settings 等のテーブルはステップ②以降で追加する — 今は作らない）
- UI文言はすべて日本語。アプリ表示名は仮に「TORCH 会員予約」（設計書 §16、ステップ②で最終確認）
- 会員トークンは **20バイト乱数 → 40桁hex**（設計書 §6「160bit相当」。booking-system は 16バイトだが本プロジェクトは20バイト）
- 会員テーブルの列名は設計書 §6 の通り: `member_type`（'monthly' | 'ticket'）, `is_active`（booking-system の `active` とは違う名前。混ぜないこと）
- メールアドレスは登録必須（通知はメールで行う設計のため）
- 秘密情報（`.dev.vars`）はコミット禁止。`.dev.vars.example` のみコミットする
- 各タスク完了時: `npm test` と `npm run typecheck` が全部通ってからコミット
- コミットメッセージは `feat:` / `docs:` / `chore:` プレフィックス＋日本語（booking-system の慣習）
- トークンやパスワードを `console.log` に出さない（設計書 §10）
- 作業ディレクトリ: `/Users/daisukefukuda/Projects/coworkingspace_booking_webapp/`（git初期化済み）。旧位置 `Claude/Projects/coworkingspace_booking_webapp` は実体へのシンボリックリンク。**必ず実体パスで作業すること** — 記号入りの旧実パスで `npm test` を実行すると Workers ランタイムのモジュール解決が壊れる（検証済み: クリーンパスでは booking-system の169テスト全通過、記号入りパスでは起動失敗）
- テスト名は日本語でよい（booking-system 踏襲）。その際 miniflare が `MF-Vitest-Source` ヘッダの非ASCII警告を stderr に出すのは既知の無害な挙動（booking-system でも同様に出る）で、テスト成否には影響しない

---

### Task 1: プロジェクト土台とヘルスチェック

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.jsonc`
- Create: `vitest.config.ts`（このタスクでは暫定版。Task 2 で最終版に差し替える）
- Create: `.gitignore`
- Create: `.dev.vars.example`
- Create: `README.md`（暫定。Task 6 で完成版に差し替える）
- Create: `src/types.ts`
- Create: `src/index.ts`
- Test: `test/smoke.test.ts`

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces: `src/index.ts` が `export default app`（Hono アプリ。全タスクがここにルートを足す）／`src/types.ts` が `export type Bindings = { DB: D1Database; ADMIN_PASSWORD: string; SESSION_SECRET: string }`

- [ ] **Step 1: 設定ファイル一式を作成**

`package.json`:

```json
{
  "name": "torch-member-booking",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "hono": "4.12.28"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "0.12.21",
    "@cloudflare/workers-types": "4.20260702.1",
    "typescript": "6.0.3",
    "vitest": "3.2.7",
    "wrangler": "4.107.0"
  }
}
```

バージョンはすべて**完全固定**（`^`/`~`なし）。booking-system の package-lock.json で実際に動いている組み合わせと同一。範囲指定にすると wrangler 4.113.0 等の新しい版が入り、vitest-pool-workers との不整合で `Failed to import "cloudflare:test-internal"` が発生することを確認済み。`npm install` に `--legacy-peer-deps` は**使用禁止**（依存不整合を隠して壊れたツリーを作る）。インストールに失敗する場合はエラー全文を報告すること。

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`wrangler.jsonc`:

```jsonc
{
  "name": "torch-member-booking",
  "main": "src/index.ts",
  "compatibility_date": "2026-03-10",
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

`vitest.config.ts`（暫定版。Task 2 でマイグレーション読み込み付きの最終版になる）:

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            ADMIN_PASSWORD: 'test-password',
            SESSION_SECRET: 'test-secret'
          }
        }
      }
    }
  }
});
```

`.gitignore`:

```
node_modules/
.wrangler/
.dev.vars
```

`.dev.vars.example`:

```
ADMIN_PASSWORD=changeme
SESSION_SECRET=changeme-long-random-string
```

`README.md`（暫定）:

```markdown
# TORCH 会員予約

TORCH Coworking の月額会員・回数券ユーザー向け予約リクエストシステム。
Cloudflare Workers + Hono + D1 で動作します。

設計書: docs/superpowers/specs/2026-07-23-torch-member-booking-design.md

（セットアップ手順はステップ①完了時に記載）
```

- [ ] **Step 2: 依存をインストール**

Run: `npm install`
Expected: エラーなく完了し `package-lock.json` が生成される

- [ ] **Step 3: 失敗するテストを書く**

`test/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../src/index';

describe('smoke', () => {
  it('GET /health が ok を返す', async () => {
    const res = await app.request('/health', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 4: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（`Failed to load ../src/index` — ファイルがまだ無い）

- [ ] **Step 5: 最小実装**

`src/types.ts`:

```ts
export type Bindings = {
  DB: D1Database;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
};
```

`src/index.ts`:

```ts
import { Hono } from 'hono';
import type { Bindings } from './types';

const app = new Hono<{ Bindings: Bindings }>();

app.get('/health', (c) => c.json({ ok: true }));

export default app;
```

- [ ] **Step 6: テストが通ることを確認**

Run: `npm test`
Expected: PASS (1 test)

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 7: コミット**

```bash
git add package.json package-lock.json tsconfig.json wrangler.jsonc vitest.config.ts .gitignore .dev.vars.example README.md src test
git commit -m "chore: プロジェクト土台（Workers+Hono+D1+vitest）とヘルスチェック"
```

---

### Task 2: D1スキーマ（members）とテストからのDB利用

**Files:**
- Create: `migrations/0001_init.sql`
- Create: `test/env.d.ts`
- Create: `test/apply-migrations.ts`
- Modify: `vitest.config.ts`（全文差し替え）
- Test: `test/schema.test.ts`

**Interfaces:**
- Consumes: Task 1 の `wrangler.jsonc`（`migrations_dir: "migrations"`）
- Produces: `members` テーブル（列: `id, name, email, member_type, token, is_active, created_at`）。全テストで `env.DB` にマイグレーション適用済みD1が使える状態

- [ ] **Step 1: 失敗するテストを書く**

`test/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

const INSERT = `INSERT INTO members (name, email, member_type, token, is_active, created_at)
  VALUES (?, ?, ?, ?, 1, ?)`;

describe('members schema', () => {
  it('会員を登録して読み出せる', async () => {
    await env.DB.prepare(INSERT)
      .bind('山田太郎', 'yamada@example.com', 'monthly', 'a'.repeat(40), '2026-07-23T00:00:00.000Z')
      .run();
    const row = await env.DB.prepare('SELECT * FROM members WHERE name = ?').bind('山田太郎').first();
    expect(row).not.toBeNull();
    expect(row!.email).toBe('yamada@example.com');
    expect(row!.member_type).toBe('monthly');
    expect(row!.is_active).toBe(1);
  });

  it('token の重複は拒否される', async () => {
    await env.DB.prepare(INSERT)
      .bind('A', 'a@example.com', 'ticket', 'b'.repeat(40), '2026-07-23T00:00:00.000Z')
      .run();
    await expect(
      env.DB.prepare(INSERT)
        .bind('B', 'b@example.com', 'ticket', 'b'.repeat(40), '2026-07-23T00:00:00.000Z')
        .run()
    ).rejects.toThrow();
  });

  it('member_type は monthly/ticket 以外を拒否する', async () => {
    await expect(
      env.DB.prepare(INSERT)
        .bind('C', 'c@example.com', 'weekly', 'c'.repeat(40), '2026-07-23T00:00:00.000Z')
        .run()
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（`no such table: members`）

- [ ] **Step 3: マイグレーションとテスト配線を実装**

`migrations/0001_init.sql`:

```sql
CREATE TABLE members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  member_type TEXT NOT NULL CHECK (member_type IN ('monthly', 'ticket')),
  token TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
```

`test/env.d.ts`:

```ts
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
    ADMIN_PASSWORD: string;
    SESSION_SECRET: string;
  }
}
```

`test/apply-migrations.ts`:

```ts
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

`vitest.config.ts`（全文差し替え・最終版）:

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
              SESSION_SECRET: 'test-secret'
            }
          }
        }
      }
    }
  };
});
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（smoke 1件 + schema 3件）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5: ローカル開発DBにもマイグレーションを適用**

Run: `npx wrangler d1 migrations apply torch-member-booking --local`
Expected: `0001_init.sql` が適用され `1 migration(s) applied` 相当の出力（`.wrangler/` 配下にローカルDBが作られる。Cloudflareへのログインは不要。確認プロンプトが出たら y で続行）

- [ ] **Step 6: コミット**

```bash
git add migrations test vitest.config.ts
git commit -m "feat: membersスキーマとD1テスト基盤（マイグレーション自動適用）"
```

---

### Task 3: 会員トークン生成

**Files:**
- Create: `src/token.ts`
- Test: `test/token.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `export function newMemberToken(): string` — 40桁の小文字hex（20バイト乱数）。Task 5 の会員作成・再発行で使う

- [ ] **Step 1: 失敗するテストを書く**

`test/token.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { newMemberToken } from '../src/token';

describe('newMemberToken', () => {
  it('40桁の小文字hexを返す', () => {
    const t = newMemberToken();
    expect(t).toMatch(/^[0-9a-f]{40}$/);
  });

  it('毎回異なる値を返す（100回で重複なし）', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(newMemberToken());
    expect(seen.size).toBe(100);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（`Failed to load ../src/token`）

- [ ] **Step 3: 最小実装**

`src/token.ts`:

```ts
// 会員専用リンクのトークン。20バイト乱数（160bit）を40桁hexで表す（設計書 §6/§10）
export function newMemberToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（累計 6 件）

- [ ] **Step 5: コミット**

```bash
git add src/token.ts test/token.test.ts
git commit -m "feat: 会員トークン生成（160bit hex）"
```

---

### Task 4: 管理画面ログイン（HMACセッション）

**Files:**
- Create: `src/auth/session.ts`（booking-system で実証済みの実装をそのまま使う）
- Create: `src/routes/admin.tsx`（ログイン・ログアウト・認証ミドルウェア・トップ転送。Task 5 で /members をマウントする）
- Modify: `src/index.ts`（全文差し替え）
- Test: `test/session.test.ts`
- Test: `test/admin-auth.test.ts`

**Interfaces:**
- Consumes: `Bindings`（Task 1）
- Produces: `signSession(secret, expiresAtMs)` / `verifySession(secret, token)` / `passwordMatches(secret, input, expected)`（`src/auth/session.ts`）。`export const admin`（Hono サブアプリ、`/admin` にマウント済み、`/login`・`/logout` 以外は認証必須）。Cookie名は `admin_session`

- [ ] **Step 1: セッションの失敗するテストを書く**

`test/session.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { signSession, verifySession, passwordMatches } from '../src/auth/session';

describe('session', () => {
  it('署名したトークンを検証できる', async () => {
    const token = await signSession('secret', Date.now() + 60_000);
    expect(await verifySession('secret', token)).toBe(true);
  });

  it('期限切れトークンは無効', async () => {
    const token = await signSession('secret', Date.now() - 1000);
    expect(await verifySession('secret', token)).toBe(false);
  });

  it('別のsecretで署名されたトークンは無効', async () => {
    const token = await signSession('other', Date.now() + 60_000);
    expect(await verifySession('secret', token)).toBe(false);
  });

  it('改ざんされたトークンは無効', async () => {
    const token = await signSession('secret', Date.now() + 60_000);
    expect(await verifySession('secret', `9${token}`)).toBe(false);
    expect(await verifySession('secret', undefined)).toBe(false);
    expect(await verifySession('secret', 'garbage')).toBe(false);
  });

  it('passwordMatches は一致/不一致を判定する', async () => {
    expect(await passwordMatches('secret', 'pw1', 'pw1')).toBe(true);
    expect(await passwordMatches('secret', 'pw1', 'pw2')).toBe(false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（`Failed to load ../src/auth/session`）

- [ ] **Step 3: session.ts を実装（実証済みコードの流用）**

`src/auth/session.ts`:

```ts
const encoder = new TextEncoder();

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

function toBase64Url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(s: string): Uint8Array | null {
  try {
    const b64 = s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (s.length % 4)) % 4);
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

// トークン形式: `${expiresAtMs}.${base64url(HMAC-SHA256(expiresAtMs))}`
export async function signSession(secret: string, expiresAtMs: number): Promise<string> {
  const key = await hmacKey(secret, 'sign');
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(String(expiresAtMs)));
  return `${expiresAtMs}.${toBase64Url(sig)}`;
}

export async function verifySession(secret: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const sigBytes = fromBase64Url(token.slice(dot + 1));
  if (!sigBytes || sigBytes.length === 0) return false;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const key = await hmacKey(secret, 'verify');
  return crypto.subtle.verify('HMAC', key, sigBytes as unknown as BufferSource, encoder.encode(exp));
}

// パスワード比較。生文字列の === 比較によるタイミング差を避けるため、両者のHMACダイジェストを比較する
export async function passwordMatches(secret: string, input: string, expected: string): Promise<boolean> {
  const key = await hmacKey(secret, 'sign');
  const a = toBase64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(input)));
  const b = toBase64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(expected)));
  return a === b;
}
```

- [ ] **Step 4: セッションテストが通ることを確認**

Run: `npm test`
Expected: PASS（session 5件を含む累計 11 件）

- [ ] **Step 5: ルートの失敗するテストを書く**

`test/admin-auth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../src/index';

async function login(password: string): Promise<Response> {
  return app.request('/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }).toString()
  }, env);
}

describe('admin auth', () => {
  it('未ログインで /admin にアクセスするとログイン画面へリダイレクト', async () => {
    const res = await app.request('/admin', {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login');
  });

  it('ログイン画面は未ログインでも表示できる', async () => {
    const res = await app.request('/admin/login', {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('パスワード');
  });

  it('誤ったパスワードでは401でCookieが発行されない', async () => {
    const res = await login('wrong-password');
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('正しいパスワードでログインでき、Cookie付きの /admin は会員管理へ転送される', async () => {
    const res = await login('test-password'); // vitest.config.ts の ADMIN_PASSWORD
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin');
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('admin_session=');
    expect(setCookie).toContain('HttpOnly');
    const cookie = setCookie!.split(';')[0];
    const page = await app.request('/admin', { headers: { cookie } }, env);
    // ログイン済みなら /admin/login ではなく会員管理へ転送される（/members 自体は Task 5 で実装）
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/admin/members');
  });

  it('ログアウトするとCookieが無効化される', async () => {
    const res = await login('test-password');
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    const out = await app.request('/admin/logout', { method: 'POST', headers: { cookie } }, env);
    expect(out.status).toBe(302);
    // Max-Age=0 のCookieが返る
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('でたらめなCookieではアクセスできない', async () => {
    const res = await app.request('/admin', { headers: { cookie: 'admin_session=123.fakesig' } }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login');
  });
});
```

- [ ] **Step 6: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（`Failed to load ../src/routes/admin` もしくは /admin が404）

- [ ] **Step 7: ログインルートを実装**

`src/routes/admin.tsx`:

```tsx
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { passwordMatches, signSession, verifySession } from '../auth/session';
import type { Bindings } from '../types';

const COOKIE_NAME = 'admin_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日

const LoginPage = (props: { error: string | null }) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>ログイン | TORCH 会員予約</title>
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <main class="login-wrap">
        <form class="login-card" method="post" action="/admin/login">
          <div class="brand-lg">
            TORCH<small>MEMBER BOOKING</small>
          </div>
          {props.error && <p class="msg-error">{props.error}</p>}
          <div class="field" style="margin:24px 0 16px">
            <label for="pw">パスワード</label>
            <input type="password" id="pw" name="password" autocomplete="current-password" autofocus required />
          </div>
          <button class="btn btn-primary btn-lg btn-block" type="submit">
            ログイン
          </button>
          <p class="muted small" style="margin:16px 0 0">
            スタッフ専用の管理画面です。
          </p>
        </form>
      </main>
    </body>
  </html>
);

export const admin = new Hono<{ Bindings: Bindings }>();

// ログイン画面・処理は認証ミドルウェアより先に登録する（未ログインで到達可能にするため）
admin.get('/login', (c) => c.html(<LoginPage error={null} />));

admin.post('/login', async (c) => {
  const form = await c.req.parseBody();
  const password = typeof form.password === 'string' ? form.password : '';
  if (!(await passwordMatches(c.env.SESSION_SECRET, password, c.env.ADMIN_PASSWORD))) {
    return c.html(<LoginPage error="パスワードが違います" />, 401);
  }
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

admin.post('/logout', (c) => {
  deleteCookie(c, COOKIE_NAME, { path: '/' });
  return c.redirect('/admin/login');
});

// これ以降に登録するルートはすべて認証必須
admin.use('*', async (c, next) => {
  if (!(await verifySession(c.env.SESSION_SECRET, getCookie(c, COOKIE_NAME)))) {
    return c.redirect('/admin/login');
  }
  await next();
});

// トップは会員管理へ転送（/members のマウントは Task 5 で行う。転送先が未実装でも302自体は返せる）
admin.get('/', (c) => c.redirect('/admin/members'));
```

`src/index.ts`（全文差し替え）:

```ts
import { Hono } from 'hono';
import { admin } from './routes/admin';
import type { Bindings } from './types';

const app = new Hono<{ Bindings: Bindings }>();

app.get('/health', (c) => c.json({ ok: true }));
app.route('/admin', admin);

export default app;
```

- [ ] **Step 8: テストが通ることを確認**

Run: `npm test`
Expected: PASS（admin auth 6件を含む累計 17 件）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 9: コミット**

```bash
git add src test
git commit -m "feat: 管理画面ログイン（HMACセッションCookie・30日）"
```

---

### Task 5: 会員管理（一覧・登録・編集・無効化・リンク再発行）

**Files:**
- Create: `src/routes/style-css.ts`
- Create: `src/routes/admin/ui.tsx`
- Create: `src/routes/admin/members.tsx`
- Modify: `src/routes/admin.tsx`（暫定ダッシュボード部分を差し替え）
- Modify: `src/index.ts`（全文差し替え: /style.css 追加）
- Modify: `src/types.ts`（全文差し替え: MemberType/MemberRow 追加）
- Create: `test/helpers.ts`
- Test: `test/admin-members.test.ts`

**Interfaces:**
- Consumes: `newMemberToken()`（Task 3）、`admin` サブアプリと認証ミドルウェア（Task 4）、`members` テーブル（Task 2）
- Produces: `/admin/members` 一式（GET 一覧+作成フォーム / POST 作成 / GET `:id/edit` / POST `:id` 更新 / POST `:id/reissue` 再発行）。`Layout`（`src/routes/admin/ui.tsx`）と `STYLE_CSS`。`test/helpers.ts` の `adminCookie(): Promise<string>`。`src/types.ts` に `MemberType = 'monthly' | 'ticket'` と `MemberRow` 型

- [ ] **Step 1: 失敗するテストを書く**

`test/helpers.ts`:

```ts
import { env } from 'cloudflare:test';
import app from '../src/index';

export async function adminCookie(): Promise<string> {
  const res = await app.request('/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'test-password' }).toString()
  }, env);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('login failed');
  return setCookie.split(';')[0];
}
```

`test/admin-members.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../src/index';
import { adminCookie } from './helpers';

interface MemberRowInTest {
  id: number;
  name: string;
  email: string;
  member_type: string;
  token: string;
  is_active: number;
}

async function createMember(
  cookie: string,
  fields: { name: string; email: string; member_type: string }
): Promise<Response> {
  return app.request('/admin/members', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(fields).toString()
  }, env);
}

describe('admin members', () => {
  it('未ログインでは /admin/members にアクセスできない', async () => {
    const res = await app.request('/admin/members', {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login');
  });

  it('会員を登録するとトークン付きで保存され、一覧に専用リンクが表示される', async () => {
    const cookie = await adminCookie();
    const res = await createMember(cookie, {
      name: '佐藤花子', email: 'sato@example.com', member_type: 'monthly'
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/members?ok=created');

    const row = await env.DB.prepare('SELECT * FROM members WHERE name = ?')
      .bind('佐藤花子').first<MemberRowInTest>();
    expect(row).not.toBeNull();
    expect(row!.token).toMatch(/^[0-9a-f]{40}$/);
    expect(row!.is_active).toBe(1);

    const list = await app.request('/admin/members', { headers: { cookie } }, env);
    expect(list.status).toBe(200);
    const html = await list.text();
    expect(html).toContain('佐藤花子');
    expect(html).toContain(`/m/${row!.token}`);
  });

  it('名前が空だと登録できない', async () => {
    const cookie = await adminCookie();
    const res = await createMember(cookie, { name: '  ', email: 'x@example.com', member_type: 'ticket' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/members?error=invalid');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE email = ?')
      .bind('x@example.com').first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it('メールアドレスの形式が不正だと登録できない', async () => {
    const cookie = await adminCookie();
    const res = await createMember(cookie, { name: '田中', email: 'not-an-email', member_type: 'ticket' });
    expect(res.headers.get('location')).toBe('/admin/members?error=invalid');
  });

  it('member_type が不正だと登録できない', async () => {
    const cookie = await adminCookie();
    const res = await createMember(cookie, { name: '田中', email: 't@example.com', member_type: 'weekly' });
    expect(res.headers.get('location')).toBe('/admin/members?error=invalid');
  });

  it('編集で名前・種別・無効化を更新できる', async () => {
    const cookie = await adminCookie();
    await createMember(cookie, { name: '編集前', email: 'edit@example.com', member_type: 'monthly' });
    const before = await env.DB.prepare('SELECT * FROM members WHERE name = ?')
      .bind('編集前').first<MemberRowInTest>();

    const res = await app.request(`/admin/members/${before!.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      // is_active チェックボックスを送らない = 無効化
      body: new URLSearchParams({ name: '編集後', email: 'edit@example.com', member_type: 'ticket' }).toString()
    }, env);
    expect(res.headers.get('location')).toBe('/admin/members?ok=updated');

    const after = await env.DB.prepare('SELECT * FROM members WHERE id = ?')
      .bind(before!.id).first<MemberRowInTest>();
    expect(after!.name).toBe('編集後');
    expect(after!.member_type).toBe('ticket');
    expect(after!.is_active).toBe(0);
    expect(after!.token).toBe(before!.token); // 編集ではトークンは変わらない
  });

  it('再発行でトークンが変わる', async () => {
    const cookie = await adminCookie();
    await createMember(cookie, { name: '再発行', email: 're@example.com', member_type: 'monthly' });
    const before = await env.DB.prepare('SELECT * FROM members WHERE name = ?')
      .bind('再発行').first<MemberRowInTest>();

    const res = await app.request(`/admin/members/${before!.id}/reissue`, {
      method: 'POST', headers: { cookie }
    }, env);
    expect(res.headers.get('location')).toBe('/admin/members?ok=reissued');

    const after = await env.DB.prepare('SELECT * FROM members WHERE id = ?')
      .bind(before!.id).first<MemberRowInTest>();
    expect(after!.token).toMatch(/^[0-9a-f]{40}$/);
    expect(after!.token).not.toBe(before!.token);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（/admin/members が 404 → 「登録すると〜」以降のケースが失敗。未ログインリダイレクトのケースはミドルウェアにより既に通る）

- [ ] **Step 3: 型とCSSとレイアウトを実装**

`src/types.ts`（全文差し替え）:

```ts
export type Bindings = {
  DB: D1Database;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
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
```

`src/routes/style-css.ts`:

```ts
// ステップ①の最小スタイル。会員向けUIの本格的なデザインはステップ②で行う
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
.copy-link input { width: 100%; min-width: 260px; font-size: 12px; padding: 4px 6px; border: 1px solid #c6c6bb; border-radius: 4px; color: #565f75; }
.msg-ok { background: #dcf2e0; color: #1c6b34; padding: 10px 14px; border-radius: 8px; }
.msg-error { background: #fbdddd; color: #8f1f1f; padding: 10px 14px; border-radius: 8px; }
.muted { color: #7a8299; }
.small { font-size: 13px; }
.actions form { display: inline; }
.login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
.login-card { width: 100%; max-width: 360px; background: #fff; border: 1px solid #dcdcd2; border-radius: 12px; padding: 32px 28px; text-align: center; }
.member-wrap { max-width: 560px; margin: 0 auto; padding: 24px 16px 64px; }
`;
```

`src/routes/admin/ui.tsx`:

```tsx
import type { Child } from 'hono/jsx';

const NAV_ITEMS: { href: string; label: string }[] = [
  { href: '/admin/members', label: '会員管理' }
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

- [ ] **Step 4: 会員管理ルートを実装**

`src/routes/admin/members.tsx`:

```tsx
import { Hono } from 'hono';
import type { Bindings, MemberRow, MemberType } from '../../types';
import { newMemberToken } from '../../token';
import { Layout, TYPE_LABELS, TYPE_BADGE_CLASSES } from './ui';

export const members = new Hono<{ Bindings: Bindings }>();

const OK_MESSAGES: Record<string, string> = {
  created: '会員を登録し、専用リンクを発行しました',
  updated: '更新しました',
  reissued: '専用リンクを再発行しました。旧リンクは無効です'
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid: '入力内容に誤りがあります（名前・正しいメールアドレス・種別が必要です）'
};

function isValidType(v: unknown): v is MemberType {
  return v === 'monthly' || v === 'ticket';
}

function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function parsePositiveInt(v: unknown): number | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

members.get('/', async (c) => {
  const okParam = c.req.query('ok');
  const errorParam = c.req.query('error');
  const origin = new URL(c.req.url).origin;

  const result = await c.env.DB.prepare('SELECT * FROM members ORDER BY id').all<MemberRow>();
  const rows = result.results;

  return c.html(
    <Layout title="会員管理 | TORCH 会員予約" active="/admin/members">
      <div class="page-head">
        <span class="eyebrow">Members</span>
        <h1>会員管理</h1>
      </div>
      {okParam && OK_MESSAGES[okParam] && <p class="msg-ok">{OK_MESSAGES[okParam]}</p>}
      {errorParam && ERROR_MESSAGES[errorParam] && <p class="msg-error">{ERROR_MESSAGES[errorParam]}</p>}

      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>名前</th>
              <th>種別</th>
              <th>メール</th>
              <th>状態</th>
              <th>専用リンク（LINEで本人にだけ送る）</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr class={m.is_active ? undefined : 'row-muted'}>
                <td>{m.name}</td>
                <td>
                  <span class={TYPE_BADGE_CLASSES[m.member_type]}>{TYPE_LABELS[m.member_type]}</span>
                </td>
                <td>{m.email}</td>
                <td>
                  <span class={`badge ${m.is_active ? 'badge-on' : 'badge-off'}`}>
                    {m.is_active ? '有効' : '無効'}
                  </span>
                </td>
                <td>
                  <span class="copy-link">
                    <input type="text" readonly value={`${origin}/m/${m.token}`} />
                  </span>
                </td>
                <td class="actions">
                  <a class="btn btn-sm" href={`/admin/members/${m.id}/edit`}>
                    編集
                  </a>{' '}
                  <form method="post" action={`/admin/members/${m.id}/reissue`}>
                    <button class="btn btn-sm" type="submit">
                      再発行
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>新規登録</h2>
      <form class="card card-pad" method="post" action="/admin/members">
        <div class="form-grid">
          <div class="field">
            <label>名前</label>
            <input type="text" name="name" required />
          </div>
          <div class="field">
            <label>メールアドレス（確定通知の送り先）</label>
            <input type="email" name="email" required />
          </div>
          <div class="field">
            <label>種別</label>
            <select name="member_type">
              <option value="monthly">月額会員</option>
              <option value="ticket">回数券</option>
            </select>
          </div>
          <button class="btn btn-primary" type="submit">
            登録してリンク発行
          </button>
        </div>
      </form>
    </Layout>
  );
});

members.post('/', async (c) => {
  const form = await c.req.parseBody();
  const name = typeof form.name === 'string' ? form.name.trim() : '';
  const email = typeof form.email === 'string' ? form.email.trim() : '';
  const memberType = form.member_type;

  if (name === '' || !isValidEmail(email) || !isValidType(memberType)) {
    return c.redirect('/admin/members?error=invalid');
  }

  await c.env.DB.prepare(
    `INSERT INTO members (name, email, member_type, token, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)`
  )
    .bind(name, email, memberType, newMemberToken(), new Date().toISOString())
    .run();

  return c.redirect('/admin/members?ok=created');
});

members.get('/:id/edit', async (c) => {
  const id = parsePositiveInt(c.req.param('id'));
  if (id === null) return c.redirect('/admin/members');

  const member = await c.env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(id).first<MemberRow>();
  if (!member) return c.redirect('/admin/members');

  const errorParam = c.req.query('error');

  return c.html(
    <Layout title="会員編集 | TORCH 会員予約" active="/admin/members">
      <div class="page-head">
        <span class="eyebrow">Members / Edit</span>
        <h1>会員編集</h1>
        <span class="sub">
          <a href="/admin/members">&laquo; 会員一覧に戻る</a>
        </span>
      </div>
      {errorParam && ERROR_MESSAGES[errorParam] && <p class="msg-error">{ERROR_MESSAGES[errorParam]}</p>}

      <form class="card card-pad" method="post" action={`/admin/members/${member.id}`}>
        <div class="form-grid">
          <div class="field">
            <label>名前</label>
            <input type="text" name="name" value={member.name} required />
          </div>
          <div class="field">
            <label>メールアドレス</label>
            <input type="email" name="email" value={member.email} required />
          </div>
          <div class="field">
            <label>種別</label>
            <select name="member_type">
              <option value="monthly" selected={member.member_type === 'monthly'}>
                月額会員
              </option>
              <option value="ticket" selected={member.member_type === 'ticket'}>
                回数券
              </option>
            </select>
          </div>
        </div>
        <div class="field" style="margin-top:12px">
          <label class="check">
            <input type="checkbox" name="is_active" value="1" checked={member.is_active === 1} /> 有効（外すとこの会員の専用リンクが使えなくなる）
          </label>
        </div>
        <button class="btn btn-primary btn-lg" type="submit">
          更新
        </button>
      </form>
    </Layout>
  );
});

members.post('/:id', async (c) => {
  const id = parsePositiveInt(c.req.param('id'));
  if (id === null) return c.redirect('/admin/members');

  const form = await c.req.parseBody();
  const name = typeof form.name === 'string' ? form.name.trim() : '';
  const email = typeof form.email === 'string' ? form.email.trim() : '';
  const memberType = form.member_type;
  const isActive = form.is_active !== undefined ? 1 : 0;

  if (name === '' || !isValidEmail(email) || !isValidType(memberType)) {
    return c.redirect(`/admin/members/${id}/edit?error=invalid`);
  }

  await c.env.DB.prepare(
    `UPDATE members SET name = ?, email = ?, member_type = ?, is_active = ? WHERE id = ?`
  )
    .bind(name, email, memberType, isActive, id)
    .run();

  return c.redirect('/admin/members?ok=updated');
});

members.post('/:id/reissue', async (c) => {
  const id = parsePositiveInt(c.req.param('id'));
  if (id === null) return c.redirect('/admin/members');

  await c.env.DB.prepare(`UPDATE members SET token = ? WHERE id = ?`).bind(newMemberToken(), id).run();

  return c.redirect('/admin/members?ok=reissued');
});
```

- [ ] **Step 5: admin.tsx と index.ts を配線**

`src/routes/admin.tsx` の認証ミドルウェアの直後（`admin.get('/', ...)` の転送行の前）に1行追加する:

```tsx
admin.route('/members', members);
```

あわせて `src/routes/admin.tsx` 冒頭の import 群に追加:

```tsx
import { members } from './admin/members';
```

`src/index.ts`（全文差し替え）:

```ts
import { Hono } from 'hono';
import { admin } from './routes/admin';
import { STYLE_CSS } from './routes/style-css';
import type { Bindings } from './types';

const app = new Hono<{ Bindings: Bindings }>();

app.get('/health', (c) => c.json({ ok: true }));
app.get('/style.css', (c) => {
  c.header('content-type', 'text/css; charset=utf-8');
  c.header('cache-control', 'public, max-age=3600');
  return c.body(STYLE_CSS);
});
app.route('/admin', admin);

export default app;
```

- [ ] **Step 6: テストが通ることを確認**

Run: `npm test`
Expected: PASS（admin members 7件を含む累計 24 件）

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 7: コミット**

```bash
git add src test
git commit -m "feat: 会員管理（一覧・登録・編集・無効化・専用リンク再発行）"
```

---

### Task 6: 会員ページの骨組み `/m/{token}` と README 完成

**Files:**
- Create: `src/routes/member.tsx`
- Modify: `src/index.ts`（全文差し替え: /m マウント追加）
- Modify: `README.md`（全文差し替え）
- Test: `test/member-page.test.ts`

**Interfaces:**
- Consumes: `members` テーブル（Task 2）、`MemberRow`/`TYPE_LABELS` 相当の種別表示（Task 5。ui.tsx から import する）
- Produces: `export const member`（Hono サブアプリ、`/m` にマウント）。GET `/m/:token` — 有効会員なら200で本人ページ、無効/不明トークンなら404で案内ページ。ステップ②はこのページにカレンダーとリクエストフォームを足していく

- [ ] **Step 1: 失敗するテストを書く**

`test/member-page.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../src/index';
import { adminCookie } from './helpers';

async function createMemberAndGetToken(name: string, email: string): Promise<{ id: number; token: string }> {
  const cookie = await adminCookie();
  await app.request('/admin/members', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ name, email, member_type: 'monthly' }).toString()
  }, env);
  const row = await env.DB.prepare('SELECT id, token FROM members WHERE name = ?')
    .bind(name).first<{ id: number; token: string }>();
  if (!row) throw new Error('member not created');
  return row;
}

describe('member page', () => {
  it('有効なトークンで本人の名前入りページが表示される', async () => {
    const { token } = await createMemberAndGetToken('会員テスト', 'member@example.com');
    const res = await app.request(`/m/${token}`, {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('会員テスト');
    expect(html).toContain('月額会員');
    expect(html).toContain('準備中');
  });

  it('存在しないトークンは404で案内ページ', async () => {
    const res = await app.request(`/m/${'f'.repeat(40)}`, {}, env);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('このリンクは無効です');
  });

  it('無効化された会員のトークンは404', async () => {
    const { id, token } = await createMemberAndGetToken('無効化会員', 'inactive@example.com');
    await env.DB.prepare('UPDATE members SET is_active = 0 WHERE id = ?').bind(id).run();
    const res = await app.request(`/m/${token}`, {}, env);
    expect(res.status).toBe(404);
  });

  it('再発行後は旧トークンが404になり新トークンが使える', async () => {
    const { id, token: oldToken } = await createMemberAndGetToken('再発行会員', 'reissue@example.com');
    const cookie = await adminCookie();
    await app.request(`/admin/members/${id}/reissue`, { method: 'POST', headers: { cookie } }, env);
    const row = await env.DB.prepare('SELECT token FROM members WHERE id = ?')
      .bind(id).first<{ token: string }>();

    expect((await app.request(`/m/${oldToken}`, {}, env)).status).toBe(404);
    expect((await app.request(`/m/${row!.token}`, {}, env)).status).toBe(200);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（/m/... が 404 プレーンレスポンスで、本文に「このリンクは無効です」等が含まれない）

- [ ] **Step 3: 会員ページを実装**

`src/routes/member.tsx`:

```tsx
import { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import type { Bindings, MemberRow } from '../types';
import { TYPE_LABELS, TYPE_BADGE_CLASSES } from './admin/ui';

export const member = new Hono<{ Bindings: Bindings }>();

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

member.get('/:token', async (c) => {
  const token = c.req.param('token');
  const row = await c.env.DB.prepare('SELECT * FROM members WHERE token = ? AND is_active = 1')
    .bind(token)
    .first<MemberRow>();

  if (!row) {
    return c.html(
      <MemberShell title="リンクが無効です | TORCH 会員予約">
        <div class="page-head">
          <h1>このリンクは無効です</h1>
        </div>
        <p>お手数ですが、TORCH（LINE公式アカウント）までお問い合わせください。</p>
      </MemberShell>,
      404
    );
  }

  return c.html(
    <MemberShell title={`${row.name}さん | TORCH 会員予約`}>
      <div class="page-head">
        <span class="eyebrow">Member</span>
        <h1>{row.name} さん</h1>
        <span class={TYPE_BADGE_CLASSES[row.member_type]}>{TYPE_LABELS[row.member_type]}</span>
      </div>
      <div class="card card-pad">
        <p>予約カレンダーは準備中です。もうしばらくお待ちください。</p>
        <p class="muted small">それまでの間、ご利用の連絡は今まで通りLINEでお願いします。</p>
      </div>
    </MemberShell>
  );
});
```

`src/index.ts`（全文差し替え・ステップ①最終形）:

```ts
import { Hono } from 'hono';
import { admin } from './routes/admin';
import { member } from './routes/member';
import { STYLE_CSS } from './routes/style-css';
import type { Bindings } from './types';

const app = new Hono<{ Bindings: Bindings }>();

app.get('/health', (c) => c.json({ ok: true }));
app.get('/style.css', (c) => {
  c.header('content-type', 'text/css; charset=utf-8');
  c.header('cache-control', 'public, max-age=3600');
  return c.body(STYLE_CSS);
});
app.route('/admin', admin);
app.route('/m', member);

export default app;
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS（member page 4件を含む累計 28 件）

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

## 現在の機能（ステップ①）

- 管理画面ログイン（パスワード＋30日セッション）
- 会員管理: 登録（名前・メール・種別）・編集・無効化・専用リンク発行/再発行
- 会員ページ: 専用リンクで本人確認（予約機能はステップ②で追加）

## 開発ステップ

1. 基盤 — 会員管理と専用リンク発行 ← いまここ
2. リクエストの流れ — 空き表示・リクエスト送信・確定/否認・メール通知（ここで運用開始）
3. Square自動同期 — Bookings APIで空き枠を15分ごとに取得
4. 回数券の残数管理
```

- [ ] **Step 6: 最終確認とコミット**

Run: `npm test`
Expected: PASS（28件）

Run: `npm run typecheck`
Expected: エラーなし

```bash
git add src test README.md
git commit -m "feat: 会員ページ骨組み（専用リンクで本人表示・無効リンク案内）とREADME"
```

---

## 動作確認手順（ステップ①完了後、福田さん向けデモ）

```bash
cp .dev.vars.example .dev.vars
```

`.dev.vars` の `ADMIN_PASSWORD` と `SESSION_SECRET` を適当な値に書き換えたあと:

```bash
npm run dev
```

1. http://localhost:8787/admin を開く → ログイン画面
2. `.dev.vars` に書いたパスワードでログイン → 会員管理画面
3. 会員を1人登録（名前・メール・種別）→ 一覧に専用リンクが表示される
4. 専用リンクをコピーして別タブ（またはシークレットウィンドウ）で開く → 本人名入りページが出る
5. 会員一覧で「再発行」→ 古いリンクを開き直すと「このリンクは無効です」になる

## 補足（実装者向け）

- `wrangler.jsonc` の `database_id` はローカルでは使われないダミー。**初回デプロイ時**（ステップ②の運用開始前）に `wrangler d1 create torch-member-booking` を実行して本物のIDに差し替え、`wrangler d1 migrations apply torch-member-booking --remote` を流す
- リポジトリのパスには全角括弧・スペースが含まれる。bash では必ず `"..."` で囲むこと
- booking-system（`../booking-system`）と似たコードだが、**列名・型名はこのプロジェクトの定義が正**（`is_active`/`member_type` など）。コピー時に混ぜない
