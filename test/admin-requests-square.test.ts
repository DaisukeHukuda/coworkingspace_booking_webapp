import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { adminCookie } from './helpers';
import { setSetting } from '../src/core/settings';
import { currentJstDate, addDays } from '../src/core/dates';

async function seedPending(name: string, date: string, start = '10:00'): Promise<number> {
  const token = crypto.randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
  const m = await env.DB.prepare(
    `INSERT INTO members (name, email, member_type, token, is_active, created_at) VALUES (?, ?, 'monthly', ?, 1, '2026-07-23T00:00:00.000Z')`
  ).bind(name, `${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`, token).run();
  const r = await env.DB.prepare(
    `INSERT INTO requests (member_id, date, start_time, end_time, status, member_note, admin_note, created_at, updated_at)
     VALUES (?, ?, ?, '13:00', 'pending', '', '', '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z')`
  ).bind(m.meta.last_row_id, date, start).run();
  return r.meta.last_row_id as number;
}

async function enableSync(): Promise<void> {
  await setSetting(env.DB, 'square_location_id', 'LOC');
  await setSetting(env.DB, 'square_service_variation_id', 'SV');
}

async function seedCache(date: string, starts: string[]): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO availability_cache (date, slots_json, fetched_at) VALUES (?, ?, ?)')
    .bind(date, JSON.stringify(starts), '2026-07-24T00:00:00.000Z').run();
}

const WARN = 'Square側で埋まった可能性';
const day = addDays(currentJstDate(), 5);

describe('admin requests Square warning', () => {
  it('同期有効: 承認待ちの枠がキャッシュから消えていれば警告バッジを表示', async () => {
    const cookie = await adminCookie();
    await seedPending('埋まり会員', day, '10:00');
    await enableSync();
    await seedCache(day, ['13:00']); // 10:00 は消えている
    const res = await app.request('/admin/requests', { headers: { cookie } }, env);
    expect(await res.text()).toContain(WARN);
  });

  it('同期有効: 承認待ちの枠がキャッシュにあれば警告は出ない', async () => {
    const cookie = await adminCookie();
    await seedPending('空きあり会員', day, '10:00');
    await enableSync();
    await seedCache(day, ['10:00', '13:00']);
    const res = await app.request('/admin/requests', { headers: { cookie } }, env);
    expect(await res.text()).not.toContain(WARN);
  });

  it('同期無効: キャッシュの状態に関わらず警告は一切出ない', async () => {
    const cookie = await adminCookie();
    await seedPending('無効会員', day, '10:00');
    // enableSync しない（同期無効）
    await seedCache(day, ['13:00']); // 枠は消えているが同期無効なので無視される
    const res = await app.request('/admin/requests', { headers: { cookie } }, env);
    expect(await res.text()).not.toContain(WARN);
  });
});
