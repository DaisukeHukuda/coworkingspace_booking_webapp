import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { adminCookie } from './helpers';
import { currentJstDate, addDays, monthOf, addMonths } from '../src/core/dates';

async function createMember(name: string): Promise<{ id: number; token: string }> {
  const cookie = await adminCookie();
  await app.request('/admin/members', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ name, email: `${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`, member_type: 'monthly' }).toString()
  }, env);
  const row = await env.DB.prepare('SELECT id, token FROM members WHERE name = ?').bind(name).first<{ id: number; token: string }>();
  if (!row) throw new Error('member not created');
  return row;
}

async function postRequest(token: string, body: Record<string, string>): Promise<Response> {
  return app.request(`/m/${token}/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  }, env);
}

const target = addDays(currentJstDate(), 7);

describe('member requests', () => {
  it('カレンダーに月と開始・終了の時間プルダウンが表示される', async () => {
    const { token } = await createMember('カレンダー会員');
    const res = await app.request(`/m/${token}?date=${target}`, {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    const [ty, tm] = monthOf(target).split('-');
    expect(html).toContain(`${ty}年${Number(tm)}月`); // 例: 2026年7月（先頭ゼロなし）
    expect(html).toContain('開始時刻');
    expect(html).toContain('終了時刻');
    expect(html).toContain('<option value="10:00">10:00</option>'); // 既定の受付時間帯 10:00〜21:00 の開始側先頭
    expect(html).toContain('<option value="21:00">21:00</option>'); // 終了側の最終選択肢
    expect(html).toContain('リクエスト送信');

    // 不正な月パラメータは無視して当月にフォールバックする
    const badMonth = await app.request(`/m/${token}?month=2026-99`, {}, env);
    expect(badMonth.status).toBe(200);
  });

  it('リクエスト送信で申請中になり、スタッフ通知と会員宛の受付確認が記録される', async () => {
    const { id, token } = await createMember('送信会員');
    const res = await postRequest(token, { date: target, start: '10:30', end: '15:00', note: '午前から利用します' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('ok=requested');

    const row = await env.DB.prepare('SELECT * FROM requests WHERE member_id = ?').bind(id).first();
    expect(row!.status).toBe('pending');
    expect(row!.start_time).toBe('10:30');
    expect(row!.end_time).toBe('15:00'); // 会員が選んだ終了時刻がそのまま入る（テンプレート補完は廃止）
    expect(row!.member_note).toBe('午前から利用します');

    const logs = await env.DB.prepare('SELECT type, status FROM email_log WHERE request_id = ? ORDER BY id')
      .bind(row!.id).all<{ type: string; status: string }>();
    expect(logs.results.map((l) => l.type)).toEqual(['requested', 'requested_member']); // スタッフ宛→会員宛の順
    expect(logs.results.every((l) => l.status === 'skipped')).toBe(true); // テストではRESEND_API_KEY未設定

    const page = await app.request(`/m/${token}`, {}, env);
    const html = await page.text();
    expect(html).toContain('申請中');
    expect(html).toContain('キャンセル');
  });

  it('同じ日・同じ開始時刻の二重リクエストは弾かれる', async () => {
    const { token } = await createMember('重複会員');
    await postRequest(token, { date: target, start: '10:00', end: '13:00', note: '' });
    const res = await postRequest(token, { date: target, start: '10:00', end: '13:00', note: '' });
    expect(res.headers.get('location')).toContain('error=duplicate');
  });

  it('過去日・期間外・30分単位でない/時間帯外/逆転の時間・長すぎるメモは invalid', async () => {
    const { token } = await createMember('不正会員');
    const base = { start: '10:00', end: '13:00', note: '' };
    expect((await postRequest(token, { date: addDays(currentJstDate(), -1), ...base })).headers.get('location')).toContain('error=invalid');
    expect((await postRequest(token, { date: addDays(currentJstDate(), 120), ...base })).headers.get('location')).toContain('error=invalid');
    expect((await postRequest(token, { date: target, start: '10:15', end: '13:00', note: '' })).headers.get('location')).toContain('error=invalid'); // 30分単位でない
    expect((await postRequest(token, { date: target, start: '09:30', end: '13:00', note: '' })).headers.get('location')).toContain('error=invalid'); // 受付開始前
    expect((await postRequest(token, { date: target, start: '10:00', end: '21:30', note: '' })).headers.get('location')).toContain('error=invalid'); // 受付終了後
    expect((await postRequest(token, { date: target, start: '13:00', end: '13:00', note: '' })).headers.get('location')).toContain('error=invalid'); // 開始=終了
    expect((await postRequest(token, { date: target, start: '10:00', end: '13:00', note: 'あ'.repeat(501) })).headers.get('location')).toContain('error=invalid');
    expect((await postRequest(token, { date: `${monthOf(target)}-32`, ...base })).headers.get('location')).toContain('error=invalid'); // 窓内相当だが暦に存在しない日付
  });

  it('受付停止日にはリクエストできず、カレンダーにも停止と表示される', async () => {
    const { token } = await createMember('停止日会員');
    const closed = addDays(currentJstDate(), 10);
    await env.DB.prepare(`INSERT INTO closed_dates (date, reason) VALUES (?, '臨時休業')`).bind(closed).run();

    const res = await postRequest(token, { date: closed, start: '10:00', end: '13:00', note: '' });
    expect(res.headers.get('location')).toContain('error=closed');

    const page = await app.request(`/m/${token}?month=${monthOf(closed)}`, {}, env);
    expect(await page.text()).toContain('停');

    // 表示月が別でも選択日の停止判定は独立している（?month と ?date の組み合わせ対策）
    const cross = await app.request(`/m/${token}?month=${addMonths(monthOf(closed), 1)}&date=${closed}`, {}, env);
    const crossHtml = await cross.text();
    expect(crossHtml).toContain('受付を停止しています');
    expect(crossHtml).not.toContain('リクエスト送信');
  });

  it('本人はキャンセルでき、スタッフ通知が記録される', async () => {
    const { id, token } = await createMember('取消会員');
    await postRequest(token, { date: target, start: '13:00', end: '17:00', note: '' });
    const row = await env.DB.prepare('SELECT id FROM requests WHERE member_id = ?').bind(id).first<{ id: number }>();

    const res = await app.request(`/m/${token}/requests/${row!.id}/cancel`, { method: 'POST' }, env);
    expect(res.headers.get('location')).toContain('ok=cancelled');

    const after = await env.DB.prepare('SELECT status FROM requests WHERE id = ?').bind(row!.id).first();
    expect(after!.status).toBe('cancelled');
    const log = await env.DB.prepare('SELECT type FROM email_log WHERE request_id = ? ORDER BY id DESC LIMIT 1').bind(row!.id).first();
    expect(log!.type).toBe('cancelled');
  });

  it('他人のリクエストはキャンセルできない', async () => {
    const a = await createMember('会員AA');
    const b = await createMember('会員BB');
    await postRequest(a.token, { date: target, start: '17:00', end: '19:00', note: '' });
    const row = await env.DB.prepare('SELECT id FROM requests WHERE member_id = ?').bind(a.id).first<{ id: number }>();

    const res = await app.request(`/m/${b.token}/requests/${row!.id}/cancel`, { method: 'POST' }, env);
    expect(res.headers.get('location')).toContain('error=invalid');
    const after = await env.DB.prepare('SELECT status FROM requests WHERE id = ?').bind(row!.id).first();
    expect(after!.status).toBe('pending');
  });

  it('無効トークンでのPOSTは404', async () => {
    const res = await postRequest('f'.repeat(40), { date: target, start: '10:00', end: '13:00', note: '' });
    expect(res.status).toBe(404);
  });

  it('カレンダーに自分の予約マークが表示され、同日は確定が優先される', async () => {
    const { id, token } = await createMember('マーク会員');
    const now = '2026-07-25T00:00:00.000Z';
    await env.DB.prepare(
      `INSERT INTO requests (member_id, date, start_time, end_time, status, member_note, admin_note, created_at, updated_at)
       VALUES (?, ?, '10:00', '11:00', 'pending', '', '', ?, ?), (?, ?, '13:00', '14:00', 'confirmed', '', '', ?, ?)`
    ).bind(id, target, now, now, id, target, now, now).run();

    const res = await app.request(`/m/${token}?month=${monthOf(target)}`, {}, env);
    const html = await res.text();
    const count = (needle: string) => html.split(needle).length - 1;
    expect(count('dot-confirmed')).toBe(2); // 凡例1 + 同日セルは確定優先で1
    expect(count('dot-pending')).toBe(1);   // 凡例のみ（同日セルには出ない）
    expect(count('dot-declined')).toBe(1);  // 凡例のみ
  });

  it('否認済みの行は非表示にでき、一覧・マークから消えるが管理画面には残る', async () => {
    const { id, token } = await createMember('整理会員');
    await postRequest(token, { date: target, start: '10:00', end: '13:00', note: '' });
    const row = await env.DB.prepare('SELECT id FROM requests WHERE member_id = ?').bind(id).first<{ id: number }>();
    await env.DB.prepare(`UPDATE requests SET status = 'declined', admin_note = '満席' WHERE id = ?`).bind(row!.id).run();

    const before = await app.request(`/m/${token}?month=${monthOf(target)}`, {}, env);
    const beforeHtml = await before.text();
    expect(beforeHtml).toContain(`/m/${token}/requests/${row!.id}/hide`); // 非表示ボタンが出る
    expect(beforeHtml.split('dot-declined').length - 1).toBe(2); // 凡例1 + セル1

    const res = await app.request(`/m/${token}/requests/${row!.id}/hide`, { method: 'POST' }, env);
    expect(res.headers.get('location')).toContain('ok=hidden');

    const after = await app.request(`/m/${token}?month=${monthOf(target)}`, {}, env);
    const afterHtml = await after.text();
    expect(afterHtml).toContain('まだリクエストはありません'); // 一覧から消えた
    expect(afterHtml.split('dot-declined').length - 1).toBe(1); // マークも消えた（凡例のみ）

    const db = await env.DB.prepare('SELECT hidden_by_member FROM requests WHERE id = ?').bind(row!.id).first<{ hidden_by_member: number }>();
    expect(db!.hidden_by_member).toBe(1);

    // 管理画面の一覧には残る（記録保全）
    const cookie = await adminCookie();
    const adminList = await app.request('/admin/requests/all', { headers: { cookie } }, env);
    expect(await adminList.text()).toContain('整理会員');
  });

  it('申請中の行は非表示にできず、他人のリクエストも非表示にできない', async () => {
    const a = await createMember('非表示不可会員');
    const b = await createMember('第三者会員');
    await postRequest(a.token, { date: target, start: '17:00', end: '19:00', note: '' });
    const row = await env.DB.prepare('SELECT id FROM requests WHERE member_id = ?').bind(a.id).first<{ id: number }>();

    // 申請中は非表示にできない
    const pending = await app.request(`/m/${a.token}/requests/${row!.id}/hide`, { method: 'POST' }, env);
    expect(pending.headers.get('location')).toContain('error=invalid');

    // 否認後でも他人は非表示にできない
    await env.DB.prepare(`UPDATE requests SET status = 'declined' WHERE id = ?`).bind(row!.id).run();
    const other = await app.request(`/m/${b.token}/requests/${row!.id}/hide`, { method: 'POST' }, env);
    expect(other.headers.get('location')).toContain('error=invalid');

    const db = await env.DB.prepare('SELECT hidden_by_member FROM requests WHERE id = ?').bind(row!.id).first<{ hidden_by_member: number }>();
    expect(db!.hidden_by_member).toBe(0);
  });
});
