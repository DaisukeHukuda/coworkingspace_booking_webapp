import { Hono } from 'hono';
import type { Bindings } from '../../types';
import { isValidDate, currentJstDate, formatMD, weekdayOf } from '../../core/dates';
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
      </div>
      <p class="closed-desc">
        指定した日は会員のカレンダーで「停」と表示され、選択できなくなります（今日以降の分を表示）。
      </p>
      {okParam && OK_MESSAGES[okParam] && <p class="msg-ok">{OK_MESSAGES[okParam]}</p>}
      {errorParam && ERROR_MESSAGES[errorParam] && <p class="msg-error">{ERROR_MESSAGES[errorParam]}</p>}

      <div class="closed-grid">
        <div class="dash-panel">
          <div class="dash-panel-head">
            <span>停止日を追加</span>
          </div>
          <form class="row-form" method="post" action="/admin/closed">
            <label class="field-h w-date-lg">
              <span>日付</span>
              <input type="date" name="date" required />
            </label>
            <label class="field-h grow">
              <span>理由（任意・会員には表示されません）</span>
              <input type="text" name="reason" maxlength={200} />
            </label>
            <button class="btn btn-primary" type="submit">
              停止日にする
            </button>
          </form>
        </div>

        <div class="dash-panel">
          <div class="dash-panel-head">
            <span>設定済みの停止日</span>
            <span class="sub">{rows.length} 件</span>
          </div>
          {rows.length === 0 ? (
            <p class="dash-panel-empty">受付停止日はありません。</p>
          ) : (
            rows.map((r) => (
              <div class="closed-row">
                <span class="closed-chip">停</span>
                <span class="closed-date">
                  {formatMD(r.date)}（{weekdayOf(r.date)}）
                </span>
                <span class="closed-reason">{r.reason}</span>
                <form method="post" action={`/admin/closed/${r.date}/delete`}>
                  <button class="btn btn-sm btn-ghost" type="submit">
                    解除
                  </button>
                </form>
              </div>
            ))
          )}
        </div>
      </div>
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
