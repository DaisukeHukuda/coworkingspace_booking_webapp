export interface AppSettings {
  openStart: string;    // 受付時間帯の開始 'HH:MM'（30分刻み）
  openEnd: string;      // 受付時間帯の終了 'HH:MM'（30分刻み）
  windowDays: number;
  staffEmail: string;
  squareLocationId: string;
  squareServiceVariationId: string;
  syncEnabled: boolean; // squareLocationId と squareServiceVariationId が両方非空なら true
}

export type SettingKey =
  | 'open_start'
  | 'open_end'
  | 'window_days'
  | 'staff_email'
  | 'square_location_id'
  | 'square_service_variation_id'
  | `mail_tpl_${'requested' | 'requested_member' | 'cancelled' | 'confirmed' | 'declined'}_${'subject' | 'body'}`;

export const DEFAULT_WINDOW_DAYS = 60;
export const DEFAULT_OPEN_START = '10:00';
export const DEFAULT_OPEN_END = '21:00';

const HALF_STEP_RE = /^([01]\d|2[0-3]):(00|30)$/;

// 30分刻みの時刻か（時は00〜23・分は '00' か '30' のみ・ゼロ埋め必須）
export function isHalfStep(t: string): boolean {
  return HALF_STEP_RE.test(t);
}

function toMinutes(t: string): number {
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
}

function toHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// from..to を30分刻みで列挙（両端含む）。from/to は30分刻み・from<=to を前提とする。
export function halfStepRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = toMinutes(from); m <= toMinutes(to); m += 30) out.push(toHHMM(m));
  return out;
}

// 受付時間帯から開始・終了プルダウンの選択肢を作る。
// starts は末尾（openEnd）を除く＝開始は必ず終了より前になる。ends は先頭（openStart）を除く。
export function timeOptions(openStart: string, openEnd: string): { starts: string[]; ends: string[] } {
  const all = halfStepRange(openStart, openEnd);
  return { starts: all.slice(0, -1), ends: all.slice(1) };
}

// 会員リクエストの時間検証: 30分刻み・受付時間帯内・開始<終了。'HH:MM' はゼロ埋めなので文字列比較で順序判定できる。
export function validTimeRange(start: string, end: string, openStart: string, openEnd: string): boolean {
  return isHalfStep(start) && isHalfStep(end) && start >= openStart && end <= openEnd && start < end;
}

export async function getSettings(db: D1Database): Promise<AppSettings> {
  const rows = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const map = new Map(rows.results.map((r) => [r.key, r.value]));

  // 受付時間帯。両方が30分刻みで開始<終了のときだけ採用し、そうでなければ既定にフォールバックする。
  // 0001シードの 'slots' 行はDBに残っているが、ステップ⑤以降どこからも読まない（無害な残置）。
  let openStart = DEFAULT_OPEN_START;
  let openEnd = DEFAULT_OPEN_END;
  const rawStart = (map.get('open_start') ?? '').trim();
  const rawEnd = (map.get('open_end') ?? '').trim();
  if (isHalfStep(rawStart) && isHalfStep(rawEnd) && rawStart < rawEnd) {
    openStart = rawStart;
    openEnd = rawEnd;
  }

  const windowRaw = Number(map.get('window_days'));
  const windowDays = Number.isInteger(windowRaw) && windowRaw >= 1 && windowRaw <= 365 ? windowRaw : DEFAULT_WINDOW_DAYS;

  const squareLocationId = (map.get('square_location_id') ?? '').trim();
  const squareServiceVariationId = (map.get('square_service_variation_id') ?? '').trim();
  const syncEnabled = squareLocationId !== '' && squareServiceVariationId !== '';

  return {
    openStart,
    openEnd,
    windowDays,
    staffEmail: map.get('staff_email') ?? '',
    squareLocationId,
    squareServiceVariationId,
    syncEnabled
  };
}

export async function setSetting(db: D1Database, key: SettingKey, value: string): Promise<void> {
  await db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(key, value).run();
}

// 複数の設定キーを1回のD1バッチ（暗黙トランザクション）で保存する。
export async function saveSettings(db: D1Database, entries: { key: SettingKey; value: string }[]): Promise<void> {
  if (entries.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  await db.batch(entries.map((e) => stmt.bind(e.key, e.value)));
}
