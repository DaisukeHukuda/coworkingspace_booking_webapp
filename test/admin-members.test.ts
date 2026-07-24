import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { adminCookie } from './helpers';

interface MemberRowInTest {
  id: number;
  name: string;
  email: string;
  member_type: string;
  token: string;
  is_active: number;
}

async function createMember(
  cookie: string,
  fields: { name: string; email: string; member_type: string }
): Promise<Response> {
  return app.request('/admin/members', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(fields).toString()
  }, env);
}

describe('admin members', () => {
  it('未ログインでは /admin/members にアクセスできない', async () => {
    const res = await app.request('/admin/members', {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login');
  });

  it('会員を登録するとトークン付きで保存され、一覧に専用リンクが表示される', async () => {
    const cookie = await adminCookie();
    const res = await createMember(cookie, {
      name: '佐藤花子', email: 'sato@example.com', member_type: 'monthly'
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/members?ok=created');

    const row = await env.DB.prepare('SELECT * FROM members WHERE name = ?')
      .bind('佐藤花子').first<MemberRowInTest>();
    expect(row).not.toBeNull();
    expect(row!.token).toMatch(/^[0-9a-f]{40}$/);
    expect(row!.is_active).toBe(1);

    const list = await app.request('/admin/members', { headers: { cookie } }, env);
    expect(list.status).toBe(200);
    const html = await list.text();
    expect(html).toContain('佐藤花子');
    expect(html).toContain(`/m/${row!.token}`);
  });

  it('名前が空だと登録できない', async () => {
    const cookie = await adminCookie();
    const res = await createMember(cookie, { name: '  ', email: 'x@example.com', member_type: 'ticket' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/members?error=invalid');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE email = ?')
      .bind('x@example.com').first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it('メールアドレスの形式が不正だと登録できない', async () => {
    const cookie = await adminCookie();
    const res = await createMember(cookie, { name: '田中', email: 'not-an-email', member_type: 'ticket' });
    expect(res.headers.get('location')).toBe('/admin/members?error=invalid');
  });

  it('member_type が不正だと登録できない', async () => {
    const cookie = await adminCookie();
    const res = await createMember(cookie, { name: '田中', email: 't@example.com', member_type: 'weekly' });
    expect(res.headers.get('location')).toBe('/admin/members?error=invalid');
  });

  it('編集で名前・種別・無効化を更新できる', async () => {
    const cookie = await adminCookie();
    await createMember(cookie, { name: '編集前', email: 'edit@example.com', member_type: 'monthly' });
    const before = await env.DB.prepare('SELECT * FROM members WHERE name = ?')
      .bind('編集前').first<MemberRowInTest>();

    const res = await app.request(`/admin/members/${before!.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      // is_active チェックボックスを送らない = 無効化
      body: new URLSearchParams({ name: '編集後', email: 'edit@example.com', member_type: 'ticket' }).toString()
    }, env);
    expect(res.headers.get('location')).toBe('/admin/members?ok=updated');

    const after = await env.DB.prepare('SELECT * FROM members WHERE id = ?')
      .bind(before!.id).first<MemberRowInTest>();
    expect(after!.name).toBe('編集後');
    expect(after!.member_type).toBe('ticket');
    expect(after!.is_active).toBe(0);
    expect(after!.token).toBe(before!.token); // 編集ではトークンは変わらない
  });

  it('再発行でトークンが変わる', async () => {
    const cookie = await adminCookie();
    await createMember(cookie, { name: '再発行', email: 're@example.com', member_type: 'monthly' });
    const before = await env.DB.prepare('SELECT * FROM members WHERE name = ?')
      .bind('再発行').first<MemberRowInTest>();

    const res = await app.request(`/admin/members/${before!.id}/reissue`, {
      method: 'POST', headers: { cookie }
    }, env);
    expect(res.headers.get('location')).toBe('/admin/members?ok=reissued');

    const after = await env.DB.prepare('SELECT * FROM members WHERE id = ?')
      .bind(before!.id).first<MemberRowInTest>();
    expect(after!.token).toMatch(/^[0-9a-f]{40}$/);
    expect(after!.token).not.toBe(before!.token);
  });
});
