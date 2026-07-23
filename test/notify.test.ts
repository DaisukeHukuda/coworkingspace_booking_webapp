import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { sendRequestNotification } from '../src/core/notify';
import { setSetting } from '../src/core/settings';

async function seedRequest(): Promise<number> {
  const token = crypto.randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
  const m = await env.DB.prepare(
    `INSERT INTO members (name, email, member_type, token, is_active, created_at) VALUES ('通知会員', 'member@example.com', 'ticket', ?, 1, '2026-07-23T00:00:00.000Z')`
  ).bind(token).run();
  const r = await env.DB.prepare(
    `INSERT INTO requests (member_id, date, start_time, end_time, status, member_note, admin_note, created_at, updated_at)
     VALUES (?, '2026-08-01', '10:00', '13:00', 'pending', 'メモです', '', '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z')`
  ).bind(m.meta.last_row_id).run();
  return r.meta.last_row_id as number;
}

async function lastLog(): Promise<{ to_address: string; type: string; status: string } | null> {
  return env.DB.prepare('SELECT to_address, type, status FROM email_log ORDER BY id DESC LIMIT 1').first();
}

describe('notify', () => {
  it('APIキー未設定なら送信せず skipped を記録する', async () => {
    const id = await seedRequest();
    await setSetting(env.DB, 'staff_email', 'staff@example.com');
    await sendRequestNotification(env.DB, {}, id, 'requested', 'http://localhost:8787');
    const log = await lastLog();
    expect(log).toEqual({ to_address: 'staff@example.com', type: 'requested', status: 'skipped' });
  });

  it('スタッフ宛先が未設定でも skipped を記録して落ちない', async () => {
    const id = await seedRequest();
    await setSetting(env.DB, 'staff_email', '');
    await sendRequestNotification(env.DB, { RESEND_API_KEY: 'key' }, id, 'requested', 'http://localhost:8787');
    const log = await lastLog();
    expect(log!.status).toBe('skipped');
  });

  it('requested はスタッフ宛に送信し sent を記録する', async () => {
    const id = await seedRequest();
    await setSetting(env.DB, 'staff_email', 'staff@example.com');
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await sendRequestNotification(env.DB, { RESEND_API_KEY: 'key', NOTIFY_EMAIL_FROM: 'noreply@example.com' }, id, 'requested', 'http://localhost:8787', fetcher);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer key');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.to).toEqual(['staff@example.com']);
    expect(body.subject).toContain('利用リクエスト');
    expect(body.text).toContain('通知会員');
    expect(body.text).toContain('2026-08-01');
    expect(body.text).toContain('http://localhost:8787/admin/requests');
    expect((await lastLog())!.status).toBe('sent');
  });

  it('confirmed は会員本人宛に送信する', async () => {
    const id = await seedRequest();
    const calls: { init: RequestInit }[] = [];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ init: init! });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await sendRequestNotification(env.DB, { RESEND_API_KEY: 'key' }, id, 'confirmed', 'http://localhost:8787', fetcher);

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.to).toEqual(['member@example.com']);
    expect(body.subject).toContain('確定');
  });

  it('API失敗や例外でも呼び出し元には投げず error を記録する', async () => {
    const id = await seedRequest();
    await setSetting(env.DB, 'staff_email', 'staff@example.com');
    const failFetcher = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    await sendRequestNotification(env.DB, { RESEND_API_KEY: 'key' }, id, 'cancelled', 'http://localhost:8787', failFetcher);
    expect((await lastLog())!.status).toBe('error');

    const throwFetcher = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    await expect(
      sendRequestNotification(env.DB, { RESEND_API_KEY: 'key' }, id, 'cancelled', 'http://localhost:8787', throwFetcher)
    ).resolves.toBeUndefined();
    expect((await lastLog())!.status).toBe('error');
  });

  it('declined は会員本人宛に理由付きで送信する', async () => {
    const id = await seedRequest();
    await env.DB.prepare(`UPDATE requests SET status = 'declined', admin_note = '満席のため' WHERE id = ?`).bind(id).run();
    const calls: { init: RequestInit }[] = [];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ init: init! });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await sendRequestNotification(env.DB, { RESEND_API_KEY: 'key' }, id, 'declined', 'http://localhost:8787', fetcher);

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.to).toEqual(['member@example.com']);
    expect(body.subject).toContain('リクエストについて');
    expect(body.text).toContain('満席のため');
  });
});
