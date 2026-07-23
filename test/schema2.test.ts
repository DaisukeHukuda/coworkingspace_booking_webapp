import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

async function seedMember(): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO members (name, email, member_type, token, is_active, created_at) VALUES ('会員A', 'a@example.com', 'monthly', ?, 1, '2026-07-23T00:00:00.000Z')`
  ).bind('a'.repeat(40)).run();
  return res.meta.last_row_id as number;
}

const INSERT_REQ = `INSERT INTO requests (member_id, date, start_time, end_time, status, member_note, admin_note, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, '', '', '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z')`;

describe('step2 schema', () => {
  it('requests を登録して読み出せる', async () => {
    const memberId = await seedMember();
    await env.DB.prepare(INSERT_REQ).bind(memberId, '2026-08-01', '10:00', '13:00', 'pending').run();
    const row = await env.DB.prepare('SELECT * FROM requests WHERE member_id = ?').bind(memberId).first();
    expect(row).not.toBeNull();
    expect(row!.status).toBe('pending');
    expect(row!.end_time).toBe('13:00');
  });

  it('requests の status は定義外の値を拒否する', async () => {
    const memberId = await seedMember();
    await expect(
      env.DB.prepare(INSERT_REQ).bind(memberId, '2026-08-01', '10:00', '13:00', 'waiting').run()
    ).rejects.toThrow();
  });

  it('同一会員・同一日・同一開始時刻のアクティブな行は重複登録できない', async () => {
    const memberId = await seedMember();
    await env.DB.prepare(INSERT_REQ).bind(memberId, '2026-08-02', '10:00', '13:00', 'pending').run();
    await expect(
      env.DB.prepare(INSERT_REQ).bind(memberId, '2026-08-02', '10:00', '13:00', 'confirmed').run()
    ).rejects.toThrow();
  });

  it('キャンセル済みなら同じ日時に再登録できる', async () => {
    const memberId = await seedMember();
    await env.DB.prepare(INSERT_REQ).bind(memberId, '2026-08-03', '10:00', '13:00', 'cancelled').run();
    await env.DB.prepare(INSERT_REQ).bind(memberId, '2026-08-03', '10:00', '13:00', 'pending').run();
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM requests WHERE member_id = ? AND date = ?')
      .bind(memberId, '2026-08-03').first<{ n: number }>();
    expect(rows!.n).toBe(2);
  });

  it('settings に初期値がシードされている', async () => {
    const rows = await env.DB.prepare('SELECT key, value FROM settings ORDER BY key').all<{ key: string; value: string }>();
    const map = new Map(rows.results.map((r) => [r.key, r.value]));
    expect(map.get('staff_email')).toBe('');
    expect(map.get('window_days')).toBe('60');
    expect(JSON.parse(map.get('slots')!)).toEqual([
      { start: '10:00', end: '13:00' },
      { start: '13:00', end: '17:00' },
      { start: '17:00', end: '21:00' }
    ]);
  });

  it('closed_dates・email_log・login_failures に読み書きできる', async () => {
    await env.DB.prepare(`INSERT INTO closed_dates (date, reason) VALUES ('2026-08-10', '臨時休業')`).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO closed_dates (date, reason) VALUES ('2026-08-10', '設備点検')`).run();
    const cd = await env.DB.prepare(`SELECT reason FROM closed_dates WHERE date = '2026-08-10'`).first<{ reason: string }>();
    expect(cd!.reason).toBe('設備点検');

    await env.DB.prepare(
      `INSERT INTO email_log (request_id, to_address, type, status, error, created_at) VALUES (1, 'x@example.com', 'requested', 'skipped', NULL, '2026-07-23T00:00:00.000Z')`
    ).run();
    const el = await env.DB.prepare('SELECT COUNT(*) AS n FROM email_log').first<{ n: number }>();
    expect(el!.n).toBe(1);

    await env.DB.prepare(`INSERT INTO login_failures (ip, created_at) VALUES ('1.2.3.4', '2026-07-23T00:00:00.000Z')`).run();
    const lf = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures').first<{ n: number }>();
    expect(lf!.n).toBe(1);
  });
});
