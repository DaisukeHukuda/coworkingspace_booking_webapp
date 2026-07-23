import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../src/index';
import { adminCookie } from './helpers';

async function loginAs(ip: string, password: string): Promise<Response> {
  return app.request('/admin/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'CF-Connecting-IP': ip
    },
    body: new URLSearchParams({ password }).toString()
  }, env);
}

describe('hardening', () => {
  it('robots.txt は全クロールを拒否する', async () => {
    const res = await app.request('/robots.txt', {}, env);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('User-agent: *');
    expect(text).toContain('Disallow: /');
  });

  it('ログイン失敗が10回に達すると429になり、正しいパスワードでも弾かれる', async () => {
    const ip = '203.0.113.10';
    for (let i = 0; i < 9; i++) {
      expect((await loginAs(ip, 'wrong')).status).toBe(401);
    }
    expect((await loginAs(ip, 'wrong')).status).toBe(401); // 10回目の失敗
    const blocked = await loginAs(ip, 'test-password');
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain('しばらくしてから');
  });

  it('別IPには影響せず、ログイン成功で失敗履歴はリセットされる', async () => {
    const ip = '203.0.113.20';
    for (let i = 0; i < 3; i++) await loginAs(ip, 'wrong');
    const ok = await loginAs(ip, 'test-password');
    expect(ok.status).toBe(302);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE ip = ?').bind(ip).first<{ n: number }>();
    expect(count!.n).toBe(0);

    const other = await loginAs('203.0.113.21', 'test-password');
    expect(other.status).toBe(302);
  });

  it('存在しない会員IDの更新・再発行は notfound エラー', async () => {
    const cookie = await adminCookie();
    const upd = await app.request('/admin/members/999999', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ name: '誰か', email: 'x@example.com', member_type: 'monthly' }).toString()
    }, env);
    expect(upd.headers.get('location')).toBe('/admin/members?error=notfound');

    const re = await app.request('/admin/members/999999/reissue', { method: 'POST', headers: { cookie } }, env);
    expect(re.headers.get('location')).toBe('/admin/members?error=notfound');
  });
});
