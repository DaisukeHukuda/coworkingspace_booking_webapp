import { env } from 'cloudflare:test';
import app from '../src/index';

export async function adminCookie(): Promise<string> {
  const res = await app.request('/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'test-password' }).toString()
  }, env);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('login failed');
  return setCookie.split(';')[0];
}
