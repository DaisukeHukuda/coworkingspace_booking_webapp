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

// カード見出し行の宛先表示（UI専用の区分。notes.md §逸脱4: キャンセル通知もスタッフ宛として扱う）
const MAIL_TYPE_AUDIENCE: Record<(typeof MAIL_TEMPLATE_TYPES)[number], 'staff' | 'member'> = {
  requested: 'staff',
  requested_member: 'member',
  cancelled: 'staff',
  confirmed: 'member',
  declined: 'member'
};

const MAIL_TAGS: { tag: string; desc: string }[] = [
  { tag: '{会員名}', desc: '会員の名前・「様」は文面側で付ける' },
  { tag: '{会員種別}', desc: '月額会員/回数券' },
  { tag: '{日時}', desc: '利用日時' },
  { tag: '{会員メモ}', desc: '会員のひとことメモ' },
  { tag: '{スタッフメモ}', desc: '確定時のひとこと・否認理由' },
  { tag: '{管理画面リンク}', desc: 'スタッフ宛メール用' }
];

mailPage.get('/', async (c) => {
  const okParam = c.req.query('ok');
  const errorParam = c.req.query('error');
  const templates = await getMailTemplates(c.env.DB);

  return c.html(
    <Layout title="メール文面 | TORCH 会員予約" active="/admin/mail">
      <div class="page-head">
        <span class="eyebrow">Mail Templates</span>
        <h1>メール文面</h1>
      </div>
      {okParam && OK_MESSAGES[okParam] && <p class="msg-ok">{OK_MESSAGES[okParam]}</p>}
      {errorParam && ERROR_MESSAGES[errorParam] && <p class="msg-error">{ERROR_MESSAGES[errorParam]}</p>}

      <p class="small">
        空欄のまま保存すると標準の文面が使われます。文面には次のタグが書けます（送信時に実際の内容へ置き換わります）。
      </p>
      <div class="mail-tags">
        {MAIL_TAGS.map((t) => (
          <span class="mail-tag">
            <span class="tag">{t.tag}</span>
            <span class="desc">{t.desc}</span>
          </span>
        ))}
      </div>

      <form method="post" action="/admin/mail">
        <div class="mail-grid">
          {MAIL_TEMPLATE_TYPES.map((t) => {
            const isStaff = MAIL_TYPE_AUDIENCE[t] === 'staff';
            return (
              <div class="mail-card">
                <div class={`mail-card-head${isStaff ? ' is-staff' : ''}`}>
                  <span class="title">{MAIL_TYPE_LABELS[t]}</span>
                  <span class="to">{isStaff ? 'TO STAFF' : 'TO MEMBER'}</span>
                </div>
                <div class="mail-card-body">
                  <label class="mail-field">
                    <span>件名（空欄なら標準の件名）</span>
                    <input
                      type="text"
                      name={`${t}_subject`}
                      value={templates[t].subject}
                      maxlength={SUBJECT_MAX}
                      placeholder={DEFAULT_MAIL_PREVIEWS[t].subject}
                    />
                  </label>
                  <label class="mail-field">
                    <span>本文（空欄なら標準の本文）</span>
                    <textarea name={`${t}_body`} rows={8} maxlength={BODY_MAX} placeholder={DEFAULT_MAIL_PREVIEWS[t].body}>
                      {templates[t].body}
                    </textarea>
                  </label>
                </div>
              </div>
            );
          })}
        </div>
        <div class="mail-submit">
          <button class="btn btn-primary btn-lg" type="submit">
            文面を保存する
          </button>
        </div>
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
