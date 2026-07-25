import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createRequest, confirmRequest, declineRequest, cancelRequestByMember, hideRequestByMember } from '../src/core/requests';

async function seedMember(name: string): Promise<number> {
  const token = crypto.randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
  const res = await env.DB.prepare(
    `INSERT INTO members (name, email, member_type, token, is_active, created_at) VALUES (?, ?, 'monthly', ?, 1, '2026-07-23T00:00:00.000Z')`
  ).bind(name, `${name}@example.com`, token).run();
  return res.meta.last_row_id as number;
}

const INPUT = { date: '2026-08-01', startTime: '10:00', endTime: '13:00', memberNote: '2名で利用' };

describe('requests core', () => {
  it('リクエストを作成できる（初期状態は申請中）', async () => {
    const memberId = await seedMember('作成');
    const result = await createRequest(env.DB, { memberId, ...INPUT });
    expect(result.ok).toBe(true);
    const row = await env.DB.prepare('SELECT * FROM requests WHERE member_id = ?').bind(memberId).first();
    expect(row!.status).toBe('pending');
    expect(row!.member_note).toBe('2名で利用');
  });

  it('同一日・同一枠の二重リクエストは duplicate で拒否', async () => {
    const memberId = await seedMember('重複');
    await createRequest(env.DB, { memberId, ...INPUT });
    const second = await createRequest(env.DB, { memberId, ...INPUT });
    expect(second).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('キャンセル後なら同じ日時に再リクエストできる', async () => {
    const memberId = await seedMember('再申請');
    const first = await createRequest(env.DB, { memberId, ...INPUT });
    if (!first.ok) throw new Error('unreachable');
    expect(await cancelRequestByMember(env.DB, first.id, memberId)).toBe(true);
    const second = await createRequest(env.DB, { memberId, ...INPUT });
    expect(second.ok).toBe(true);
  });

  it('確定は申請中のみ成功し、二度目は失敗する', async () => {
    const memberId = await seedMember('確定');
    const r = await createRequest(env.DB, { memberId, ...INPUT });
    if (!r.ok) throw new Error('unreachable');
    expect(await confirmRequest(env.DB, r.id)).toBe(true);
    expect(await confirmRequest(env.DB, r.id)).toBe(false); // confirmed → confirmed は不可
    const row = await env.DB.prepare('SELECT status FROM requests WHERE id = ?').bind(r.id).first();
    expect(row!.status).toBe('confirmed');
  });

  it('否認は理由を保存し、申請中以外には効かない', async () => {
    const memberId = await seedMember('否認');
    const r = await createRequest(env.DB, { memberId, ...INPUT });
    if (!r.ok) throw new Error('unreachable');
    expect(await declineRequest(env.DB, r.id, '満席のため')).toBe(true);
    const row = await env.DB.prepare('SELECT status, admin_note FROM requests WHERE id = ?').bind(r.id).first();
    expect(row!.status).toBe('declined');
    expect(row!.admin_note).toBe('満席のため');
    expect(await declineRequest(env.DB, r.id, '再否認')).toBe(false);
  });

  it('確定済みでも会員はキャンセルできるが、他人の分はキャンセルできない', async () => {
    const memberId = await seedMember('本人');
    const otherId = await seedMember('他人');
    const r = await createRequest(env.DB, { memberId, ...INPUT });
    if (!r.ok) throw new Error('unreachable');
    await confirmRequest(env.DB, r.id);
    expect(await cancelRequestByMember(env.DB, r.id, otherId)).toBe(false); // 他人
    expect(await cancelRequestByMember(env.DB, r.id, memberId)).toBe(true);  // 本人・確定済み
    expect(await cancelRequestByMember(env.DB, r.id, memberId)).toBe(false); // 二度目
  });

  it('否認済みはキャンセルできない', async () => {
    const memberId = await seedMember('否認後');
    const r = await createRequest(env.DB, { memberId, ...INPUT });
    if (!r.ok) throw new Error('unreachable');
    await declineRequest(env.DB, r.id, '');
    expect(await cancelRequestByMember(env.DB, r.id, memberId)).toBe(false);
  });

  it('hideRequestByMember は終了状態（否認/キャンセル）の本人の行だけ隠す', async () => {
    const memberId = await seedMember('非表示');
    const otherId = await seedMember('別人');
    const r = await createRequest(env.DB, { memberId, ...INPUT });
    if (!r.ok) throw new Error('unreachable');
    expect(await hideRequestByMember(env.DB, r.id, memberId)).toBe(false); // 申請中は隠せない
    await declineRequest(env.DB, r.id, '満席');
    expect(await hideRequestByMember(env.DB, r.id, otherId)).toBe(false);   // 他人は隠せない
    expect(await hideRequestByMember(env.DB, r.id, memberId)).toBe(true);   // 本人・否認済みは隠せる
    expect(await hideRequestByMember(env.DB, r.id, memberId)).toBe(false);  // 二度目は0行
    const row = await env.DB.prepare('SELECT hidden_by_member FROM requests WHERE id = ?').bind(r.id).first<{ hidden_by_member: number }>();
    expect(row!.hidden_by_member).toBe(1);
  });
});
