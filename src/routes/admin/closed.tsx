import { Hono } from 'hono';
import type { Bindings } from '../../types';
import { isValidDate, currentJstDate, formatMD, WEEKDAY_LABELS } from '../../core/dates';
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

  if (!isValidDate(date)) return c.redirect('/admin/closed?error=invalid');

  await c.env.DB.prepare('INSERT OR REPLACE INTO closed_dates (date, reason) VALUES (?, ?)').bind(date, reason).run();
  return c.redirect('/admin/closed?ok=saved');
});

closed.post('/:date/delete', async (c) => {
  const date = c.req.param('date');
  if (!isValidDate(date)) return c.redirect('/admin/closed?error=invalid');

  await c.env.DB.prepare('DELETE FROM closed_dates WHERE date = ?').bind(date).run();
  return c.redirect('/admin/closed?ok=deleted');
});
