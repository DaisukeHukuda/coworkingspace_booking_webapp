import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { adminCookie } from './helpers';
import { currentJstDate, addDays } from '../src/core/dates';

async function seedMember(name: string): Promise<number> {
  const token = crypto.randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
  const res = await env.DB.prepare(
    `INSERT INTO members (name, email, member_type, token, is_active, created_at) VALUES (?, ?, 'monthly', ?, 1, '2026-07-26T00:00:00.000Z')`
  ).bind(name, `${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`, token).run();
  return res.meta.last_row_id as number;
}

async function seedRequest(memberId: number, date: string, start: string, end: string, status: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO requests (member_id, date, start_time, end_time, status, member_note, admin_note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', '', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z')`
  ).bind(memberId, date, start, end, status).run();
}

const today = currentJstDate();

describe('admin dashboard', () => {
  it('件数カード・今日と今後7日の確定予約・承認待ち・システム状態が表示される', async () => {
    const cookie = await adminCookie();
    const a = await seedMember('今日会員');
    const b = await seedMember('来週会員');
    const p = await seedMember('待ち会員');
    await seedRequest(a, today, '10:00', '12:00', 'confirmed');
    await seedRequest(b, addDays(today, 3), '13:00', '15:00', 'confirmed');
    await seedRequest(p, addDays(today, 5), '17:00', '18:00', 'pending');

    const res = await app.request('/admin', { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>ダッシュボード</h1>');
    expect(html).toContain('dash-warn'); // 承認待ち1件以上 → 強調カード
    expect(html).toContain('今日会員');   // 今日の予約
    expect(html).toContain('来週会員');   // 今後7日間の予約
    expect(html).toContain('待ち会員');   // 承認待ちプレビュー
    expect(html).toContain('承認待ちを開く');
    expect(html).toContain('同期無効');   // テスト環境はSquare未設定
    expect(html).toContain('直近エラーなし'); // email_log にエラーなし
  });

  it('確定以外や7日より先の予約はリストに出ない', async () => {
    const cookie = await adminCookie();
    const far = await seedMember('八日後会員');
    const cx = await seedMember('取消会員D');
    await seedRequest(far, addDays(today, 8), '10:00', '12:00', 'confirmed');
    await seedRequest(cx, today, '13:00', '15:00', 'cancelled');

    const res = await app.request('/admin', { headers: { cookie } }, env);
    const html = await res.text();
    expect(html).not.toContain('八日後会員');
    expect(html).not.toContain('取消会員D');
  });

  it('承認待ちゼロなら強調カードは出ず「承認待ちのリクエストはありません」', async () => {
    const cookie = await adminCookie();
    const res = await app.request('/admin', { headers: { cookie } }, env);
    const html = await res.text();
    expect(html).not.toContain('dash-warn');
    expect(html).toContain('承認待ちのリクエストはありません');
  });

  it('未認証ではログイン画面へリダイレクトされる', async () => {
    const res = await app.request('/admin', {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login');
  });
});
