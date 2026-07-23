import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../src/index';
import { adminCookie } from './helpers';

async function createMemberAndGetToken(name: string, email: string): Promise<{ id: number; token: string }> {
  const cookie = await adminCookie();
  await app.request('/admin/members', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ name, email, member_type: 'monthly' }).toString()
  }, env);
  const row = await env.DB.prepare('SELECT id, token FROM members WHERE name = ?')
    .bind(name).first<{ id: number; token: string }>();
  if (!row) throw new Error('member not created');
  return row;
}

describe('member page', () => {
  it('有効なトークンで本人の名前入りページが表示される', async () => {
    const { token } = await createMemberAndGetToken('会員テスト', 'member@example.com');
    const res = await app.request(`/m/${token}`, {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('会員テスト');
    expect(html).toContain('月額会員');
    expect(html).toContain('あなたのリクエスト');
  });

  it('存在しないトークンは404で案内ページ', async () => {
    const res = await app.request(`/m/${'f'.repeat(40)}`, {}, env);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('このリンクは無効です');
  });

  it('無効化された会員のトークンは404', async () => {
    const { id, token } = await createMemberAndGetToken('無効化会員', 'inactive@example.com');
    await env.DB.prepare('UPDATE members SET is_active = 0 WHERE id = ?').bind(id).run();
    const res = await app.request(`/m/${token}`, {}, env);
    expect(res.status).toBe(404);
  });

  it('再発行後は旧トークンが404になり新トークンが使える', async () => {
    const { id, token: oldToken } = await createMemberAndGetToken('再発行会員', 'reissue@example.com');
    const cookie = await adminCookie();
    await app.request(`/admin/members/${id}/reissue`, { method: 'POST', headers: { cookie } }, env);
    const row = await env.DB.prepare('SELECT token FROM members WHERE id = ?')
      .bind(id).first<{ token: string }>();

    expect((await app.request(`/m/${oldToken}`, {}, env)).status).toBe(404);
    expect((await app.request(`/m/${row!.token}`, {}, env)).status).toBe(200);
  });
});
