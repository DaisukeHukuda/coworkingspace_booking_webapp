export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

// JSTの「今日」。UTC+9固定（日本にDSTはない）。booking-systemで実証済みの方式
export function currentJstDate(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

export function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function clampDate(date: string, min: string, max: string): string {
  if (date < min) return min;
  if (date > max) return max;
  return date;
}

export function formatMD(date: string): string {
  const [, m, d] = date.split('-');
  return `${Number(m)}/${Number(d)}`;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function addMonths(month: string, delta: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + delta;
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
}

// 日曜始まりの週配列。月外のセルは null
export function buildMonthGrid(month: string): (string | null)[][] {
  const firstDow = new Date(`${month}-01T00:00:00Z`).getUTCDay();
  const daysInMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// 形式だけでなく暦としても実在する日付か（例: 2026-08-32 や 2026-02-30 を弾く）。
// V8は暦に存在しないISO日付をNaNにするが、往復一致も確認して確実にする
export function isValidDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === date;
}

export function isValidMonth(month: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(month)) return false;
  const m = Number(month.slice(5, 7));
  return m >= 1 && m <= 12;
}
