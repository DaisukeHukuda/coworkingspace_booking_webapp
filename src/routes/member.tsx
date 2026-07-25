import { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import type { Bindings, MemberRow, RequestRow, RequestStatus } from '../types';
import { TYPE_LABELS, TYPE_BADGE_CLASSES } from './admin/ui';
import {
  WEEKDAY_LABELS, currentJstDate, addDays, monthOf, addMonths, buildMonthGrid,
  formatMD, isValidDate, isValidMonth, weekdayOf, formatStampJst
} from '../core/dates';
import { getSettings, timeOptions, validTimeRange } from '../core/settings';
import { getCachedStarts, getCacheStatus } from '../core/square';
import { createRequest, cancelRequestByMember, hideRequestByMember } from '../core/requests';
import { sendRequestNotification } from '../core/notify';

export const member = new Hono<{ Bindings: Bindings }>();

export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  pending: '申請中',
  confirmed: '確定',
  declined: '否認',
  cancelled: 'キャンセル済み'
};

export const REQUEST_BADGE_CLASSES: Record<RequestStatus, string> = {
  pending: 'badge badge-pending',
  confirmed: 'badge badge-confirmed',
  declined: 'badge badge-declined',
  cancelled: 'badge badge-cancelled'
};

const OK_MESSAGES: Record<string, string> = {
  requested: 'リクエストを送信しました。確定/否認の結果はメールでお知らせします',
  cancelled: 'キャンセルしました',
  hidden: '一覧から非表示にしました'
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid: '入力内容に誤りがあります。日付と時間（30分単位・終了は開始より後）をご確認ください',
  closed: 'この日は受付を停止しています',
  duplicate: 'この日時にはすでにリクエスト済みです',
  unavailable: 'この日はSquare側の空きがないため、現在ご案内できません'
};

const NOTE_MAX = 500;

// 同日に複数の状態があるときのドットの優先度（確定 > 申請中 > 否認）
const MARK_PRIORITY: Record<string, number> = { confirmed: 3, pending: 2, declined: 1 };

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

async function resolveMember(db: D1Database, token: string): Promise<MemberRow | null> {
  return db.prepare('SELECT * FROM members WHERE token = ? AND is_active = 1').bind(token).first<MemberRow>();
}

const InvalidTokenPage = () => (
  <MemberShell title="リンクが無効です | TORCH 会員予約">
    <div class="page-head">
      <h1>このリンクは無効です</h1>
    </div>
    <p>お手数ですが、TORCH（LINE公式アカウント）までお問い合わせください。</p>
  </MemberShell>
);

