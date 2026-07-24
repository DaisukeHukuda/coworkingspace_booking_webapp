import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { syncAvailability, getCachedStarts, getCacheStatus } from '../src/core/square';
import { setSetting } from '../src/core/settings';
import { currentJstDate, addDays } from '../src/core/dates';

// Square設定を有効化する（両IDを入れる）。windowDays を任意に上書きできる。
async function enableSquare(windowDays?: number): Promise<void> {
  await setSetting(env.DB, 'square_location_id', 'LOC');
  await setSetting(env.DB, 'square_service_variation_id', 'SV');
  if (windowDays !== undefined) await setSetting(env.DB, 'window_days', String(windowDays));
}

// availabilities を返すモック fetcher を作る。呼び出し記録も返す。
function mockFetcher(availabilities: { start_at: string }[]) {
  const calls: { url: string; body: unknown }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init!.body)) });
    return new Response(JSON.stringify({ availabilities }), { status: 200 });
  }) as typeof fetch;
  return { fetcher, calls };
}

const SQUARE_ENV = { SQUARE_ACCESS_TOKEN: 'tok' };

describe('syncAvailability', () => {
  it('同期無効（Square未設定）なら fetcher を呼ばず sync_disabled を返す', async () => {
    let called = false;
    const fetcher = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
    const result = await syncAvailability(env.DB, SQUARE_ENV, fetcher);
    expect(result).toEqual({ ok: false, days: 0, error: 'sync_disabled' });
    expect(called).toBe(false);
  });

  it('アクセストークン未設定なら sync_disabled を返す', async () => {
    await enableSquare();
    const result = await syncAvailability(env.DB, {}, (async () => new Response('{}')) as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('sync_disabled');
  });

  it('応答の start_at を JST の開始時刻に変換して日別にupsertする', async () => {
    await enableSquare(5); // 今日〜今日+5 = 6日
    const day = addDays(currentJstDate(), 2);
    const { fetcher } = mockFetcher([
      { start_at: `${day}T01:00:00Z` }, // UTC 01:00 → JST 10:00
      { start_at: `${day}T04:00:00Z` }, // UTC 04:00 → JST 13:00
      { start_at: `${day}T01:00:00Z` }  // 重複は1つに
    ]);
    const result = await syncAvailability(env.DB, SQUARE_ENV, fetcher);
    expect(result.ok).toBe(true);
    expect(result.days).toBe(6); // 範囲内の全日を upsert
    const starts = await getCachedStarts(env.DB, day, day);
    expect(starts.get(day)).toEqual(['10:00', '13:00']);
  });

  it('範囲内に枠が無い日も空配列で upsert される（満枠日と未取得日を区別）', async () => {
    await enableSquare(3);
    const today = currentJstDate();
    const { fetcher } = mockFetcher([]); // 1件も枠が無い
    const result = await syncAvailability(env.DB, SQUARE_ENV, fetcher);
    expect(result.ok).toBe(true);
    const starts = await getCachedStarts(env.DB, today, addDays(today, 3));
    expect(starts.has(today)).toBe(true); // 行はある
    expect(starts.get(today)).toEqual([]); // 中身は空（満枠）
    expect(starts.size).toBe(4);           // 今日〜今日+3 の4日ぶん
  });

  it('31日を超える範囲はチャンク分割して複数回リクエストする', async () => {
    await enableSquare(40); // 41日 → 31 + 10 の2チャンク
    const { fetcher, calls } = mockFetcher([]);
    const result = await syncAvailability(env.DB, SQUARE_ENV, fetcher);
    expect(result.ok).toBe(true);
    expect(result.days).toBe(41);
    expect(calls.length).toBe(2);
  });

  it('想定外の応答（availabilities欠落・start_at不正）でも例外を投げず継続する', async () => {
    await enableSquare(2);
    const today = currentJstDate();
    const fetcher = (async () =>
      new Response(JSON.stringify({ nonsense: true, availabilities: [{ foo: 1 }, { start_at: 999 }] }), { status: 200 })
    ) as typeof fetch;
    const result = await syncAvailability(env.DB, SQUARE_ENV, fetcher);
    expect(result.ok).toBe(true);
    const starts = await getCachedStarts(env.DB, today, addDays(today, 2));
    expect(starts.get(today)).toEqual([]); // 不正な枠は無視され空配列
  });

  it('APIが失敗（500）や例外でも投げず ok:false を返す', async () => {
    await enableSquare(2);
    const fail = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const r1 = await syncAvailability(env.DB, SQUARE_ENV, fail);
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('500');

    const boom = (async () => { throw new Error('network down'); }) as typeof fetch;
    const r2 = await syncAvailability(env.DB, SQUARE_ENV, boom);
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('network down');
  });

  it('getCacheStatus は日数と最終取得時刻を返す', async () => {
    await enableSquare(1);
    const { fetcher } = mockFetcher([]);
    await syncAvailability(env.DB, SQUARE_ENV, fetcher);
    const status = await getCacheStatus(env.DB);
    expect(status.days).toBe(2); // 今日と翌日
    expect(status.lastFetched).not.toBeNull();
  });
});
