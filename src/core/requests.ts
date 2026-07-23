export type CreateRequestResult = { ok: true; id: number } | { ok: false; reason: 'duplicate' };

export async function createRequest(
  db: D1Database,
  input: { memberId: number; date: string; startTime: string; endTime: string; memberNote: string }
): Promise<CreateRequestResult> {
  const now = new Date().toISOString();
  try {
    const res = await db.prepare(
      `INSERT INTO requests (member_id, date, start_time, end_time, status, member_note, admin_note, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, '', ?, ?)`
    ).bind(input.memberId, input.date, input.startTime, input.endTime, input.memberNote, now, now).run();
    return { ok: true, id: res.meta.last_row_id as number };
  } catch (e) {
    // 部分UNIQUE（ux_requests_active）違反 = 同一日・同一枠のアクティブなリクエストが既にある。
    // それ以外の失敗（FK違反・一時障害など）を duplicate と誤報告しないよう、UNIQUE違反のみを分類する
    if (e instanceof Error && e.message.includes('UNIQUE constraint failed')) {
      return { ok: false, reason: 'duplicate' };
    }
    throw e;
  }
}

// 遷移はすべて「現在の状態をWHEREに含む条件付きUPDATE」。0行更新 = 遷移不可（false）

export async function confirmRequest(db: D1Database, id: number): Promise<boolean> {
  const res = await db.prepare(
    `UPDATE requests SET status = 'confirmed', updated_at = ? WHERE id = ? AND status = 'pending'`
  ).bind(new Date().toISOString(), id).run();
  return res.meta.changes === 1;
}

export async function declineRequest(db: D1Database, id: number, adminNote: string): Promise<boolean> {
  const res = await db.prepare(
    `UPDATE requests SET status = 'declined', admin_note = ?, updated_at = ? WHERE id = ? AND status = 'pending'`
  ).bind(adminNote, new Date().toISOString(), id).run();
  return res.meta.changes === 1;
}

export async function cancelRequestByMember(db: D1Database, id: number, memberId: number): Promise<boolean> {
  const res = await db.prepare(
    `UPDATE requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND member_id = ? AND status IN ('pending', 'confirmed')`
  ).bind(new Date().toISOString(), id, memberId).run();
  return res.meta.changes === 1;
}
