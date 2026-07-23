import { describe, it, expect } from 'vitest';
import { DATE_RE, currentJstDate, addDays, clampDate, formatMD, monthOf, addMonths, buildMonthGrid, isValidDate, isValidMonth } from '../src/core/dates';

describe('dates', () => {
  it('currentJstDate は YYYY-MM-DD を返す', () => {
    expect(currentJstDate()).toMatch(DATE_RE);
  });

  it('addDays は月末・年末・うるう年をまたげる', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29'); // うるう年
    expect(addDays('2026-08-01', -1)).toBe('2026-07-31');
  });

  it('clampDate は範囲内に収める', () => {
    expect(clampDate('2026-07-01', '2026-07-10', '2026-07-20')).toBe('2026-07-10');
    expect(clampDate('2026-07-25', '2026-07-10', '2026-07-20')).toBe('2026-07-20');
    expect(clampDate('2026-07-15', '2026-07-10', '2026-07-20')).toBe('2026-07-15');
  });

  it('formatMD と monthOf', () => {
    expect(formatMD('2026-07-05')).toBe('7/5');
    expect(monthOf('2026-07-05')).toBe('2026-07');
  });

  it('addMonths は年をまたげる', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-07', 0)).toBe('2026-07');
  });

  it('buildMonthGrid は日曜始まりで月の全日を並べる', () => {
    const grid = buildMonthGrid('2026-07'); // 2026-07-01 は水曜
    expect(grid.every((week) => week.length === 7)).toBe(true);
    expect(grid[0]).toEqual([null, null, null, '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04']);
    const days = grid.flat().filter((d): d is string => d !== null);
    expect(days.length).toBe(31);
    expect(days[0]).toBe('2026-07-01');
    expect(days[30]).toBe('2026-07-31');
  });

  it('isValidDate は暦に存在しない日付を弾き、isValidMonth は月の範囲を検証する', () => {
    expect(isValidDate('2026-08-31')).toBe(true);
    expect(isValidDate('2026-08-32')).toBe(false);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2028-02-29')).toBe(true); // うるう年
    expect(isValidDate('2026/08/31')).toBe(false);
    expect(isValidMonth('2026-12')).toBe(true);
    expect(isValidMonth('2026-99')).toBe(false);
    expect(isValidMonth('2026-00')).toBe(false);
  });
});
