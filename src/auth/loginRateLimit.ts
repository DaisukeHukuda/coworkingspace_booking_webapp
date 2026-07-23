export const MAX_FAILURES = 10;
export const WINDOW_MS = 15 * 60_000; // 15分

export async function tooManyFailures(db: D1Database, ip: string): Promise<boolean> {
  const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();
  const row = await db.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND created_at >= ?')
    .bind(ip, windowStart).first<{ n: number }>();
  return (row?.n ?? 0) >= MAX_FAILURES;
}

export async function recordFailure(db: D1Database, ip: string): Promise<void> {
  await db.prepare('INSERT INTO login_failures (ip, created_at) VALUES (?, ?)')
    .bind(ip, new Date().toISOString()).run();
}

export async function clearFailures(db: D1Database, ip: string): Promise<void> {
  await db.prepare('DELETE FROM login_failures WHERE ip = ?').bind(ip).run();
}
