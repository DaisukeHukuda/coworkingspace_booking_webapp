import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

const INSERT = `INSERT INTO members (name, email, member_type, token, is_active, created_at)
  VALUES (?, ?, ?, ?, 1, ?)`;

describe('members schema', () => {
  it('会員を登録して読み出せる', async () => {
    await env.DB.prepare(INSERT)
      .bind('山田太郎', 'yamada@example.com', 'monthly', 'a'.repeat(40), '2026-07-23T00:00:00.000Z')
      .run();
    const row = await env.DB.prepare('SELECT * FROM members WHERE name = ?').bind('山田太郎').first();
    expect(row).not.toBeNull();
    expect(row!.email).toBe('yamada@example.com');
    expect(row!.member_type).toBe('monthly');
    expect(row!.is_active).toBe(1);
  });

  it('token の重複は拒否される', async () => {
    await env.DB.prepare(INSERT)
      .bind('A', 'a@example.com', 'ticket', 'b'.repeat(40), '2026-07-23T00:00:00.000Z')
      .run();
    await expect(
      env.DB.prepare(INSERT)
        .bind('B', 'b@example.com', 'ticket', 'b'.repeat(40), '2026-07-23T00:00:00.000Z')
        .run()
    ).rejects.toThrow();
  });

  it('member_type は monthly/ticket 以外を拒否する', async () => {
    await expect(
      env.DB.prepare(INSERT)
        .bind('C', 'c@example.com', 'weekly', 'c'.repeat(40), '2026-07-23T00:00:00.000Z')
        .run()
    ).rejects.toThrow();
  });
});
