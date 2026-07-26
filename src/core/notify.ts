import { getSettings } from './settings';
import { getMailTemplates, renderTemplate, MAIL_TEMPLATE_TYPES } from './mailTemplates';
import type { MailTemplateType } from './mailTemplates';

export type EmailType = 'requested' | 'requested_member' | 'cancelled' | 'confirmed' | 'declined' | 'sync_stale';

interface NotifyEnv {
  RESEND_API_KEY?: string;
  NOTIFY_EMAIL_FROM?: string;
  APP_ORIGIN?: string;
}

interface RequestInfo {
  id: number;
  date: string;
  start_time: string;
  end_time: string;
  status: string;
  member_note: string;
  admin_note: string;
  member_name: string;
  member_type: string;
  member_email: string;
}

const MEMBER_TYPE_LABELS: Record<string, string> = { monthly: '月額会員', ticket: '回数券' };

// リクエストに関する通知メールを送る。絶対に例外を投げない（メール失敗で本処理を失敗させないため）。
// APIキーまたは宛先が無ければ送信せず email_log に skipped を記録する（booking-system の実証パターン）。
export async function sendRequestNotification(
  db: D1Database,
  env: NotifyEnv,
  requestId: number,
  type: EmailType,
  origin: string,
  fetcher: typeof fetch = fetch
): Promise<void> {
  try {
    const r = await db.prepare(
      `SELECT r.id, r.date, r.start_time, r.end_time, r.status, r.member_note, r.admin_note,
              m.name AS member_name, m.member_type, m.email AS member_email
       FROM requests r JOIN members m ON m.id = r.member_id
       WHERE r.id = ?`
    ).bind(requestId).first<RequestInfo>();
    if (!r) return;

    const { staffEmail } = await getSettings(db);
    const when = `${r.date} ${r.start_time}〜${r.end_time}`;
    const typeLabel = MEMBER_TYPE_LABELS[r.member_type] ?? r.member_type;
    // ステップ②持ち越し: 本番は APP_ORIGIN を優先し、無ければリクエストoriginを使う
    const linkBase = env.APP_ORIGIN ?? origin;

    let to: string;
    let subject: string;
    let lines: string[];

    if (type === 'requested' || type === 'cancelled') {
      to = staffEmail;
      if (type === 'requested') {
        subject = `【TORCH 会員予約】新しい利用リクエスト: ${when} ${r.member_name}様`;
        lines = [
          '新しい利用リクエストが届きました。',
          '',
          `会員: ${r.member_name}様（${typeLabel}）`,
          `日時: ${when}`,
          r.member_note ? `メモ: ${r.member_note}` : '',
          '',
          `管理画面で確定/否認してください: ${linkBase}/admin/requests`
        ];
      } else {
        subject = `【TORCH 会員予約】キャンセル: ${when} ${r.member_name}様`;
        lines = [
          '会員がリクエストをキャンセルしました。',
          '',
          `会員: ${r.member_name}様（${typeLabel}）`,
          `日時: ${when}`,
          '',
          `一覧: ${linkBase}/admin/requests/all`
        ];
      }
    } else if (type === 'requested_member') {
      // ステップ⑤(§17.3): 会員本人への受付確認（スタッフ宛 requested とは別に送る）
      to = r.member_email;
      subject = `【TORCH】リクエストを受け付けました: ${when}`;
      lines = [
        `${r.member_name}様`,
        '',
        '以下のご利用リクエストを受け付けました。スタッフが確認のうえ、確定/否認の結果を追ってメールでお知らせします。',
        '',
        `日時: ${when}`,
        r.member_note ? `メモ: ${r.member_note}` : '',
        '',
        '変更やキャンセルはご自身の専用ページ、またはLINEでご連絡ください。'
      ];
    } else {
      to = r.member_email;
      if (type === 'confirmed') {
        subject = `【TORCH】ご利用リクエスト確定: ${when}`;
        lines = [
          `${r.member_name}様`,
          '',
          '以下のご利用リクエストが確定しました。当日のご来館をお待ちしております。',
          '',
          `日時: ${when}`,
          r.admin_note ? `スタッフより: ${r.admin_note}` : '',
          '',
          '変更やキャンセルはご自身の専用ページ、またはLINEでご連絡ください。'
        ];
      } else {
        subject = `【TORCH】ご利用リクエストについて: ${when}`;
        lines = [
          `${r.member_name}様`,
          '',
          '申し訳ありません。以下のご利用リクエストは確定できませんでした。',
          '',
          `日時: ${when}`,
          r.admin_note ? `理由: ${r.admin_note}` : '',
          '',
          '別の日時でのリクエストをご検討ください。ご不明な点はLINEでお気軽にご連絡ください。'
        ];
      }
    }

    let text = lines.filter((line) => line !== '').join('\n');

    // §19: 管理画面で編集されたテンプレートがあれば件名・本文を差し替える。
    // 読込や置換に失敗しても標準文面で続行する（メールは絶対に例外を投げない）。
    try {
      if ((MAIL_TEMPLATE_TYPES as readonly string[]).includes(type)) {
        const templates = await getMailTemplates(db);
        const tpl = templates[type as MailTemplateType];
        const vars: Record<string, string> = {
          '会員名': r.member_name,
          '会員種別': typeLabel,
          '日時': when,
          '会員メモ': r.member_note,
          'スタッフメモ': r.admin_note,
          '管理画面リンク': `${linkBase}${type === 'cancelled' ? '/admin/requests/all' : '/admin/requests'}`
        };
        if (tpl.subject.trim() !== '') subject = renderTemplate(tpl.subject, vars);
        if (tpl.body.trim() !== '') text = renderTemplate(tpl.body, vars);
      }
    } catch {
      // テンプレートが読めなくても標準文面のまま送る
    }

    if (!env.RESEND_API_KEY || !to) {
      await logEmail(db, requestId, to, type, 'skipped', null);
      return;
    }

    try {
      const res = await fetcher('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          from: env.NOTIFY_EMAIL_FROM ?? 'onboarding@resend.dev',
          to: [to],
          subject,
          text
        })
      });
      if (res.ok) {
        await logEmail(db, requestId, to, type, 'sent', null);
      } else {
        await logEmail(db, requestId, to, type, 'error', `HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (e) {
      await logEmail(db, requestId, to, type, 'error', e instanceof Error ? e.message : String(e));
    }
  } catch {
    // ログ書き込みすら失敗しても呼び出し元には影響させない
  }
}

// 同期が24時間以上停止したことをスタッフに知らせる（scheduled から呼ぶ）。
// リクエストに紐づかない通知なので email_log の request_id は 0 で記録する。絶対に例外を投げない。
// §19対象外: システム通知のため文面は固定。
export async function sendSyncStaleNotification(
  db: D1Database,
  env: NotifyEnv,
  origin: string,
  fetcher: typeof fetch = fetch
): Promise<void> {
  try {
    const { staffEmail } = await getSettings(db);
    const linkBase = env.APP_ORIGIN ?? origin;
    const subject = '【TORCH 会員予約】Squareの空き情報の同期が停止しています';
    const lines = [
      'Squareからの空き情報の取得が24時間以上できていません。',
      '会員ページには前回取得時点の空き状況が表示され続けます。',
      '',
      'Square側の設定（アクセストークン・ロケーション/サービスID）や通信状況をご確認ください。',
      linkBase ? `設定画面: ${linkBase}/admin/settings` : '設定画面: /admin/settings'
    ];
    const text = lines.join('\n');

    if (!env.RESEND_API_KEY || !staffEmail) {
      await logEmail(db, 0, staffEmail, 'sync_stale', 'skipped', null); // request_id 0 = リクエスト非依存
      return;
    }

    try {
      const res = await fetcher('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          from: env.NOTIFY_EMAIL_FROM ?? 'onboarding@resend.dev',
          to: [staffEmail],
          subject,
          text
        })
      });
      if (res.ok) {
        await logEmail(db, 0, staffEmail, 'sync_stale', 'sent', null);
      } else {
        await logEmail(db, 0, staffEmail, 'sync_stale', 'error', `HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (e) {
      await logEmail(db, 0, staffEmail, 'sync_stale', 'error', e instanceof Error ? e.message : String(e));
    }
  } catch {
    // ログ書き込みすら失敗しても呼び出し元には影響させない
  }
}

function logEmail(db: D1Database, requestId: number, to: string, type: string, status: string, error: string | null) {
  return db.prepare(
    `INSERT INTO email_log (request_id, to_address, type, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(requestId, to, type, status, error, new Date().toISOString()).run();
}
