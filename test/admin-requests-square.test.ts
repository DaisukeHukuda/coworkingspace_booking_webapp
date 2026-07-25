import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { adminCookie } from './helpers';
import { setSetting } from '../src/core/settings';
import { currentJstDate, addDays } from '../src/core/dates';

async function seedPending(name: string, date: string, start = '10:00', end = '13:00'): Promise<number> {
  const token = crypto.randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
  const m = await env.DB.prepare(
    `INSERT INTO members (name, email, member_type, token, is_active, created_at) VALUES (?, ?, 'monthly', ?, 1, '2026-07-23T00:00:00.000Z')`
  ).bind(name, `${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`, token).run();
  const r = await env.DB.prepare(
    `INSERT INTO requests (member_id, date, start_time, end_time, status, member_note, admin_note, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', '', '', '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z')`
  ).bind(m.meta.last_row_id, date, start, end).run();
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
  it('同期有効: リクエストの時間帯に重なる空きが無ければ警告バッジを表示', async () => {
    const cookie = await adminCookie();
    await seedPending('埋まり会員', day, '10:00', '13:00');
    await enableSync();
    // 13:00 は終了時刻ちょうど（start<=t<end を満たさない）、09:30 は開始前 → どちらも重ならない
    await seedCache(day, ['09:30', '13:00']);
    const res = await app.request('/admin/requests', { headers: { cookie } }, env);
    expect(await res.text()).toContain(WARN);
  });

  it('同期有効: 時間帯に重なる空きがあれば警告は出ない', async () => {
    const cookie = await adminCookie();
    await seedPending('空きあり会員', day, '10:00', '13:00');
    await enableSync();
    await seedCache(day, ['10:00']); // 開始時刻ちょうどは重なり扱い
    const res = await app.request('/admin/requests', { headers: { cookie } }, env);
    expect(await res.text()).not.toContain(WARN);
  });

  it('同期無効: キャッシュの状態に関わらず警告は一切出ない', async () => {
    const cookie = await adminCookie();
    await seedPending('無効会員', day, '10:00', '13:00');
    // enableSync しない（同期無効）
    await seedCache(day, ['13:00']); // 重なりゼロ相当だが同期無効なので無視される
    const res = await app.request('/admin/requests', { headers: { cookie } }, env);
    expect(await res.text()).not.toContain(WARN);
  });

  it('30分単位の自由な時間帯でもレンジ重なりで判定される', async () => {
    const cookie = await adminCookie();
    await seedPending('境界会員', day, '10:30', '15:00');
    await enableSync();

    // 09:00 は開始前・15:00 は終了ちょうど → 重ならないので警告
    await seedCache(day, ['09:00', '15:00']);
    const warned = await app.request('/admin/requests', { headers: { cookie } }, env);
    expect(await warned.text()).toContain(WARN);

    // 14:30 は 10:30<=14:30<15:00 で重なる → 警告なし
    await seedCache(day, ['14:30']);
    const clear = await app.request('/admin/requests', { headers: { cookie } }, env);
    expect(await clear.text()).not.toContain(WARN);
  });
});
