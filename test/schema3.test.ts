import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

const UPSERT = `INSERT INTO availability_cache (date, slots_json, fetched_at)
  VALUES (?, ?, ?)
  ON CONFLICT(date) DO UPDATE SET slots_json = excluded.slots_json, fetched_at = excluded.fetched_at`;

describe('step3 schema', () => {
  it('availability_cache に読み書きできる', async () => {
    await env.DB.prepare(UPSERT).bind('2026-08-01', '["10:00","13:00"]', '2026-07-24T00:00:00.000Z').run();
    const row = await env.DB.prepare('SELECT * FROM availability_cache WHERE date = ?')
      .bind('2026-08-01').first<{ date: string; slots_json: string; fetched_at: string }>();
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.slots_json)).toEqual(['10:00', '13:00']);
    expect(row!.fetched_at).toBe('2026-07-24T00:00:00.000Z');
  });

  it('date は主キーで upsert により上書きされる', async () => {
    await env.DB.prepare(UPSERT).bind('2026-08-02', '["10:00"]', '2026-07-24T00:00:00.000Z').run();
    await env.DB.prepare(UPSERT).bind('2026-08-02', '["13:00","17:00"]', '2026-07-24T01:00:00.000Z').run();
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM availability_cache WHERE date = ?')
      .bind('2026-08-02').first<{ n: number }>();
    expect(count!.n).toBe(1);
    const row = await env.DB.prepare('SELECT slots_json, fetched_at FROM availability_cache WHERE date = ?')
      .bind('2026-08-02').first<{ slots_json: string; fetched_at: string }>();
    expect(JSON.parse(row!.slots_json)).toEqual(['13:00', '17:00']);
    expect(row!.fetched_at).toBe('2026-07-24T01:00:00.000Z');
  });

  it('空配列（満枠日）も保存でき、未取得日（行なし）と区別できる', async () => {
    await env.DB.prepare(UPSERT).bind('2026-08-03', '[]', '2026-07-24T00:00:00.000Z').run();
    const present = await env.DB.prepare('SELECT slots_json FROM availability_cache WHERE date = ?')
      .bind('2026-08-03').first<{ slots_json: string }>();
    expect(present).not.toBeNull();
    expect(JSON.parse(present!.slots_json)).toEqual([]);
    const absent = await env.DB.prepare('SELECT slots_json FROM availability_cache WHERE date = ?')
      .bind('2026-08-04').first();
    expect(absent).toBeNull(); // 未取得日は行が無い
  });
});
