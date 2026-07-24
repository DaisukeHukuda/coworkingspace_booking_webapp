import { Hono } from 'hono';
import type { Bindings } from '../../types';
import { getSettings, saveSettings, parseSlotsText, slotsToText } from '../../core/settings';
import { getCacheStatus, syncAvailability } from '../../core/square';
import { formatStampJst } from '../../core/dates';
import { Layout } from './ui';

export const settingsPage = new Hono<{ Bindings: Bindings }>();

const OK_MESSAGES: Record<string, string> = {
  saved: '設定を保存しました',
  synced: 'Squareと同期しました'
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid: '入力内容に誤りがあります（メール形式・受付期間1〜365日・時間枠の形式を確認してください）',
  sync_failed: 'Squareとの同期に失敗しました。Square設定（ロケーション/サービスID・アクセストークン）をご確認ください'
};

const ID_MAX = 128;

function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

settingsPage.get('/', async (c) => {
  const okParam = c.req.query('ok');
  const errorParam = c.req.query('error');
  const [s, cache] = await Promise.all([getSettings(c.env.DB), getCacheStatus(c.env.DB)]);

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

        <h2>Square連携（両IDを空にすると同期を無効化＝手動モード）</h2>
        <p class="small">
          現在の状態:{' '}
          {s.syncEnabled ? (
            <span class="badge badge-on">同期有効</span>
          ) : (
            <span class="badge badge-off">同期無効（手動モード）</span>
          )}
          {s.syncEnabled && (
            <span class="muted">
              {' '}／ 最終取得: {cache.lastFetched ? `${formatStampJst(cache.lastFetched)}（JST）` : 'まだ取得していません'}
              {' '}／ キャッシュ {cache.days} 日分
            </span>
          )}
        </p>
        <div class="field">
          <label>Square ロケーションID（location_id）</label>
          <input type="text" name="square_location_id" value={s.squareLocationId} maxlength={ID_MAX} />
        </div>
        <div class="field">
          <label>Square サービスバリエーションID（service_variation_id）</label>
          <input type="text" name="square_service_variation_id" value={s.squareServiceVariationId} maxlength={ID_MAX} />
        </div>

        <button class="btn btn-primary btn-lg" type="submit">
          保存
        </button>
        <p class="muted small" style="margin:12px 0 0">
          メールの差出人アドレス・ResendのAPIキー・Squareのアクセストークンはサーバー側の環境変数（RESEND_API_KEY / NOTIFY_EMAIL_FROM / SQUARE_ACCESS_TOKEN）で設定します。
        </p>
      </form>

      <h2>今すぐ同期</h2>
      <form class="card card-pad" method="post" action="/admin/settings/sync">
        <p class="small">
          Squareから最新の空き枠を今すぐ取得します（通常は15分ごとに自動取得）。設定直後の結合確認に使えます。
        </p>
        <button class="btn" type="submit">
          今すぐ同期する
        </button>
      </form>
    </Layout>
  );
});

settingsPage.post('/', async (c) => {
  const form = await c.req.parseBody();
  const staffEmail = typeof form.staff_email === 'string' ? form.staff_email.trim() : '';
  const windowDaysRaw = typeof form.window_days === 'string' ? form.window_days.trim() : '';
  const slotsText = typeof form.slots_text === 'string' ? form.slots_text : '';
  const squareLocationId =
    typeof form.square_location_id === 'string' ? form.square_location_id.trim().slice(0, ID_MAX) : '';
  const squareServiceVariationId =
    typeof form.square_service_variation_id === 'string' ? form.square_service_variation_id.trim().slice(0, ID_MAX) : '';

  const windowDays = Number(windowDaysRaw);
  const slots = parseSlotsText(slotsText);

  if (
    (staffEmail !== '' && !isValidEmail(staffEmail)) ||
    !Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365 ||
    slots === null
  ) {
    return c.redirect('/admin/settings?error=invalid');
  }

  // ステップ②持ち越し: 複数キーを1回のバッチで保存する
  await saveSettings(c.env.DB, [
    { key: 'staff_email', value: staffEmail },
    { key: 'window_days', value: String(windowDays) },
    { key: 'slots', value: JSON.stringify(slots) },
    { key: 'square_location_id', value: squareLocationId },
    { key: 'square_service_variation_id', value: squareServiceVariationId }
  ]);
  return c.redirect('/admin/settings?ok=saved');
});

// 「今すぐ同期」。syncAvailability を即時実行し、結果を画面に反映する（結合確認にも使う）。
settingsPage.post('/sync', async (c) => {
  const result = await syncAvailability(c.env.DB, c.env);
  return c.redirect(`/admin/settings?${result.ok ? 'ok=synced' : 'error=sync_failed'}`);
});
