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
  requested: 'リクエストを受け付けました。スタッフが確認のうえ、確定/否認をメールでお知らせします',
  cancelled: 'キャンセルしました',
  hidden: '一覧から非表示にしました'
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid: '入力内容に誤りがあります。日付と時間（30分単位・終了は開始より後）をご確認ください',
  closed: 'この日は受付を停止しています',
  duplicate: '同じ時間帯のリクエストがすでにあります',
  unavailable: 'この日はSquare側の空きがないため、現在ご案内できません'
};

const NOTE_MAX = 500;

// 同日に複数の状態があるときのドットの優先度（確定 > 申請中 > 否認）
const MARK_PRIORITY: Record<string, number> = { confirmed: 3, pending: 2, declined: 1 };

// 'YYYY-MM-DD' を「7月30日」の形式にする（会員ページの見出し表記。formatMD の「7/30」とは別書式）
function formatKanjiMD(date: string): string {
  const [, m, d] = date.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

const MemberShell = (props: { title: string; banner?: Child; children: Child }) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{props.title}</title>
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <div class="member-shell">
        <header class="member-header">
          <div class="member-header-brand">
            <span class="t1">TORCH</span>
            <span class="t2">COWORKING SPACE</span>
          </div>
          <div class="member-header-tag">
            MEMBER
            <br />
            BOOKING
          </div>
        </header>
        {props.banner}
        <main class="member-wrap">{props.children}</main>
      </div>
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
  const [closedResult, requestsResult, marksResult, selectedClosedRow, nextConfirmedRow] = await Promise.all([
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
      : Promise.resolve(null),
    // 「次回のご利用」カード用: 本人の今日以降で最も近い確定予約1件（§4-3）
    c.env.DB.prepare(
      `SELECT date, start_time, end_time FROM requests
       WHERE member_id = ? AND status = 'confirmed' AND date >= ?
       ORDER BY date, start_time LIMIT 1`
    ).bind(m.id, today).first<{ date: string; start_time: string; end_time: string }>()
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

  const banner = (
    <>
      {okParam && OK_MESSAGES[okParam] && <p class="msg-ok">{OK_MESSAGES[okParam]}</p>}
      {errorParam && ERROR_MESSAGES[errorParam] && <p class="msg-error">{ERROR_MESSAGES[errorParam]}</p>}
    </>
  );

  return c.html(
    <MemberShell title={`${m.name}さん | TORCH 会員予約`} banner={banner}>
      <div class="member-hero">
        <div class="greet">こんにちは、</div>
        <div class="name-row">
          <span class="name">{m.name} さま</span>
          <span class={TYPE_BADGE_CLASSES[m.member_type]}>{TYPE_LABELS[m.member_type]}</span>
        </div>
      </div>

      {nextConfirmedRow && (
        <div class="member-block">
          <div class="next-card">
            <div class="next-bar">
              <span class="lbl">次回のご利用</span>
              <span class="stat">確定</span>
            </div>
            <div class="next-body">
              <div class="next-date">
                {formatKanjiMD(nextConfirmedRow.date)}
                <span class="wd">（{weekdayOf(nextConfirmedRow.date)}）</span>
              </div>
              <div class="next-time">
                {nextConfirmedRow.start_time} — {nextConfirmedRow.end_time}
              </div>
              <p class="next-note">お待ちしております。当日は入口の灯りを目印にお越しください。</p>
            </div>
          </div>
        </div>
      )}

      <div class="member-block">
        <span class="eyebrow cal-eyebrow">SELECT A DAY</span>
        <div class="cal-nav">
          {month > minMonth ? (
            <a class="cal-nav-btn" href={`/m/${token}?month=${prevMonth}`} aria-label="前の月">
              &lsaquo;
            </a>
          ) : (
            <span class="cal-nav-btn is-disabled" aria-disabled="true">
              &lsaquo;
            </span>
          )}
          <span class="cal-month">
            {y}年 {Number(mo)}月
          </span>
          {month < maxMonth ? (
            <a class="cal-nav-btn" href={`/m/${token}?month=${nextMonth}`} aria-label="次の月">
              &rsaquo;
            </a>
          ) : (
            <span class="cal-nav-btn is-disabled" aria-disabled="true">
              &rsaquo;
            </span>
          )}
        </div>
        <div class="cal-grid">
          {WEEKDAY_LABELS.map((w, i) => (
            <div class={`cal-dow${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}`}>{w}</div>
          ))}
          {grid.flat().map((d) => {
            if (d === null) return <div class="cal-cell cal-empty"></div>;
            const dayNum = String(Number(d.slice(8, 10)));
            const mark = markByDate.get(d);
            const dot = mark ? <span class={`cal-dot dot-${mark}`} title={REQUEST_STATUS_LABELS[mark]}></span> : null;

            if (d < today || d > maxDate) {
              return (
                <span class="cal-cell is-off" aria-disabled="true">
                  <span class="cal-num">{dayNum}</span>
                </span>
              );
            }
            if (closedSet.has(d)) {
              return (
                <span class="cal-cell is-closed" aria-disabled="true">
                  <span class="cal-num">{dayNum}</span>
                  <span class="mark">停</span>
                  <span class="sr-only">受付停止日</span>
                  {dot}
                </span>
              );
            }
            if (emptyDates.has(d)) {
              return (
                <span class="cal-cell is-full" aria-disabled="true">
                  <span class="cal-num">{dayNum}</span>
                  <span class="mark mark-x">×</span>
                  <span class="sr-only">満席</span>
                  {dot}
                </span>
              );
            }
            const stateClass = `${d === selectedDate ? ' is-selected' : ''}${d === today ? ' is-today' : ''}`;
            return (
              <a class={`cal-cell${stateClass}`} href={`/m/${token}?date=${d}#form`}>
                <span class="cal-num">{dayNum}</span>
                {dot}
              </a>
            );
          })}
        </div>
        <p class="cal-legend">
          <span class="legend-item">
            <span class="cal-dot dot-pending"></span>申請中
          </span>
          <span class="legend-item">
            <span class="cal-dot dot-confirmed"></span>確定
          </span>
          <span class="legend-item">
            <span class="cal-dot dot-declined"></span>否認
          </span>
          <span class="legend-item">
            <span class="legend-chip">停</span>＝受付停止日
          </span>
          <span class="legend-item">
            <span class="legend-chip legend-x">×</span>＝満席
          </span>
        </p>
        <p class="member-note">
          日付を選ぶと開始・終了時刻を選べます（{formatMD(today)}〜{formatMD(maxDate)} 受付）
        </p>
        {syncEnabled && (
          <p class="member-note">
            ×の日はSquare側の空きがありません／
            {lastFetched
              ? `${formatStampJst(lastFetched)}時点の空き状況です`
              : '空き情報をまだ取得できていません。表示はまもなく更新されます'}
          </p>
        )}
      </div>

      <div class="member-block" id="form">
        {!selectedDate && (
          <div class="form-empty">
            <div class="form-empty-title">ご利用になりたい日を選んでください</div>
            <div class="form-empty-sub">上のカレンダーで日付を押すと、時間の入力欄がここに開きます。</div>
          </div>
        )}

        {selectedDate && selectedClosed && (
          <p class="msg-error">{formatKanjiMD(selectedDate)} は受付を停止しています。別の日をお選びください。</p>
        )}

        {selectedDate && !selectedClosed && (
          <>
            {syncEnabled && selectedCacheStarts === null ? (
              <div class="form-status">この日の空き情報を取得中です。しばらくたってから再度お試しください。</div>
            ) : syncEnabled && selectedCacheStarts !== null && selectedCacheStarts.length === 0 ? (
              <div class="form-status">この日はSquare側で空きがありません。別の日をお選びください。</div>
            ) : (
              <div class="form-card">
                <div class="form-bar">{formatKanjiMD(selectedDate)}（{weekdayOf(selectedDate)}）のご利用</div>
                <form class="form-body" method="post" action={`/m/${token}/requests`}>
                  <input type="hidden" name="date" value={selectedDate} />
                  <div class="form-row-2">
                    <label class="form-field">
                      <span>開始時刻</span>
                      <select name="start">
                        {startOptions.map((t) => (
                          <option value={t}>{t}</option>
                        ))}
                      </select>
                    </label>
                    <label class="form-field">
                      <span>終了時刻</span>
                      <select name="end">
                        {endOptions.map((t) => (
                          <option value={t}>{t}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <p class="form-hint">{settings.openStart}〜{settings.openEnd} の間で、30分きざみでお選びいただけます。</p>
                  <label class="form-field form-field-note">
                    <span>スタッフへのひとこと（任意・人数やご用件など）</span>
                    <textarea name="note" maxlength={NOTE_MAX}></textarea>
                  </label>
                  <button class="btn btn-primary btn-lg btn-block" type="submit">
                    リクエスト送信
                  </button>
                  <p class="form-note">
                    この時点ではまだ確定ではありません。
                    <br />
                    スタッフの確認後、メールでお知らせします。
                  </p>
                </form>
              </div>
            )}
          </>
        )}
      </div>

      <div class="member-block member-block-last">
        <div class="reqs-head">
          <h2>あなたのリクエスト</h2>
          <span class="reqs-count">{myRequests.length} 件</span>
        </div>
        {myRequests.length === 0 ? (
          <p class="member-note">まだリクエストはありません。カレンダーから日付を選んで送信してください。</p>
        ) : (
          <div class="req-cards">
            {myRequests.map((r) => {
              const muted = r.status === 'cancelled' || r.status === 'declined';
              return (
                <div class={`req-card${muted ? ' is-muted' : ''}`}>
                  <div class="req-card-top">
                    <span class="req-card-when">
                      {formatMD(r.date)} {r.start_time}〜{r.end_time}
                    </span>
                    <span class={REQUEST_BADGE_CLASSES[r.status]}>{REQUEST_STATUS_LABELS[r.status]}</span>
                  </div>
                  <div class="req-card-bottom">
                    <span class="req-card-memo">
                      {r.member_note}
                      {r.status === 'declined' && r.admin_note ? (
                        <span class="req-card-admin-note">スタッフより: {r.admin_note}</span>
                      ) : null}
                    </span>
                    {(r.status === 'pending' || r.status === 'confirmed') && (
                      <form method="post" action={`/m/${token}/requests/${r.id}/cancel`}>
                        <button class="btn btn-sm" type="submit">
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
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
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
