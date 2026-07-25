import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { adminCookie } from './helpers';
import { getSettings } from '../src/core/settings';

describe('admin closed dates', () => {
  it('停止日を追加・上書き・削除できる', async () => {
    const cookie = await adminCookie();

    const add = await app.request('/admin/closed', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ date: '2026-09-20', reason: '臨時休業' }).toString()
    }, env);
    expect(add.headers.get('location')).toBe('/admin/closed?ok=saved');

    // 同じ日をもう一度保存すると理由が上書きされる
    await app.request('/admin/closed', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ date: '2026-09-20', reason: '設備点検' }).toString()
    }, env);
    const row = await env.DB.prepare(`SELECT reason FROM closed_dates WHERE date = '2026-09-20'`).first();
    expect(row!.reason).toBe('設備点検');

    const page = await app.request('/admin/closed', { headers: { cookie } }, env);
    expect(await page.text()).toContain('設備点検');

    const del = await app.request('/admin/closed/2026-09-20/delete', { method: 'POST', headers: { cookie } }, env);
    expect(del.headers.get('location')).toBe('/admin/closed?ok=deleted');
    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM closed_dates WHERE date = '2026-09-20'`).first<{ n: number }>();
    expect(after!.n).toBe(0);
  });

  it('不正な日付は invalid', async () => {
    const cookie = await adminCookie();
    const res = await app.request('/admin/closed', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ date: '2026/09/20', reason: '' }).toString()
    }, env);
    expect(res.headers.get('location')).toBe('/admin/closed?error=invalid');
  });
});

describe('admin settings', () => {
  it('設定画面に受付時間帯と現在値が表示される（時間枠テンプレートは廃止）', async () => {
    const cookie = await adminCookie();
    const res = await app.request('/admin/settings', { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('受付時間帯');
    expect(html).toContain('60');
    expect(html).not.toContain('時間枠テンプレート');
  });

  it('設定を保存できる（受付時間帯は30分単位）', async () => {
    const cookie = await adminCookie();
    const res = await app.request('/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({
        staff_email: 'staff@example.com',
        window_days: '30',
        open_start: '09:00',
        open_end: '18:30'
      }).toString()
    }, env);
    expect(res.headers.get('location')).toBe('/admin/settings?ok=saved');

    const s = await getSettings(env.DB);
    expect(s.staffEmail).toBe('staff@example.com');
    expect(s.windowDays).toBe(30);
    expect(s.openStart).toBe('09:00');
    expect(s.openEnd).toBe('18:30');
  });

  it('スタッフメールは空でも保存できる（通知スキップ運用）', async () => {
    const cookie = await adminCookie();
    const res = await app.request('/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ staff_email: '', window_days: '60', open_start: '10:00', open_end: '21:00' }).toString()
    }, env);
    expect(res.headers.get('location')).toBe('/admin/settings?ok=saved');
  });

  it('不正な受付時間帯・期間・メール形式は invalid で保存されない', async () => {
    const cookie = await adminCookie();
    const before = await getSettings(env.DB);

    const badStep = await app.request('/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ staff_email: '', window_days: '60', open_start: '10:15', open_end: '21:00' }).toString()
    }, env);
    expect(badStep.headers.get('location')).toBe('/admin/settings?error=invalid');

    const badOrder = await app.request('/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ staff_email: '', window_days: '60', open_start: '21:00', open_end: '10:00' }).toString()
    }, env);
    expect(badOrder.headers.get('location')).toBe('/admin/settings?error=invalid');

    const badDays = await app.request('/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ staff_email: '', window_days: '0', open_start: '10:00', open_end: '21:00' }).toString()
    }, env);
    expect(badDays.headers.get('location')).toBe('/admin/settings?error=invalid');

    const badEmail = await app.request('/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ staff_email: 'not-an-email', window_days: '60', open_start: '10:00', open_end: '21:00' }).toString()
    }, env);
    expect(badEmail.headers.get('location')).toBe('/admin/settings?error=invalid');

    const after = await getSettings(env.DB);
    expect(after).toEqual(before); // 何も変わっていない
  });
});
