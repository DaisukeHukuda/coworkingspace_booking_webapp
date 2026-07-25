import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

async function seedMember(): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO members (name, email, member_type, token, is_active, created_at) VALUES ('会員S5', 's5@example.com', 'monthly', ?, 1, '2026-07-25T00:00:00.000Z')`
  ).bind('s5'.padEnd(40, '0')).run();
  return res.meta.last_row_id as number;
}

const INSERT_REQ = `INSERT INTO requests (member_id, date, start_time, end_time, status, member_note, admin_note, created_at, updated_at)
  VALUES (?, '2026-09-01', '10:00', '12:00', 'declined', '', '', '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z')`;

describe('step5 schema', () => {
  it('requests.hidden_by_member は既定0で読み書きできる', async () => {
    const memberId = await seedMember();
    const r = await env.DB.prepare(INSERT_REQ).bind(memberId).run();
    const id = r.meta.last_row_id as number;
    const before = await env.DB.prepare('SELECT hidden_by_member FROM requests WHERE id = ?').bind(id).first<{ hidden_by_member: number }>();
    expect(before!.hidden_by_member).toBe(0);
    await env.DB.prepare('UPDATE requests SET hidden_by_member = 1 WHERE id = ?').bind(id).run();
    const after = await env.DB.prepare('SELECT hidden_by_member FROM requests WHERE id = ?').bind(id).first<{ hidden_by_member: number }>();
    expect(after!.hidden_by_member).toBe(1);
  });

  it('open_start/open_end が settings にシードされている', async () => {
    const rows = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('open_start', 'open_end')").all<{ key: string; value: string }>();
    const map = new Map(rows.results.map((r) => [r.key, r.value]));
    expect(map.get('open_start')).toBe('10:00');
    expect(map.get('open_end')).toBe('21:00');
  });
});
