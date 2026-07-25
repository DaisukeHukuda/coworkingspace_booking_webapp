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
