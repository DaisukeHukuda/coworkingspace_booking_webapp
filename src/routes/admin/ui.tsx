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
