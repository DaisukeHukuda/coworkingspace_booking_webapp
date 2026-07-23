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
