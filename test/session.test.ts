import { describe, it, expect } from 'vitest';
import { signSession, verifySession, passwordMatches } from '../src/auth/session';

describe('session', () => {
  it('署名したトークンを検証できる', async () => {
    const token = await signSession('secret', Date.now() + 60_000);
    expect(await verifySession('secret', token)).toBe(true);
  });

  it('期限切れトークンは無効', async () => {
    const token = await signSession('secret', Date.now() - 1000);
    expect(await verifySession('secret', token)).toBe(false);
  });

  it('別のsecretで署名されたトークンは無効', async () => {
    const token = await signSession('other', Date.now() + 60_000);
    expect(await verifySession('secret', token)).toBe(false);
  });

  it('改ざんされたトークンは無効', async () => {
    const token = await signSession('secret', Date.now() + 60_000);
    expect(await verifySession('secret', `9${token}`)).toBe(false);
    expect(await verifySession('secret', undefined)).toBe(false);
    expect(await verifySession('secret', 'garbage')).toBe(false);
  });

  it('passwordMatches は一致/不一致を判定する', async () => {
    expect(await passwordMatches('secret', 'pw1', 'pw1')).toBe(true);
    expect(await passwordMatches('secret', 'pw1', 'pw2')).toBe(false);
  });
});
