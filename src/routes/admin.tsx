import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { passwordMatches, signSession, verifySession } from '../auth/session';
import { tooManyFailures, recordFailure, clearFailures } from '../auth/loginRateLimit';
import type { Bindings } from '../types';
import { members } from './admin/members';
import { requests } from './admin/requests';
import { closed } from './admin/closed';
import { settingsPage } from './admin/settings';
import { mailPage } from './admin/mail';
import { dashboard } from './admin/dashboard';

const COOKIE_NAME = 'admin_session';
// Cookieの有効期限はブラウザ/Hono仕様で最大400日。この上限＝実質「時間経過では自動ログアウトしない」
const SESSION_TTL_MS = 400 * 24 * 60 * 60 * 1000; // 400日（Cookie Max-Ageの上限）

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
            TORCH<small>Coworking Space</small>
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

admin.route('/members', members);
admin.route('/requests', requests);
admin.route('/closed', closed);
admin.route('/settings', settingsPage);
admin.route('/mail', mailPage);

// トップはダッシュボード（§20。旧: 承認待ちへリダイレクト）
admin.route('/', dashboard);
