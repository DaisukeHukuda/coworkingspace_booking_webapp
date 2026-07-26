import { Hono } from 'hono';
import type { Bindings } from '../../types';
import { saveSettings } from '../../core/settings';
import type { SettingKey } from '../../core/settings';
import { MAIL_TEMPLATE_TYPES, MAIL_TYPE_LABELS, DEFAULT_MAIL_PREVIEWS, getMailTemplates } from '../../core/mailTemplates';
import { Layout } from './ui';

export const mailPage = new Hono<{ Bindings: Bindings }>();

const OK_MESSAGES: Record<string, string> = {
  saved: 'メール文面を保存しました'
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid: '入力内容に誤りがあります（件名200字以内・本文4000字以内）'
};

const SUBJECT_MAX = 200;
const BODY_MAX = 4000;

mailPage.get('/', async (c) => {
  const okParam = c.req.query('ok');
  const errorParam = c.req.query('error');
  const templates = await getMailTemplates(c.env.DB);

  return c.html(
    <Layout title="メール文面 | TORCH 会員予約" active="/admin/mail">
      <div class="page-head">
        <span class="eyebrow">Mail</span>
        <h1>メール文面</h1>
      </div>
      {okParam && OK_MESSAGES[okParam] && <p class="msg-ok">{OK_MESSAGES[okParam]}</p>}
      {errorParam && ERROR_MESSAGES[errorParam] && <p class="msg-error">{ERROR_MESSAGES[errorParam]}</p>}

      <p class="small">
        空欄のまま保存すると標準の文面が使われます。文面には次のタグが書けます（送信時に実際の内容へ置き換わります）:
      </p>
      <p class="small muted">
        {'{会員名}'}（会員の名前・「様」は文面側で付ける） {'{会員種別}'}（月額会員/回数券） {'{日時}'}（利用日時）{' '}
        {'{会員メモ}'}（会員のひとことメモ） {'{スタッフメモ}'}（確定時のひとこと・否認理由） {'{管理画面リンク}'}（スタッフ宛メール用）
      </p>

      <form class="card card-pad" method="post" action="/admin/mail">
        {MAIL_TEMPLATE_TYPES.map((t) => (
          <>
            <h2>{MAIL_TYPE_LABELS[t]}</h2>
            <div class="field">
              <label>件名（空欄なら標準の件名）</label>
              <input
                type="text"
                name={`${t}_subject`}
                value={templates[t].subject}
                maxlength={SUBJECT_MAX}
                placeholder={DEFAULT_MAIL_PREVIEWS[t].subject}
              />
            </div>
            <div class="field">
              <label>本文（空欄なら標準の本文）</label>
              <textarea name={`${t}_body`} rows={8} maxlength={BODY_MAX} placeholder={DEFAULT_MAIL_PREVIEWS[t].body}>
                {templates[t].body}
              </textarea>
            </div>
          </>
        ))}
        <button class="btn btn-primary btn-lg" type="submit">
          保存
        </button>
        <p class="muted small" style="margin:12px 0 0">
          タグに対応する内容が空のとき（メモ未入力など）は、その部分が空欄のまま送られます。
        </p>
      </form>
    </Layout>
  );
});

mailPage.post('/', async (c) => {
  const form = await c.req.parseBody();
  const entries: { key: SettingKey; value: string }[] = [];
  for (const t of MAIL_TEMPLATE_TYPES) {
    const subjectRaw = form[`${t}_subject`];
    const bodyRaw = form[`${t}_body`];
    const subject = typeof subjectRaw === 'string' ? subjectRaw.trim() : '';
    const body = typeof bodyRaw === 'string' ? bodyRaw.trim() : '';
    if (subject.length > SUBJECT_MAX || body.length > BODY_MAX) {
      return c.redirect('/admin/mail?error=invalid');
    }
    entries.push({ key: `mail_tpl_${t}_subject`, value: subject });
    entries.push({ key: `mail_tpl_${t}_body`, value: body });
  }
  await saveSettings(c.env.DB, entries);
  return c.redirect('/admin/mail?ok=saved');
});
