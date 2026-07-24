import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';

async function login(password: string): Promise<Response> {
  return app.request('/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }).toString()
  }, env);
}

describe('admin auth', () => {
  it('未ログインで /admin にアクセスするとログイン画面へリダイレクト', async () => {
    const res = await app.request('/admin', {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login');
  });

  it('ログイン画面は未ログインでも表示できる', async () => {
    const res = await app.request('/admin/login', {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('パスワード');
  });

  it('誤ったパスワードでは401でCookieが発行されない', async () => {
    const res = await login('wrong-password');
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('正しいパスワードでログインでき、Cookie付きの /admin は承認待ちへ転送される', async () => {
    const res = await login('test-password'); // vitest.config.ts の ADMIN_PASSWORD
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin');
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('admin_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=2592000'); // 30日
    const cookie = setCookie!.split(';')[0];
    const page = await app.request('/admin', { headers: { cookie } }, env);
    // ログイン済みなら /admin/login ではなく承認待ちへ転送される
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/admin/requests');
  });

  it('ログアウトするとCookieが無効化される', async () => {
    const res = await login('test-password');
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    const out = await app.request('/admin/logout', { method: 'POST', headers: { cookie } }, env);
    expect(out.status).toBe(302);
    expect(out.headers.get('location')).toBe('/admin/login');
    // Max-Age=0 のCookieが返る
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('でたらめなCookieではアクセスできない', async () => {
    const res = await app.request('/admin', { headers: { cookie: 'admin_session=123.fakesig' } }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login');
  });
});
