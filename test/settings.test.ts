import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getSettings, setSetting, saveSettings, parseSlotsText, slotsToText, findSlot, DEFAULT_SLOTS } from '../src/core/settings';

describe('settings', () => {
  it('シード値を読み出せる', async () => {
    const s = await getSettings(env.DB);
    expect(s.slots).toEqual(DEFAULT_SLOTS);
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

  it('slots が壊れた値（不正JSON・空配列・不正な時刻）でもデフォルトにフォールバックする', async () => {
    await setSetting(env.DB, 'slots', '{broken');
    expect((await getSettings(env.DB)).slots).toEqual(DEFAULT_SLOTS);

    await setSetting(env.DB, 'slots', '[]'); // 枠ゼロは無効
    expect((await getSettings(env.DB)).slots).toEqual(DEFAULT_SLOTS);

    await setSetting(env.DB, 'slots', '[{"start":"zz","end":"99:99"}]'); // 時刻形式不正
    expect((await getSettings(env.DB)).slots).toEqual(DEFAULT_SLOTS);

    await setSetting(env.DB, 'slots', '[{"start":"13:00","end":"10:00"}]'); // 開始>=終了
    expect((await getSettings(env.DB)).slots).toEqual(DEFAULT_SLOTS);
  });

  it('parseSlotsText は「HH:MM-HH:MM」の行を受け付ける', () => {
    expect(parseSlotsText('10:00-13:00\n13:00-17:00')).toEqual([
      { start: '10:00', end: '13:00' },
      { start: '13:00', end: '17:00' }
    ]);
    // 空行と前後空白は無視、開始時刻順に整列
    expect(parseSlotsText(' 17:00-21:00 \n\n10:00-13:00\n')).toEqual([
      { start: '10:00', end: '13:00' },
      { start: '17:00', end: '21:00' }
    ]);
  });

  it('parseSlotsText は不正入力に null を返す', () => {
    expect(parseSlotsText('')).toBeNull();               // 枠ゼロ
    expect(parseSlotsText('10:00')).toBeNull();          // 形式不正
    expect(parseSlotsText('13:00-10:00')).toBeNull();    // 開始>=終了
    expect(parseSlotsText('25:00-26:00')).toBeNull();    // 時刻範囲外
    expect(parseSlotsText('10:00-13:00\n10:00-14:00')).toBeNull(); // 開始時刻重複
  });

  it('slotsToText と findSlot', () => {
    expect(slotsToText(DEFAULT_SLOTS)).toBe('10:00-13:00\n13:00-17:00\n17:00-21:00');
    expect(findSlot(DEFAULT_SLOTS, '13:00')).toEqual({ start: '13:00', end: '17:00' });
    expect(findSlot(DEFAULT_SLOTS, '09:00')).toBeNull();
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
