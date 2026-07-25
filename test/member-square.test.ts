import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { adminCookie } from './helpers';
import { setSetting } from '../src/core/settings';
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

async function enableSync(): Promise<void> {
  await setSetting(env.DB, 'square_location_id', 'LOC');
  await setSetting(env.DB, 'square_service_variation_id', 'SV');
}

async function seedCache(date: string, starts: string[], fetchedAt = '2026-07-24T00:30:00.000Z'): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO availability_cache (date, slots_json, fetched_at) VALUES (?, ?, ?)')
    .bind(date, JSON.stringify(starts), fetchedAt).run();
}

async function postRequest(token: string, body: Record<string, string>): Promise<Response> {
  return app.request(`/m/${token}/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  }, env);
}

const target = addDays(currentJstDate(), 5);

describe('member page with Square sync', () => {
  it('同期有効: 空きが1つでもある日はフォームが出て、時間は受付時間帯から選べる', async () => {
    const { token } = await createMember('同期会員A');
    await enableSync();
    await seedCache(target, ['13:00']); // 空きは1件だけだが日単位判定なのでフォームは出る
    const res = await app.request(`/m/${token}?date=${target}`, {}, env);
    const html = await res.text();
    expect(html).toContain('リクエスト送信');
    expect(html).toContain('開始時刻');
    expect(html).toContain('<option value="10:00">10:00</option>'); // 選択肢はキャッシュに関係なく受付時間帯の全30分刻み
  });

  it('同期有効: キャッシュ行が無い日は「取得中」でフォームを出さない', async () => {
    const { token } = await createMember('同期会員B');
    await enableSync();
    // target のキャッシュは入れない（未取得）
    const res = await app.request(`/m/${token}?date=${target}`, {}, env);
    const html = await res.text();
    expect(html).toContain('空き情報を取得中です');
    expect(html).not.toContain('リクエスト送信');
  });

  it('同期有効: 空き開始時刻がゼロの日は「Square側で空きがありません」', async () => {
    const { token } = await createMember('同期会員C');
    await enableSync();
    await seedCache(target, []); // 満枠
    const res = await app.request(`/m/${token}?date=${target}`, {}, env);
    const html = await res.text();
    expect(html).toContain('この日はSquare側で空きがありません');
    expect(html).not.toContain('リクエスト送信');
  });

  it('同期有効: 取得時刻の注記が表示される', async () => {
    const { token } = await createMember('同期会員D');
    await enableSync();
    await seedCache(target, ['10:00'], '2026-07-24T00:30:00.000Z'); // JST 9:30
    const res = await app.request(`/m/${token}`, {}, env);
    const html = await res.text();
    expect(html).toContain('時点の空き状況');
    expect(html).toContain('7月24日 9時30分');
  });

  it('同期有効: 空きゼロの日・未取得の日へのPOSTは unavailable', async () => {
    const { token } = await createMember('同期会員E');
    await enableSync();
    await seedCache(target, []); // 満枠
    const res = await postRequest(token, { date: target, start: '10:00', end: '13:00', note: '' });
    expect(res.headers.get('location')).toContain('error=unavailable');

    const unfetched = addDays(target, 1); // キャッシュ未取得の日
    const res2 = await postRequest(token, { date: unfetched, start: '10:00', end: '13:00', note: '' });
    expect(res2.headers.get('location')).toContain('error=unavailable');

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM requests').first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it('同期有効: 空きがある日へのPOSTはキャッシュに無い時間帯でも申請できる（日単位判定）', async () => {
    const { id, token } = await createMember('同期会員F');
    await enableSync();
    await seedCache(target, ['13:00']); // 10:30 の開始時刻はキャッシュに無いが、日に空きがあれば受け付ける
    const res = await postRequest(token, { date: target, start: '10:30', end: '12:00', note: '窓側希望' });
    expect(res.headers.get('location')).toContain('ok=requested');
    const row = await env.DB.prepare('SELECT status, start_time, end_time FROM requests WHERE member_id = ?')
      .bind(id).first<{ status: string; start_time: string; end_time: string }>();
    expect(row!.status).toBe('pending');
    expect(row!.start_time).toBe('10:30');
    expect(row!.end_time).toBe('12:00');
  });

  it('同期有効: 空きゼロの日はカレンダーでグレー×表示になり選択できない（停止日は停が優先）', async () => {
    const { token } = await createMember('同期会員G');
    await enableSync();
    await seedCache(target, []); // 空きゼロ

    const res = await app.request(`/m/${token}?month=${monthOf(target)}`, {}, env);
    const html = await res.text();
    const count = (needle: string) => html.split(needle).length - 1;
    expect(count('<span class="mark">×</span>')).toBe(1); // ×マークが1つ
    expect(html).not.toContain(`?date=${target}`);        // ×日は選択リンクなし
    expect(html).toContain('×の日はSquare側の空きがありません'); // 注記

    // 同じ日を受付停止日にすると「停」が優先され、×は消える
    await env.DB.prepare(`INSERT INTO closed_dates (date, reason) VALUES (?, '休業')`).bind(target).run();
    const res2 = await app.request(`/m/${token}?month=${monthOf(target)}`, {}, env);
    const html2 = await res2.text();
    const count2 = (needle: string) => html2.split(needle).length - 1;
    expect(count2('<span class="mark">停</span>')).toBe(1);
    expect(count2('<span class="mark">×</span>')).toBe(0);
  });
});
