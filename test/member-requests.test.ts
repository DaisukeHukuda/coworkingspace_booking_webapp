import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../src/index';
import { adminCookie } from './helpers';
import { currentJstDate, addDays, monthOf } from '../src/core/dates';

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
  it('カレンダーに月と時間枠フォームが表示される', async () => {
    const { token } = await createMember('カレンダー会員');
    const res = await app.request(`/m/${token}?date=${target}`, {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    const [ty, tm] = monthOf(target).split('-');
    expect(html).toContain(`${ty}年${Number(tm)}月`); // 例: 2026年7月（先頭ゼロなし）
    expect(html).toContain('10:00〜13:00');
    expect(html).toContain('リクエスト送信');
  });

  it('リクエスト送信で申請中になり、スタッフ通知が記録される', async () => {
    const { id, token } = await createMember('送信会員');
    const res = await postRequest(token, { date: target, start: '10:00', note: '午前利用します' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('ok=requested');

    const row = await env.DB.prepare('SELECT * FROM requests WHERE member_id = ?').bind(id).first();
    expect(row!.status).toBe('pending');
    expect(row!.end_time).toBe('13:00'); // テンプレートから補完
    expect(row!.member_note).toBe('午前利用します');

    const log = await env.DB.prepare('SELECT type, status FROM email_log WHERE request_id = ?').bind(row!.id).first();
    expect(log!.type).toBe('requested');
    expect(log!.status).toBe('skipped'); // テストではRESEND_API_KEY未設定

    const page = await app.request(`/m/${token}`, {}, env);
    const html = await page.text();
    expect(html).toContain('申請中');
    expect(html).toContain('キャンセル');
  });

  it('同じ日・同じ枠の二重リクエストは弾かれる', async () => {
    const { token } = await createMember('重複会員');
    await postRequest(token, { date: target, start: '10:00', note: '' });
    const res = await postRequest(token, { date: target, start: '10:00', note: '' });
    expect(res.headers.get('location')).toContain('error=duplicate');
  });

  it('過去日・期間外・不正な枠・長すぎるメモは invalid', async () => {
    const { token } = await createMember('不正会員');
    expect((await postRequest(token, { date: addDays(currentJstDate(), -1), start: '10:00', note: '' })).headers.get('location')).toContain('error=invalid');
    expect((await postRequest(token, { date: addDays(currentJstDate(), 120), start: '10:00', note: '' })).headers.get('location')).toContain('error=invalid');
    expect((await postRequest(token, { date: target, start: '09:59', note: '' })).headers.get('location')).toContain('error=invalid');
    expect((await postRequest(token, { date: target, start: '10:00', note: 'あ'.repeat(501) })).headers.get('location')).toContain('error=invalid');
  });

  it('受付停止日にはリクエストできず、カレンダーにも停止と表示される', async () => {
    const { token } = await createMember('停止日会員');
    const closed = addDays(currentJstDate(), 10);
    await env.DB.prepare(`INSERT INTO closed_dates (date, reason) VALUES (?, '臨時休業')`).bind(closed).run();

    const res = await postRequest(token, { date: closed, start: '10:00', note: '' });
    expect(res.headers.get('location')).toContain('error=closed');

    const page = await app.request(`/m/${token}?month=${monthOf(closed)}`, {}, env);
    expect(await page.text()).toContain('停');
  });

  it('本人はキャンセルでき、スタッフ通知が記録される', async () => {
    const { id, token } = await createMember('取消会員');
    await postRequest(token, { date: target, start: '13:00', note: '' });
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
    await postRequest(a.token, { date: target, start: '17:00', note: '' });
    const row = await env.DB.prepare('SELECT id FROM requests WHERE member_id = ?').bind(a.id).first<{ id: number }>();

    const res = await app.request(`/m/${b.token}/requests/${row!.id}/cancel`, { method: 'POST' }, env);
    expect(res.headers.get('location')).toContain('error=invalid');
    const after = await env.DB.prepare('SELECT status FROM requests WHERE id = ?').bind(row!.id).first();
    expect(after!.status).toBe('pending');
  });

  it('無効トークンでのPOSTは404', async () => {
    const res = await postRequest('f'.repeat(40), { date: target, start: '10:00', note: '' });
    expect(res.status).toBe(404);
  });
});
