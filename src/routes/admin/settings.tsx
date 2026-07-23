import { Hono } from 'hono';
import type { Bindings } from '../../types';
import { getSettings, setSetting, parseSlotsText, slotsToText } from '../../core/settings';
import { Layout } from './ui';

export const settingsPage = new Hono<{ Bindings: Bindings }>();

const OK_MESSAGES: Record<string, string> = {
  saved: '設定を保存しました'
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid: '入力内容に誤りがあります（メール形式・受付期間1〜365日・時間枠の形式を確認してください）'
};

function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

settingsPage.get('/', async (c) => {
  const okParam = c.req.query('ok');
  const errorParam = c.req.query('error');
  const s = await getSettings(c.env.DB);

  return c.html(
    <Layout title="設定 | TORCH 会員予約" active="/admin/settings">
      <div class="page-head">
        <span class="eyebrow">Settings</span>
        <h1>設定</h1>
      </div>
      {okParam && OK_MESSAGES[okParam] && <p class="msg-ok">{OK_MESSAGES[okParam]}</p>}
      {errorParam && ERROR_MESSAGES[errorParam] && <p class="msg-error">{ERROR_MESSAGES[errorParam]}</p>}

      <form class="card card-pad" method="post" action="/admin/settings">
        <div class="field">
          <label>スタッフ通知先メールアドレス（リクエスト・キャンセルの通知が届きます。空なら通知しません）</label>
          <input type="email" name="staff_email" value={s.staffEmail} />
        </div>
        <div class="field">
          <label>受付可能期間（何日先まで受け付けるか。1〜365）</label>
          <input type="number" name="window_days" min={1} max={365} value={s.windowDays} required />
        </div>
        <div class="field">
          <label>時間枠テンプレート（1行1枠・「10:00-13:00」の形式・開始時刻順でなくてもOK）</label>
          <textarea name="slots_text" rows={5} required>{slotsToText(s.slots)}</textarea>
        </div>
        <button class="btn btn-primary btn-lg" type="submit">
          保存
        </button>
        <p class="muted small" style="margin:12px 0 0">
          メールの差出人アドレスとResendのAPIキーはサーバー側の環境変数（RESEND_API_KEY / NOTIFY_EMAIL_FROM）で設定します。
        </p>
      </form>
    </Layout>
  );
});

settingsPage.post('/', async (c) => {
  const form = await c.req.parseBody();
  const staffEmail = typeof form.staff_email === 'string' ? form.staff_email.trim() : '';
  const windowDaysRaw = typeof form.window_days === 'string' ? form.window_days.trim() : '';
  const slotsText = typeof form.slots_text === 'string' ? form.slots_text : '';

  const windowDays = Number(windowDaysRaw);
  const slots = parseSlotsText(slotsText);

  if (
    (staffEmail !== '' && !isValidEmail(staffEmail)) ||
    !Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365 ||
    slots === null
  ) {
    return c.redirect('/admin/settings?error=invalid');
  }

  await setSetting(c.env.DB, 'staff_email', staffEmail);
  await setSetting(c.env.DB, 'window_days', String(windowDays));
  await setSetting(c.env.DB, 'slots', JSON.stringify(slots));
  return c.redirect('/admin/settings?ok=saved');
});
