import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { adminCookie } from './helpers';
import { currentJstDate, addDays } from '../src/core/dates';

async function seedPending(name: string): Promise<{ requestId: number; email: string }> {
  const token = crypto.randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
  const email = `${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`;
  const m = await env.DB.prepare(
    `INSERT INTO members (name, email, member_type, token, is_active, created_at) VALUES (?, ?, 'monthly', ?, 1, '2026-07-23T00:00:00.000Z')`
  ).bind(name, email, token).run();
  const r = await env.DB.prepare(
    `INSERT INTO requests (member_id, date, start_time, end_time, status, member_note, admin_note, created_at, updated_at)
     VALUES (?, ?, '10:00', '13:00', 'pending', '窓side希望', '', '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z')`
  ).bind(m.meta.last_row_id, addDays(currentJstDate(), 5)).run();
  return { requestId: r.meta.last_row_id as number, email };
}

describe('admin requests', () => {
  it('未ログインでは承認待ちにアクセスできない', async () => {
    const res = await app.request('/admin/requests', {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login');
  });

  it('承認待ち一覧に申請が表示される', async () => {
    const cookie = await adminCookie();
    await seedPending('承認待ち会員');
    const res = await app.request('/admin/requests', { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('承認待ち会員');
    expect(html).toContain('窓side希望');
    expect(html).toContain('確定');
    expect(html).toContain('否認');
  });

  it('確定すると状態が変わり会員宛通知が記録される', async () => {
    const cookie = await adminCookie();
    const { requestId, email } = await seedPending('確定対象');
    const res = await app.request(`/admin/requests/${requestId}/confirm`, { method: 'POST', headers: { cookie } }, env);
    expect(res.headers.get('location')).toBe('/admin/requests?ok=confirmed');

    const row = await env.DB.prepare('SELECT status FROM requests WHERE id = ?').bind(requestId).first();
    expect(row!.status).toBe('confirmed');
    const log = await env.DB.prepare('SELECT to_address, type FROM email_log WHERE request_id = ?').bind(requestId).first();
    expect(log!.type).toBe('confirmed');
    expect(log!.to_address).toBe(email);
  });

  it('処理済みをもう一度確定しようとすると stale エラー', async () => {
    const cookie = await adminCookie();
    const { requestId } = await seedPending('二重処理');
    await app.request(`/admin/requests/${requestId}/confirm`, { method: 'POST', headers: { cookie } }, env);
    const res = await app.request(`/admin/requests/${requestId}/confirm`, { method: 'POST', headers: { cookie } }, env);
    expect(res.headers.get('location')).toBe('/admin/requests?error=stale');
  });

  it('否認は理由を保存し会員宛通知が記録される', async () => {
    const cookie = await adminCookie();
    const { requestId } = await seedPending('否認対象');
    const res = await app.request(`/admin/requests/${requestId}/decline`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ admin_note: '満席のため別日をご検討ください' }).toString()
    }, env);
    expect(res.headers.get('location')).toBe('/admin/requests?ok=declined');

    const row = await env.DB.prepare('SELECT status, admin_note FROM requests WHERE id = ?').bind(requestId).first();
    expect(row!.status).toBe('declined');
    expect(row!.admin_note).toBe('満席のため別日をご検討ください');
    const log = await env.DB.prepare('SELECT type FROM email_log WHERE request_id = ?').bind(requestId).first();
    expect(log!.type).toBe('declined');
  });
});
