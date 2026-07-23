import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../src/index';

describe('smoke', () => {
  it('GET /health が ok を返す', async () => {
    const res = await app.request('/health', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
