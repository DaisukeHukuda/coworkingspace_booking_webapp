import { describe, it, expect } from 'vitest';
import { newMemberToken } from '../src/token';

describe('newMemberToken', () => {
  it('40桁の小文字hexを返す', () => {
    const t = newMemberToken();
    expect(t).toMatch(/^[0-9a-f]{40}$/);
  });

  it('毎回異なる値を返す（100回で重複なし）', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(newMemberToken());
    expect(seen.size).toBe(100);
  });
});
