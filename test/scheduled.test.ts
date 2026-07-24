import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { runScheduled } from '../src/core/scheduled';
import { setSetting } from '../src/core/settings';
import { getCacheStatus } from '../src/core/square';
import { currentJstDate } from '../src/core/dates';

async function enableSquare(): Promise<void> {
  await setSetting(env.DB, 'square_location_id', 'LOC');
  await setSetting(env.DB, 'square_service_variation_id', 'SV');
  await setSetting(env.DB, 'window_days', '2');
}

const OK_FETCHER = (async () => new Response(JSON.stringify({ availabilities: [] }), { status: 200 })) as typeof fetch;
const NOW = Date.parse('2026-07-24T00:00:00.000Z');

describe('runScheduled', () => {
  it('同期有効なら Square を取得してキャッシュを更新する', async () => {
    await enableSquare();
    await runScheduled(env.DB, { SQUARE_ACCESS_TOKEN: 'tok' }, OK_FETCHER, NOW);
    const status = await getCacheStatus(env.DB);
    expect(status.days).toBe(3); // 今日〜今日+2
    expect(status.lastFetched).not.toBeNull();
  });

  it('同期無効なら fetcher を呼ばない', async () => {
    let called = false;
    const spy = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
    await runScheduled(env.DB, { SQUARE_ACCESS_TOKEN: 'tok' }, spy, NOW);
    expect(called).toBe(false);
    const status = await getCacheStatus(env.DB);
    expect(status.days).toBe(0);
  });

  it('1日より古い login_failures を削除し、新しい行は残す', async () => {
    const old = new Date(NOW - 25 * 3600_000).toISOString();
    const fresh = new Date(NOW - 1 * 3600_000).toISOString();
    await env.DB.prepare('INSERT INTO login_failures (ip, created_at) VALUES (?, ?)').bind('1.1.1.1', old).run();
    await env.DB.prepare('INSERT INTO login_failures (ip, created_at) VALUES (?, ?)').bind('2.2.2.2', fresh).run();

    await runScheduled(env.DB, {}, OK_FETCHER, NOW);

    const rows = await env.DB.prepare('SELECT ip FROM login_failures').all<{ ip: string }>();
    expect(rows.results.map((r) => r.ip)).toEqual(['2.2.2.2']);
  });

  it('同期有効かつ最終取得が24h超なら sync_stale をスタッフへ記録する', async () => {
    await enableSquare();
    await setSetting(env.DB, 'staff_email', 'staff@example.com');
    // 古い取得時刻のキャッシュを seed し、同期は失敗させて更新されないようにする
    const oldStamp = new Date(NOW - 30 * 3600_000).toISOString();
    await env.DB.prepare('INSERT INTO availability_cache (date, slots_json, fetched_at) VALUES (?, ?, ?)')
      .bind(currentJstDate(), '[]', oldStamp).run();
    const failFetcher = (async () => new Response('boom', { status: 500 })) as typeof fetch;

    await runScheduled(env.DB, { SQUARE_ACCESS_TOKEN: 'tok' }, failFetcher, NOW);

    const log = await env.DB.prepare(
      "SELECT type, status, request_id FROM email_log WHERE type = 'sync_stale' ORDER BY id DESC LIMIT 1"
    ).first<{ type: string; status: string; request_id: number }>();
    expect(log).not.toBeNull();
    expect(log!.request_id).toBe(0);
    expect(log!.status).toBe('skipped'); // RESEND_API_KEY 未設定 → 送信スキップ・記録のみ
  });

  it('最終取得が24h以内なら sync_stale を記録しない', async () => {
    await enableSquare();
    await setSetting(env.DB, 'staff_email', 'staff@example.com');
    const recent = new Date(NOW - 1 * 3600_000).toISOString();
    await env.DB.prepare('INSERT INTO availability_cache (date, slots_json, fetched_at) VALUES (?, ?, ?)')
      .bind(currentJstDate(), '[]', recent).run();
    const failFetcher = (async () => new Response('boom', { status: 500 })) as typeof fetch;

    await runScheduled(env.DB, { SQUARE_ACCESS_TOKEN: 'tok' }, failFetcher, NOW);

    const log = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_log WHERE type = 'sync_stale'").first<{ n: number }>();
    expect(log!.n).toBe(0);
  });
});
