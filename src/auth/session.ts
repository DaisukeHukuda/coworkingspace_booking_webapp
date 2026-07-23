const encoder = new TextEncoder();

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

function toBase64Url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(s: string): Uint8Array | null {
  try {
    const b64 = s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (s.length % 4)) % 4);
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

// トークン形式: `${expiresAtMs}.${base64url(HMAC-SHA256(expiresAtMs))}`
export async function signSession(secret: string, expiresAtMs: number): Promise<string> {
  const key = await hmacKey(secret, 'sign');
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(String(expiresAtMs)));
  return `${expiresAtMs}.${toBase64Url(sig)}`;
}

export async function verifySession(secret: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const sigBytes = fromBase64Url(token.slice(dot + 1));
  if (!sigBytes || sigBytes.length === 0) return false;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const key = await hmacKey(secret, 'verify');
  return crypto.subtle.verify('HMAC', key, sigBytes as unknown as BufferSource, encoder.encode(exp));
}

// パスワード比較。生文字列の === 比較によるタイミング差を避けるため、両者のHMACダイジェストを比較する
export async function passwordMatches(secret: string, input: string, expected: string): Promise<boolean> {
  const key = await hmacKey(secret, 'sign');
  const a = toBase64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(input)));
  const b = toBase64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(expected)));
  return a === b;
}
