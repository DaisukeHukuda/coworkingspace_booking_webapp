import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { adminCookie } from './helpers';

async function seedMemberWithRequests(name: string, rows: { date: string; status: string }[]): Promise<number> {
  const token = crypto.randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
  const m = await env.DB.prepare(
    `INSERT INTO members (name, email, member_type, token, is_active, created_at) VALUES (?, ?, 'ticket', ?, 1, '2026-07-23T00:00:00.000Z')`
  ).bind(name, `${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`, token).run();
  const memberId = m.meta.last_row_id as number;
  for (const r of rows) {
    await env.DB.prepare(
      `INSERT INTO requests (member_id, date, start_time, end_time, status, member_note, admin_note, created_at, updated_at)
       VALUES (?, ?, '10:00', '13:00', ?, '', '', '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z')`
    ).bind(memberId, r.date, r.status).run();
  }
  return memberId;
}

describe('admin requests list', () => {
  it('一覧は全状態を表示する', async () => {
    const cookie = await adminCookie();
    await seedMemberWithRequests('一覧会員', [
      { date: '2026-09-01', status: 'pending' },
      { date: '2026-09-02', status: 'confirmed' },
      { date: '2026-09-03', status: 'declined' }
    ]);
    const res = await app.request('/admin/requests/all', { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('一覧会員');
    expect(html).toContain('申請中');
    expect(html).toContain('確定');
    expect(html).toContain('否認');
  });

  it('状態で絞り込める', async () => {
    const cookie = await adminCookie();
    await seedMemberWithRequests('状態絞込', [
      { date: '2026-09-04', status: 'confirmed' },
      { date: '2026-09-05', status: 'cancelled' }
    ]);
    const res = await app.request('/admin/requests/all?status=cancelled', { headers: { cookie } }, env);
    const html = await res.text();
    expect(html).toContain('9/5');
    expect(html).not.toContain('9/4');
  });

  it('会員と期間で絞り込める', async () => {
    const cookie = await adminCookie();
    const idA = await seedMemberWithRequests('会員甲', [{ date: '2026-09-10', status: 'pending' }]);
    await seedMemberWithRequests('会員乙', [{ date: '2026-09-11', status: 'pending' }]);

    const byMember = await app.request(`/admin/requests/all?member_id=${idA}`, { headers: { cookie } }, env);
    const htmlA = await byMember.text();
    // 絞り込みフォームの会員ドロップダウンには全会員名が並ぶため、行の有無は利用日で判定する
    expect(htmlA).toContain('9/10');
    expect(htmlA).not.toContain('9/11');

    const byRange = await app.request('/admin/requests/all?from=2026-09-11&to=2026-09-11', { headers: { cookie } }, env);
    const htmlB = await byRange.text();
    expect(htmlB).toContain('9/11');
    expect(htmlB).not.toContain('9/10');
  });

  it('不正なパラメータは無視して全件表示する', async () => {
    const cookie = await adminCookie();
    const res = await app.request('/admin/requests/all?status=bogus&from=notadate&member_id=x', { headers: { cookie } }, env);
    expect(res.status).toBe(200);
  });
});
