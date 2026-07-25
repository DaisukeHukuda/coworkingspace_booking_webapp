import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  getSettings, setSetting, saveSettings,
  isHalfStep, halfStepRange, timeOptions
} from '../src/core/settings';

describe('settings', () => {
  it('シード値を読み出せる（受付時間帯の既定は10:00〜21:00）', async () => {
    const s = await getSettings(env.DB);
    expect(s.openStart).toBe('10:00');
    expect(s.openEnd).toBe('21:00');
    expect(s.windowDays).toBe(60);
    expect(s.staffEmail).toBe('');
  });

  it('setSetting は上書き保存できる', async () => {
    await setSetting(env.DB, 'staff_email', 'staff@example.com');
    await setSetting(env.DB, 'window_days', '30');
    const s = await getSettings(env.DB);
    expect(s.staffEmail).toBe('staff@example.com');
    expect(s.windowDays).toBe(30);
  });

  it('open_start/open_end が壊れた値（非30分刻み・開始>=終了）でもデフォルトにフォールバックする', async () => {
    await setSetting(env.DB, 'open_start', '10:15'); // 30分刻みでない
    await setSetting(env.DB, 'open_end', '21:00');
    let s = await getSettings(env.DB);
    expect(s.openStart).toBe('10:00'); // 既定へ
    expect(s.openEnd).toBe('21:00');

    await setSetting(env.DB, 'open_start', '21:00'); // 開始>=終了
    await setSetting(env.DB, 'open_end', '10:00');
    s = await getSettings(env.DB);
    expect(s.openStart).toBe('10:00');
    expect(s.openEnd).toBe('21:00');

    await setSetting(env.DB, 'open_start', '09:00'); // 正しい値は反映
    await setSetting(env.DB, 'open_end', '18:30');
    s = await getSettings(env.DB);
    expect(s.openStart).toBe('09:00');
    expect(s.openEnd).toBe('18:30');
  });

  it('isHalfStep と halfStepRange', () => {
    expect(isHalfStep('10:00')).toBe(true);
    expect(isHalfStep('10:30')).toBe(true);
    expect(isHalfStep('10:15')).toBe(false); // 15分は不可
    expect(isHalfStep('24:00')).toBe(false); // 時が範囲外
    expect(isHalfStep('9:00')).toBe(false);  // ゼロ埋めでない
    expect(halfStepRange('10:00', '11:30')).toEqual(['10:00', '10:30', '11:00', '11:30']);
    expect(halfStepRange('10:00', '10:00')).toEqual(['10:00']);
  });

  it('timeOptions は開始（末尾を除く）・終了（先頭を除く）の選択肢を返す', () => {
    const { starts, ends } = timeOptions('10:00', '12:00');
    expect(starts).toEqual(['10:00', '10:30', '11:00', '11:30']); // 12:00 では始められない
    expect(ends).toEqual(['10:30', '11:00', '11:30', '12:00']);   // 10:00 では終われない
  });

  it('Square未設定なら syncEnabled は false で ID は空', async () => {
    const s = await getSettings(env.DB);
    expect(s.squareLocationId).toBe('');
    expect(s.squareServiceVariationId).toBe('');
    expect(s.syncEnabled).toBe(false);
  });

  it('ロケーションIDとサービスIDが両方あれば syncEnabled は true', async () => {
    await setSetting(env.DB, 'square_location_id', 'LOC123');
    await setSetting(env.DB, 'square_service_variation_id', 'SV456');
    const s = await getSettings(env.DB);
    expect(s.squareLocationId).toBe('LOC123');
    expect(s.squareServiceVariationId).toBe('SV456');
    expect(s.syncEnabled).toBe(true);
  });

  it('片方だけの設定では syncEnabled は false（無効のまま）', async () => {
    await setSetting(env.DB, 'square_location_id', 'LOC123');
    const s = await getSettings(env.DB);
    expect(s.syncEnabled).toBe(false);
  });

  it('saveSettings は複数キーを一括保存できる', async () => {
    await saveSettings(env.DB, [
      { key: 'staff_email', value: 'batch@example.com' },
      { key: 'window_days', value: '45' },
      { key: 'square_location_id', value: 'LOCX' }
    ]);
    const s = await getSettings(env.DB);
    expect(s.staffEmail).toBe('batch@example.com');
    expect(s.windowDays).toBe(45);
    expect(s.squareLocationId).toBe('LOCX');
  });
});
