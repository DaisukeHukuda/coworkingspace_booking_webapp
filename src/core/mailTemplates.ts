// メール文面テンプレート（§19）。settings テーブルの mail_tpl_* キーに保存する。
// 空文字 = 未設定 = 標準文面（notify.ts 内蔵）を使う。

export const MAIL_TEMPLATE_TYPES = ['requested', 'requested_member', 'cancelled', 'confirmed', 'declined'] as const;
export type MailTemplateType = (typeof MAIL_TEMPLATE_TYPES)[number];

export interface MailTemplate {
  subject: string; // '' = 未設定
  body: string;    // '' = 未設定
}

export const MAIL_TYPE_LABELS: Record<MailTemplateType, string> = {
  requested: '新しいリクエスト（スタッフ宛）',
  requested_member: '受付確認（会員宛）',
  cancelled: 'キャンセル通知（スタッフ宛）',
  confirmed: '確定のお知らせ（会員宛）',
  declined: '否認のお知らせ（会員宛）'
};

// 編集画面に薄く表示する標準文面（タグ表記）。実際の標準文面は notify.ts が組み立てる
// （メモ等が空のとき行ごと省く挙動があるため、ここは表示用の参考テキスト）。
export const DEFAULT_MAIL_PREVIEWS: Record<MailTemplateType, MailTemplate> = {
  requested: {
    subject: '【TORCH 会員予約】新しい利用リクエスト: {日時} {会員名}様',
    body: '新しい利用リクエストが届きました。\n\n会員: {会員名}様（{会員種別}）\n日時: {日時}\nメモ: {会員メモ}\n\n管理画面で確定/否認してください: {管理画面リンク}'
  },
  requested_member: {
    subject: '【TORCH】リクエストを受け付けました: {日時}',
    body: '{会員名}様\n\n以下のご利用リクエストを受け付けました。スタッフが確認のうえ、確定/否認の結果を追ってメールでお知らせします。\n\n日時: {日時}\nメモ: {会員メモ}\n\n変更やキャンセルはご自身の専用ページ、またはLINEでご連絡ください。'
  },
  cancelled: {
    subject: '【TORCH 会員予約】キャンセル: {日時} {会員名}様',
    body: '会員がリクエストをキャンセルしました。\n\n会員: {会員名}様（{会員種別}）\n日時: {日時}\n\n一覧: {管理画面リンク}'
  },
  confirmed: {
    subject: '【TORCH】ご利用リクエスト確定: {日時}',
    body: '{会員名}様\n\n以下のご利用リクエストが確定しました。当日のご来館をお待ちしております。\n\n日時: {日時}\nスタッフより: {スタッフメモ}\n\n変更やキャンセルはご自身の専用ページ、またはLINEでご連絡ください。'
  },
  declined: {
    subject: '【TORCH】ご利用リクエストについて: {日時}',
    body: '{会員名}様\n\n申し訳ありません。以下のご利用リクエストは確定できませんでした。\n\n日時: {日時}\n理由: {スタッフメモ}\n\n別の日時でのリクエストをご検討ください。ご不明な点はLINEでお気軽にご連絡ください。'
  }
};

// 保存済みテンプレートを読み出す。行が無いキーは '' で返す。
export async function getMailTemplates(db: D1Database): Promise<Record<MailTemplateType, MailTemplate>> {
  const result = await db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'mail_tpl_%'`)
    .all<{ key: string; value: string }>();
  const map = new Map(result.results.map((r) => [r.key, r.value]));
  const out = {} as Record<MailTemplateType, MailTemplate>;
  for (const t of MAIL_TEMPLATE_TYPES) {
    out[t] = {
      subject: map.get(`mail_tpl_${t}_subject`) ?? '',
      body: map.get(`mail_tpl_${t}_body`) ?? ''
    };
  }
  return out;
}

// {タグ} を実際の値に置換する。未知のタグはそのまま残す（送信は失敗させない）。
export function renderTemplate(text: string, vars: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, v);
  }
  return out;
}
