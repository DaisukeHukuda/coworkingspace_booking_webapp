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
