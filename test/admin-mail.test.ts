import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { adminCookie } from './helpers';
import { getMailTemplates } from '../src/core/mailTemplates';

async function post(cookie: string, body: Record<string, string>): Promise<Response> {
  return app.request('/admin/mail', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(body).toString()
  }, env);
}

describe('admin mail templates page', () => {
  it('編集画面に5種のラベルと差し込みタグの説明が表示される', async () => {
    const cookie = await adminCookie();
    const res = await app.request('/admin/mail', { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('メール文面');
    expect(html).toContain('受付確認（会員宛）');
    expect(html).toContain('確定のお知らせ（会員宛）');
    expect(html).toContain('否認のお知らせ（会員宛）');
    expect(html).toContain('新しいリクエスト（スタッフ宛）');
    expect(html).toContain('キャンセル通知（スタッフ宛）');
    expect(html).toContain('{会員名}');
    expect(html).toContain('{スタッフメモ}');
    expect(html).toContain('空欄'); // 空欄なら標準文面の案内
  });

  it('保存すると設定に反映され、再表示で入力欄に出る', async () => {
    const cookie = await adminCookie();
    const res = await post(cookie, {
      confirmed_subject: '確定しました {日時}',
      confirmed_body: '{会員名}様 確定です',
      requested_member_subject: '', requested_member_body: '',
      requested_subject: '', requested_body: '',
      cancelled_subject: '', cancelled_body: '',
      declined_subject: '', declined_body: ''
    });
    expect(res.headers.get('location')).toBe('/admin/mail?ok=saved');

    const t = await getMailTemplates(env.DB);
    expect(t.confirmed.subject).toBe('確定しました {日時}');
    expect(t.requested_member).toEqual({ subject: '', body: '' });

    const page = await app.request('/admin/mail', { headers: { cookie } }, env);
    expect(await page.text()).toContain('確定しました {日時}');
  });

  it('件名200字超・本文4000字超は invalid で保存されない', async () => {
    const cookie = await adminCookie();
    const before = await getMailTemplates(env.DB);
    const res = await post(cookie, { confirmed_subject: 'あ'.repeat(201) });
    expect(res.headers.get('location')).toBe('/admin/mail?error=invalid');
    const res2 = await post(cookie, { confirmed_body: 'あ'.repeat(4001) });
    expect(res2.headers.get('location')).toBe('/admin/mail?error=invalid');
    expect(await getMailTemplates(env.DB)).toEqual(before); // 何も変わらない
  });

  it('未認証ではログイン画面へリダイレクトされる', async () => {
    const res = await app.request('/admin/mail', {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login');
  });
});
