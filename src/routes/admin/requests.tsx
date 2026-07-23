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
