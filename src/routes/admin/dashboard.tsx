import { Hono } from 'hono';
import type { Bindings, MemberType } from '../../types';
import { getSettings } from '../../core/settings';
import { getCacheStatus } from '../../core/square';
import { currentJstDate, addDays, formatMD, weekdayOf, formatStampJst } from '../../core/dates';
import { Layout, TYPE_LABELS, TYPE_BADGE_CLASSES } from './ui';

export const dashboard = new Hono<{ Bindings: Bindings }>();

interface BookingRow {
  id: number;
  date: string;
  start_time: string;
  end_time: string;
  member_name: string;
  member_type: MemberType;
}

const JOIN_SQL = `SELECT r.id, r.date, r.start_time, r.end_time, m.name AS member_name, m.member_type
  FROM requests r JOIN members m ON m.id = r.member_id`;

// 管理画面トップのダッシュボード（§20・UIリスタイルR3で§5に合わせて見た目のみ更新）。読み取り専用・操作は各ページへのリンクのみ。
dashboard.get('/', async (c) => {
  const today = currentJstDate();
  const weekEnd = addDays(today, 7);

  const [pendingCountRow, todayResult, upcomingResult, pendingResult, memberCountRow, emailErrRow, settings, cache] =
    await Promise.all([
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM requests WHERE status = 'pending'`).first<{ n: number }>(),
      c.env.DB.prepare(`${JOIN_SQL} WHERE r.status = 'confirmed' AND r.date = ? ORDER BY r.start_time, r.id`)
        .bind(today).all<BookingRow>(),
      c.env.DB.prepare(`${JOIN_SQL} WHERE r.status = 'confirmed' AND r.date > ? AND r.date <= ? ORDER BY r.date, r.start_time, r.id`)
        .bind(today, weekEnd).all<BookingRow>(),
      c.env.DB.prepare(`${JOIN_SQL} WHERE r.status = 'pending' ORDER BY r.created_at, r.id LIMIT 5`).all<BookingRow>(),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE is_active = 1').first<{ n: number }>(),
      // 直近10件のメール送信のうちエラーの数（送信の健康状態の簡易チェック）
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT status FROM email_log ORDER BY id DESC LIMIT 10) WHERE status = 'error'`)
        .first<{ n: number }>(),
      getSettings(c.env.DB),
      getCacheStatus(c.env.DB)
    ]);

  const pendingCount = pendingCountRow?.n ?? 0;
  const memberCount = memberCountRow?.n ?? 0;
  const emailErrors = emailErrRow?.n ?? 0;
  const todayRows = todayResult.results;
  const upcomingRows = upcomingResult.results;
  const pendingRows = pendingResult.results;

  return c.html(
    <Layout title="ダッシュボード | TORCH 会員予約" active="/admin">
      <div class="page-head">
        <span class="eyebrow">Dashboard</span>
        <h1>ダッシュボード</h1>
      </div>

      <div class="dash-grid">
        <a class={`dash-card${pendingCount > 0 ? ' dash-warn' : ''}`} href="/admin/requests">
          <span class="dash-label">承認待ち</span>
          <span>
            <span class="dash-num">{pendingCount}</span>
            <span class="dash-unit">件</span>
          </span>
          {pendingCount > 0 && <span class="dash-tag">要対応</span>}
        </a>
        <div class="dash-card">
          <span class="dash-label">今日の確定予約</span>
          <span>
            <span class="dash-num">{todayRows.length}</span>
            <span class="dash-unit">件</span>
          </span>
        </div>
        <div class="dash-card">
          <span class="dash-label">今後7日の確定予約</span>
          <span>
            <span class="dash-num">{upcomingRows.length}</span>
            <span class="dash-unit">件</span>
          </span>
        </div>
        <div class="dash-card">
          <span class="dash-label">有効会員</span>
          <span>
            <span class="dash-num">{memberCount}</span>
            <span class="dash-unit">名</span>
          </span>
        </div>
      </div>

      <div class="dash-cols">
        <div class="dash-col">
          <div class="dash-panel">
            <div class="dash-panel-head">
              <span>今日の予約（確定）</span>
              <span class="sub">
                {todayRows.length}件 / {today}
              </span>
            </div>
            {todayRows.length === 0 ? (
              <p class="dash-panel-empty">今日の確定予約はありません。</p>
            ) : (
              todayRows.map((r, i) => (
                <div class={`dash-row${i % 2 === 1 ? ' zebra' : ''}`}>
                  <span class="dash-time">
                    {r.start_time}〜{r.end_time}
                  </span>
                  <span class="dash-name">{r.member_name}</span>
                  <span class={TYPE_BADGE_CLASSES[r.member_type]}>{TYPE_LABELS[r.member_type]}</span>
                </div>
              ))
            )}
          </div>

          <div class="dash-panel">
            <div class="dash-panel-head">
              <span>今後7日間の予約（確定）</span>
              <span class="sub">{upcomingRows.length}件</span>
            </div>
            {upcomingRows.length === 0 ? (
              <p class="dash-panel-empty">今後7日間の確定予約はありません。</p>
            ) : (
              upcomingRows.map((r, i) => (
                <div class={`dash-row${i % 2 === 1 ? ' zebra' : ''}`}>
                  <span class="dash-day">
                    {formatMD(r.date)}（{weekdayOf(r.date)}）
                  </span>
                  <span class="dash-time-sm">
                    {r.start_time}〜{r.end_time}
                  </span>
                  <span class="dash-name">{r.member_name}</span>
                  <span class={TYPE_BADGE_CLASSES[r.member_type]}>{TYPE_LABELS[r.member_type]}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div class="dash-col">
          <div class="dash-panel">
            <div class="dash-panel-head is-wait">
              <span>承認待ち</span>
              <span class="sub">{pendingCount}件</span>
            </div>
            {pendingRows.length === 0 ? (
              <p class="dash-panel-empty">承認待ちのリクエストはありません。</p>
            ) : (
              pendingRows.map((r) => (
                <div class="dash-pending-row">
                  <div class="dash-pending-when">
                    <span class="when">
                      {formatMD(r.date)}（{weekdayOf(r.date)}）{r.start_time}〜{r.end_time}
                    </span>
                    <span class="name">{r.member_name}</span>
                  </div>
                </div>
              ))
            )}
            <div class="dash-panel-foot">
              <a class="btn btn-primary btn-block" href="/admin/requests">
                承認待ちを開く
              </a>
            </div>
          </div>

          <div class="dash-panel">
            <div class="dash-panel-head">
              <span>システムの状態</span>
            </div>
            <div class="dash-sys-row">
              <span class="lbl">Square 同期</span>
              <span>
                {settings.syncEnabled ? (
                  <span class="badge badge-on">同期有効</span>
                ) : (
                  <span class="badge badge-off">同期無効（手動モード）</span>
                )}
                {settings.syncEnabled && (
                  <span class="muted">
                    {' '}（最終取得: {cache.lastFetched ? `${formatStampJst(cache.lastFetched)}（JST）` : 'まだ取得していません'}）
                  </span>
                )}
              </span>
            </div>
            <div class="dash-sys-row">
              <span class="lbl">メール送信</span>
              {emailErrors > 0 ? (
                <span class="badge badge-declined">直近10件中 {emailErrors} 件のエラー</span>
              ) : (
                <span class="muted">直近エラーなし</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
});
