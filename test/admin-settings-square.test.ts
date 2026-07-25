import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { adminCookie } from './helpers';
import { getSettings } from '../src/core/settings';

async function post(cookie: string, body: Record<string, string>): Promise<Response> {
  return app.request('/admin/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(body).toString()
  }, env);
}

const BASE = { staff_email: '', window_days: '60', open_start: '10:00', open_end: '21:00' };

describe('admin settings Square', () => {
  it('Squareセクションが表示され、トークン未設定の一覧取得はエラー案内＋手入力継続', async () => {
    const cookie = await adminCookie();
    const res = await app.request('/admin/settings', { headers: { cookie } }, env);
    const html = await res.text();
    expect(html).toContain('Square連携');
    expect(html).toContain('同期無効');
    expect(html).toContain('今すぐ同期');
    expect(html).toContain('Squareから一覧を取得');

    // テスト環境に SQUARE_ACCESS_TOKEN は無い → ?square=1 は日本語エラー案内を出し、手入力欄は残る
    const helper = await app.request('/admin/settings?square=1', { headers: { cookie } }, env);
    expect(helper.status).toBe(200);
    const helperHtml = await helper.text();
    expect(helperHtml).toContain('一覧を取得できませんでした');
    expect(helperHtml).toContain('name="square_location_id"'); // 手入力欄は残る
    expect(helperHtml).toContain('name="square_service_variation_id"');
  });

  it('ロケーションIDとサービスIDを保存すると同期有効になる', async () => {
    const cookie = await adminCookie();
    const res = await post(cookie, { ...BASE, square_location_id: 'LOC123', square_service_variation_id: 'SV456' });
    expect(res.headers.get('location')).toBe('/admin/settings?ok=saved');
    const s = await getSettings(env.DB);
    expect(s.squareLocationId).toBe('LOC123');
    expect(s.squareServiceVariationId).toBe('SV456');
    expect(s.syncEnabled).toBe(true);
  });

  it('片方だけ入力しても同期無効のまま', async () => {
    const cookie = await adminCookie();
    await post(cookie, { ...BASE, square_location_id: 'LOC123', square_service_variation_id: '' });
    const s = await getSettings(env.DB);
    expect(s.syncEnabled).toBe(false);
  });

  it('「今すぐ同期」はアクセストークン未設定だと sync_failed にリダイレクトする', async () => {
    const cookie = await adminCookie();
    // 同期有効化（IDは入れるが、テスト環境に SQUARE_ACCESS_TOKEN は無い）
    await post(cookie, { ...BASE, square_location_id: 'LOC123', square_service_variation_id: 'SV456' });
    const res = await app.request('/admin/settings/sync', { method: 'POST', headers: { cookie } }, env);
    expect(res.headers.get('location')).toBe('/admin/settings?error=sync_failed');
  });
});