member.get('/:token', async (c) => {
  const token = c.req.param('token');
  const m = await resolveMember(c.env.DB, token);
  if (!m) return c.html(<InvalidTokenPage />, 404);

  const settings = await getSettings(c.env.DB);
  const syncEnabled = settings.syncEnabled;
  const today = currentJstDate();
  const maxDate = addDays(today, settings.windowDays);

  const monthParam = c.req.query('month');
  const dateParam = c.req.query('date');
  const selectedDate =
    dateParam && isValidDate(dateParam) && dateParam >= today && dateParam <= maxDate ? dateParam : null;

  const minMonth = monthOf(today);
  const maxMonth = monthOf(maxDate);
  let month = monthParam && isValidMonth(monthParam) ? monthParam : selectedDate ? monthOf(selectedDate) : minMonth;
  if (month < minMonth) month = minMonth;
  if (month > maxMonth) month = maxMonth;

  const monthStart = `${month}-01`;
  const monthEnd = addDays(`${addMonths(month, 1)}-01`, -1);
  const [closedResult, requestsResult, marksResult, selectedClosedRow] = await Promise.all([
    c.env.DB.prepare('SELECT date FROM closed_dates WHERE date >= ? AND date <= ?')
      .bind(monthStart, monthEnd).all<{ date: string }>(),
    // 一覧は会員が非表示にした行を出さない（§17.4。管理画面には残る）
    c.env.DB.prepare('SELECT * FROM requests WHERE member_id = ? AND hidden_by_member = 0 ORDER BY date DESC, start_time DESC, id DESC LIMIT 50')
      .bind(m.id).all<RequestRow>(),
    // カレンダーのマーク用: 表示月内の申請中/確定/否認（非表示行は出さない・キャンセル済みは出さない）
    c.env.DB.prepare(
      `SELECT date, status FROM requests
       WHERE member_id = ? AND date >= ? AND date <= ?
         AND status IN ('pending', 'confirmed', 'declined') AND hidden_by_member = 0`
    ).bind(m.id, monthStart, monthEnd).all<{ date: string; status: RequestStatus }>(),
    // 選択日の停止判定は表示中の月に依存させない（?month=別月&date=停止日 の組み合わせ対策）
    selectedDate !== null
      ? c.env.DB.prepare('SELECT date FROM closed_dates WHERE date = ?').bind(selectedDate).first<{ date: string }>()
      : Promise.resolve(null)
  ]);
  const closedSet = new Set(closedResult.results.map((r) => r.date));
  const myRequests = requestsResult.results;

  // 日付ごとに優先度最上位の状態を1つだけ選ぶ（§17.2: 1日1点）
  const markByDate = new Map<string, RequestStatus>();
  for (const r of marksResult.results) {
    const cur = markByDate.get(r.date);
    if (!cur || MARK_PRIORITY[r.status] > MARK_PRIORITY[cur]) markByDate.set(r.date, r.status);
  }

  // Square同期が有効なときだけ、選択日のキャッシュ有無・空き開始時刻と、取得時刻を読む。
  // selectedCacheStarts: null = 未取得（キャッシュ行なし）、[] = 満枠、[...] = 空きあり
  let selectedCacheStarts: string[] | null = null;
  let lastFetched: string | null = null;
  // §18: 表示月のうち「取得済みかつ空きゼロ」の日は、カレンダーでグレー×表示（選択不可）にする
  const emptyDates = new Set<string>();
  if (syncEnabled) {
    lastFetched = (await getCacheStatus(c.env.DB)).lastFetched;
    const monthStarts = await getCachedStarts(c.env.DB, monthStart, monthEnd);
    for (const [d, arr] of monthStarts) {
      if (arr.length === 0) emptyDates.add(d);
    }
    if (selectedDate !== null) {
      const starts = await getCachedStarts(c.env.DB, selectedDate, selectedDate);
      selectedCacheStarts = starts.has(selectedDate) ? starts.get(selectedDate)! : null;
    }
  }

  const selectedClosed = selectedClosedRow !== null;
  const grid = buildMonthGrid(month);
  const prevMonth = addMonths(month, -1);
  const nextMonth = addMonths(month, 1);
  const [y, mo] = month.split('-');

  // ステップ⑤(§17.1): 時間枠テンプレートを廃止し、受付時間帯の30分刻みから開始/終了を自由に選ぶ
  const { starts: startOptions, ends: endOptions } = timeOptions(settings.openStart, settings.openEnd);

  const okParam = c.req.query('ok');
  const errorParam = c.req.query('error');

  return c.html(
    <MemberShell title={`${m.name}さん | TORCH 会員予約`}>
      <div class="page-head">
        <span class="eyebrow">Member</span>
        <h1>{m.name} さん</h1>
        <span class={TYPE_BADGE_CLASSES[m.member_type]}>{TYPE_LABELS[m.member_type]}</span>
      </div>
      {okParam && OK_MESSAGES[okParam] && <p class="msg-ok">{OK_MESSAGES[okParam]}</p>}
      {errorParam && ERROR_MESSAGES[errorParam] && <p class="msg-error">{ERROR_MESSAGES[errorParam]}</p>}

      <div class="cal-head">
        <h2>
          {y}年{Number(mo)}月
        </h2>
        <div>
          {month > minMonth ? (
            <a class="btn btn-sm" href={`/m/${token}?month=${prevMonth}`}>
              &laquo; 前月
            </a>
          ) : null}{' '}
          {month < maxMonth ? (
            <a class="btn btn-sm" href={`/m/${token}?month=${nextMonth}`}>
              翌月 &raquo;
            </a>
          ) : null}
        </div>
      </div>
      <table class="cal">
        <thead>
          <tr>
            {WEEKDAY_LABELS.map((w, i) => (
              <th class={i === 0 ? 'sun' : i === 6 ? 'sat' : undefined}>{w}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((week) => (
            <tr>
              {week.map((d, i) => {
                const dowClass = i === 0 ? ' sun' : i === 6 ? ' sat' : '';
                if (d === null) return <td class={dowClass.trim() || undefined}></td>;
                const dayNum = String(Number(d.slice(8, 10)));
                const mark = markByDate.get(d);
                if (d < today || d > maxDate) {
                  return (
                    <td class={dowClass.trim() || undefined}>
                      <span class="day-off">{dayNum}</span>
                    </td>
                  );
                }
                if (closedSet.has(d)) {
                  return (
                    <td class={dowClass.trim() || undefined}>
                      <span class="day-off">
                        {dayNum}
                        <span class="mark">停</span>
                        {mark && <span class={`cal-dot dot-${mark}`}></span>}
                      </span>
                    </td>
                  );
                }
                if (emptyDates.has(d)) {
                  return (
                    <td class={dowClass.trim() || undefined}>
                      <span class="day-off">
                        {dayNum}
                        <span class="mark">×</span>
                        {mark && <span class={`cal-dot dot-${mark}`}></span>}
                      </span>
                    </td>
                  );
                }
                return (
                  <td class={`${d === selectedDate ? 'selected' : ''}${dowClass}`.trim() || undefined}>
                    <a href={`/m/${token}?date=${d}`}>
                      <span class="day-num">{dayNum}</span>
                      {mark && <span class={`cal-dot dot-${mark}`}></span>}
                    </a>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p class="cal-legend small">
        <span class="legend-item">
          <span class="cal-dot dot-pending"></span>申請中
        </span>
        <span class="legend-item">
          <span class="cal-dot dot-confirmed"></span>確定
        </span>
        <span class="legend-item">
          <span class="cal-dot dot-declined"></span>否認
        </span>
      </p>
      <p class="muted small">日付を選ぶと開始・終了時刻を選べます（{formatMD(today)}〜{formatMD(maxDate)} 受付）</p>
      {syncEnabled && (
        <p class="muted small">
          ×の日はSquare側の空きがありません／
          {lastFetched
            ? `${formatStampJst(lastFetched)}時点の空き状況です`
            : '空き情報をまだ取得できていません。表示はまもなく更新されます'}
        </p>
      )}

      {selectedDate && selectedClosed && (
        <p class="msg-error">{formatMD(selectedDate)} は受付を停止しています。別の日をお選びください。</p>
      )}

      {selectedDate && !selectedClosed && (
        <>
          <h2>
            {formatMD(selectedDate)}（{weekdayOf(selectedDate)}）のリクエスト
          </h2>
          {syncEnabled && selectedCacheStarts === null ? (
            <p class="muted">この日の空き情報を取得中です。しばらくたってから再度お試しください。</p>
          ) : syncEnabled && selectedCacheStarts !== null && selectedCacheStarts.length === 0 ? (
            <p class="muted">この日はSquare側で空きがありません。別の日をお選びください。</p>
          ) : (
            <form class="card card-pad" method="post" action={`/m/${token}/requests`}>
              <input type="hidden" name="date" value={selectedDate} />
              <div class="field">
                <label>開始時刻</label>
                <select name="start">
                  {startOptions.map((t) => (
                    <option value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div class="field">
                <label>終了時刻</label>
                <select name="end">
                  {endOptions.map((t) => (
                    <option value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div class="field">
                <label>ひとことメモ（任意・人数やご用件など）</label>
                <textarea name="note" maxlength={NOTE_MAX}></textarea>
              </div>
              <button class="btn btn-primary btn-lg" type="submit">
                リクエスト送信
              </button>
              <p class="muted small" style="margin:12px 0 0">
                スタッフ確認後に確定します。結果はメールでお知らせします。
              </p>
            </form>
          )}
        </>
      )}

      <h2>あなたのリクエスト</h2>
      {myRequests.length === 0 ? (
        <p class="muted">まだリクエストはありません。カレンダーから日付を選んで送信してください。</p>
      ) : (
        <div class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>日時</th>
                <th>状態</th>
                <th>メモ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {myRequests.map((r) => {
                const muted = r.status === 'cancelled' || r.status === 'declined';
                return (
                  <tr class={muted ? 'row-muted' : undefined}>
                    <td class="req-when">
                      {formatMD(r.date)} {r.start_time}〜{r.end_time}
                    </td>
                    <td>
                      <span class={REQUEST_BADGE_CLASSES[r.status]}>{REQUEST_STATUS_LABELS[r.status]}</span>
                    </td>
                    <td class="small">
                      {r.member_note}
                      {r.status === 'declined' && r.admin_note ? (
                        <div class="muted">スタッフより: {r.admin_note}</div>
                      ) : null}
                    </td>
                    <td class="actions">
                      {(r.status === 'pending' || r.status === 'confirmed') && (
                        <form method="post" action={`/m/${token}/requests/${r.id}/cancel`}>
                          <button class="btn btn-sm btn-danger" type="submit">
                            キャンセル
                          </button>
                        </form>
                      )}
                      {(r.status === 'declined' || r.status === 'cancelled') && (
                        <form method="post" action={`/m/${token}/requests/${r.id}/hide`}>
                          <button class="btn btn-sm" type="submit">
                            非表示
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </MemberShell>
  );
});

member.post('/:token/requests', async (c) => {
  const token = c.req.param('token');
  const m = await resolveMember(c.env.DB, token);
  if (!m) return c.html(<InvalidTokenPage />, 404);

  const form = await c.req.parseBody();
  const date = typeof form.date === 'string' ? form.date : '';
  const start = typeof form.start === 'string' ? form.start : '';
  const end = typeof form.end === 'string' ? form.end : '';
  const note = typeof form.note === 'string' ? form.note.trim() : '';

  const settings = await getSettings(c.env.DB);
  const today = currentJstDate();
  const maxDate = addDays(today, settings.windowDays);

  // 30分刻み・受付時間帯内・開始<終了は validTimeRange で一括検証（§17.1）
  if (
    !isValidDate(date) || date < today || date > maxDate ||
    !validTimeRange(start, end, settings.openStart, settings.openEnd) ||
    note.length > NOTE_MAX
  ) {
    return c.redirect(`/m/${token}?date=${isValidDate(date) ? date : ''}&error=invalid`);
  }

  const closed = await c.env.DB.prepare('SELECT date FROM closed_dates WHERE date = ?').bind(date).first();
  if (closed) return c.redirect(`/m/${token}?error=closed`);

  // 同期有効時は日単位で判定: その日の空き開始時刻が1つも無ければ受け付けない（未取得日も同様）。
  // 枠単位の照合は廃止（席に余裕がある運用・最終判断はスタッフの承認で行う）
  if (settings.syncEnabled) {
    const starts = await getCachedStarts(c.env.DB, date, date);
    const available = starts.get(date);
    if (available === undefined || available.length === 0) {
      return c.redirect(`/m/${token}?date=${date}&error=unavailable`);
    }
  }

  const result = await createRequest(c.env.DB, {
    memberId: m.id,
    date,
    startTime: start,
    endTime: end,
    memberNote: note
  });
  if (!result.ok) return c.redirect(`/m/${token}?date=${date}&error=duplicate`);

  // スタッフ宛の新規リクエスト通知に加え、会員本人へ受付確認を送る（§17.3。どちらも絶対に例外を投げない）
  const origin = new URL(c.req.url).origin;
  await sendRequestNotification(c.env.DB, c.env, result.id, 'requested', origin);
  await sendRequestNotification(c.env.DB, c.env, result.id, 'requested_member', origin);
  return c.redirect(`/m/${token}?ok=requested`);
});

member.post('/:token/requests/:id/cancel', async (c) => {
  const token = c.req.param('token');
  const m = await resolveMember(c.env.DB, token);
  if (!m) return c.html(<InvalidTokenPage />, 404);

  const idRaw = c.req.param('id');
  const id = /^\d{1,9}$/.test(idRaw) ? Number(idRaw) : null;
  const ok = id !== null && (await cancelRequestByMember(c.env.DB, id, m.id));
  if (ok && id !== null) {
    const origin = new URL(c.req.url).origin;
    await sendRequestNotification(c.env.DB, c.env, id, 'cancelled', origin);
  }
  return c.redirect(`/m/${token}?${ok ? 'ok=cancelled' : 'error=invalid'}`);
});

// ステップ⑤(§17.4): 終了状態（否認/キャンセル済み）の自分の行を一覧から非表示にする。メールは送らない。
member.post('/:token/requests/:id/hide', async (c) => {
  const token = c.req.param('token');
  const m = await resolveMember(c.env.DB, token);
  if (!m) return c.html(<InvalidTokenPage />, 404);

  const idRaw = c.req.param('id');
  const id = /^\d{1,9}$/.test(idRaw) ? Number(idRaw) : null;
  const ok = id !== null && (await hideRequestByMember(c.env.DB, id, m.id));
  return c.redirect(`/m/${token}?${ok ? 'ok=hidden' : 'error=invalid'}`);
});
