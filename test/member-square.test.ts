import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { adminCookie } from './helpers';
import { setSetting } from '../src/core/settings';
import { currentJstDate, addDays } from '../src/core/dates';

async function createMember(name: string): Promise<{ id: number; token: string }> {
  const cookie = await adminCookie();
  await app.request('/admin/members', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ name, email: `${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`, member_type: 'monthly' }).toString()
  }, env);
  const row = await env.DB.prepare('SELECT id, token FROM members WHERE name = ?').bind(name).first<{ id: number; token: string }>();
  if (!row) throw new Error('member not created');
  return row;
}

async function enableSync(): Promise<void> {
  await setSetting(env.DB, 'square_location_id', 'LOC');
  await setSetting(env.DB, 'square_service_variation_id', 'SV');
}

async function seedCache(date: string, starts: string[], fetchedAt = '2026-07-24T00:30:00.000Z'): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO availability_cache (date, slots_json, fetched_at) VALUES (?, ?, ?)')
    .bind(date, JSON.stringify(starts), fetchedAt).run();
}

async function postRequest(token: string, body: Record<string, string>): Promise<Response> {
  return app.request(`/m/${token}/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  }, env);
}

const target = addDays(currentJstDate(), 5);

describe('member page with Square sync', () => {
  it('同期有効: キャッシュにある開始時刻の枠だけ表示される', async () => {
    const { token } = await createMember('同期会員A');
    await enableSync();
    await seedCache(target, ['13:00']); // 10:00 と 17:00 は空きなし
    const res = await app.request(`/m/${token}?date=${target}`, {}, env);
    const html = await res.text();
    expect(html).toContain('13:00〜17:00');
    expect(html).not.toContain('10:00〜13:00');
    expect(html).not.toContain('17:00〜21:00');
    expect(html).toContain('リクエスト送信');
  });

  it('同期有効: キャッシュ行が無い日は「取得中」でフォームを出さない', async () => {
    const { token } = await createMember('同期会員B');
    await enableSync();
    // target のキャッシュは入れない（未取得）
    const res = await app.request(`/m/${token}?date=${target}`, {}, env);
    const html = await res.text();
    expect(html).toContain('空き情報を取得中です');
    expect(html).not.toContain('リクエスト送信');
  });

  it('同期有効: キャッシュにあるが空き枠ゼロの日は「空き枠がありません」', async () => {
    const { token } = await createMember('同期会員C');
    await enableSync();
    await seedCache(target, []); // 満枠
    const res = await app.request(`/m/${token}?date=${target}`, {}, env);
    const html = await res.text();
    expect(html).toContain('空き枠がありません');
    expect(html).not.toContain('リクエスト送信');
  });

  it('同期有効: 取得時刻の注記が表示される', async () => {
    const { token } = await createMember('同期会員D');
    await enableSync();
    await seedCache(target, ['10:00'], '2026-07-24T00:30:00.000Z'); // JST 9:30
    const res = await app.request(`/m/${token}`, {}, env);
    const html = await res.text();
    expect(html).toContain('時点の空き状況');
    expect(html).toContain('7月24日 9時30分');
  });

  it('同期有効: キャッシュに無い枠へのPOSTは unavailable', async () => {
    const { token } = await createMember('同期会員E');
    await enableSync();
    await seedCache(target, ['13:00']); // 10:00 は空いていない
    const res = await postRequest(token, { date: target, start: '10:00', note: '' });
    expect(res.headers.get('location')).toContain('error=unavailable');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM requests').first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it('同期有効: キャッシュにある枠へのPOSTは通常どおり申請できる', async () => {
    const { id, token } = await createMember('同期会員F');
    await enableSync();
    await seedCache(target, ['10:00', '13:00']);
    const res = await postRequest(token, { date: target, start: '10:00', note: '窓側希望' });
    expect(res.headers.get('location')).toContain('ok=requested');
    const row = await env.DB.prepare('SELECT status, end_time FROM requests WHERE member_id = ?')
      .bind(id).first<{ status: string; end_time: string }>();
    expect(row!.status).toBe('pending');
    expect(row!.end_time).toBe('13:00');
  });
});
