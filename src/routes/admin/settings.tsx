import { Hono } from 'hono';
import type { Bindings } from '../../types';
import { getSettings, saveSettings, isHalfStep, halfStepRange } from '../../core/settings';
import { getCacheStatus, syncAvailability, fetchLocations, fetchBookableServices } from '../../core/square';
import type { SquareListResult } from '../../core/square';
import { formatStampJst } from '../../core/dates';
import { Layout } from './ui';

export const settingsPage = new Hono<{ Bindings: Bindings }>();

const OK_MESSAGES: Record<string, string> = {
  saved: '設定を保存しました',
  synced: 'Squareと同期しました'
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid: '入力内容に誤りがあります（メール形式・受付期間1〜365日・受付時間帯は開始<終了の30分単位）',
  sync_failed: 'Squareとの同期に失敗しました。Square設定（ロケーション/サービスID・アクセストークン）をご確認ください'
};

const ID_MAX = 128;

// 受付時間帯プルダウンの選択肢（00:00〜23:30 の30分刻み・全48個）
const OPEN_TIME_CHOICES = halfStepRange('00:00', '23:30');

function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

// SquareのID入力欄。一覧取得に成功していればプルダウン、それ以外は従来の手入力（§17.5）。
// 現在値が一覧に無い場合も「現在の値」として選択肢に残し、保存で消えないようにする。
const SquareIdField = (props: { label: string; manualLabel: string; name: string; value: string; result: SquareListResult | null }) => {
  const { result } = props;
  if (result && result.ok) {
    const inList = result.items.some((o) => o.id === props.value);
    return (
      <div class="field">
        <label>{props.label}</label>
        <select name={props.name}>
          <option value="" selected={props.value === ''}>
            （未設定）
          </option>
          {props.value !== '' && !inList && (
            <option value={props.value} selected>
              現在の値: {props.value}
            </option>
          )}
          {result.items.map((o) => (
            <option value={o.id} selected={o.id === props.value}>
              {o.name}（{o.id}）
            </option>
          ))}
        </select>
      </div>
    );
  }
  return (
    <div class="field">
      <label>{props.manualLabel}</label>
      <input type="text" name={props.name} value={props.value} maxlength={ID_MAX} />
    </div>
  );
};

settingsPage.get('/', async (c) => {
  const okParam = c.req.query('ok');
  const errorParam = c.req.query('error');
  const useSquareHelper = c.req.query('square') === '1';
  const [s, cache] = await Promise.all([getSettings(c.env.DB), getCacheStatus(c.env.DB)]);

  // 「Squareから一覧を取得」が押されたときだけAPIを呼ぶ（通常表示では呼ばない）。失敗しても例外は出ない
  let locations: SquareListResult | null = null;
  let services: SquareListResult | null = null;
  if (useSquareHelper) {
    [locations, services] = await Promise.all([fetchLocations(c.env), fetchBookableServices(c.env)]);
  }
  const helperErrors: string[] = [];
  if (locations && !locations.ok) helperErrors.push(`ロケーション: ${locations.error}`);
  if (services && !services.ok) helperErrors.push(`サービス: ${services.error}`);

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
          <label>受付時間帯（開始）— 会員はこの範囲から30分単位で時間を選びます</label>
          <select name="open_start">
            {OPEN_TIME_CHOICES.map((t) => (
              <option value={t} selected={t === s.openStart}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label>受付時間帯（終了）— 開始より後の時刻を選んでください</label>
          <select name="open_end">
            {OPEN_TIME_CHOICES.map((t) => (
              <option value={t} selected={t === s.openEnd}>
                {t}
              </option>
            ))}
          </select>
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
        <p class="small">
          <a class="btn btn-sm" href="/admin/settings?square=1">
            Squareから一覧を取得
          </a>{' '}
          <span class="muted">アクセストークン設定済みなら、ロケーションとサービスをプルダウンで選べます</span>
        </p>
        {helperErrors.length > 0 && (
          <p class="msg-error">
            Squareから一覧を取得できませんでした（{helperErrors.join(' / ')}）。
            アクセストークン（SQUARE_ACCESS_TOKEN）の設定をご確認ください。IDの直接入力は引き続き使えます。
          </p>
        )}
        <SquareIdField
          label="Square ロケーション（プルダウンで選択）"
          manualLabel="Square ロケーションID（location_id）"
          name="square_location_id"
          value={s.squareLocationId}
          result={locations}
        />
        <SquareIdField
          label="Square サービス（プルダウンで選択）"
          manualLabel="Square サービスバリエーションID（service_variation_id）"
          name="square_service_variation_id"
          value={s.squareServiceVariationId}
          result={services}
        />

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
  const openStart = typeof form.open_start === 'string' ? form.open_start.trim() : '';
  const openEnd = typeof form.open_end === 'string' ? form.open_end.trim() : '';
  const squareLocationId =
    typeof form.square_location_id === 'string' ? form.square_location_id.trim().slice(0, ID_MAX) : '';
  const squareServiceVariationId =
    typeof form.square_service_variation_id === 'string' ? form.square_service_variation_id.trim().slice(0, ID_MAX) : '';

  const windowDays = Number(windowDaysRaw);

  if (
    (staffEmail !== '' && !isValidEmail(staffEmail)) ||
    !Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365 ||
    !isHalfStep(openStart) || !isHalfStep(openEnd) || openStart >= openEnd
  ) {
    return c.redirect('/admin/settings?error=invalid');
  }

  // ステップ②持ち越し: 複数キーを1回のバッチで保存する
  await saveSettings(c.env.DB, [
    { key: 'staff_email', value: staffEmail },
    { key: 'window_days', value: String(windowDays) },
    { key: 'open_start', value: openStart },
    { key: 'open_end', value: openEnd },
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
