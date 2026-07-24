export interface Slot {
  start: string; // 'HH:MM'
  end: string;   // 'HH:MM'
}

export interface AppSettings {
  slots: Slot[];
  windowDays: number;
  staffEmail: string;
  squareLocationId: string;
  squareServiceVariationId: string;
  syncEnabled: boolean; // squareLocationId と squareServiceVariationId が両方非空なら true
}

export type SettingKey =
  | 'slots'
  | 'window_days'
  | 'staff_email'
  | 'square_location_id'
  | 'square_service_variation_id';

export const DEFAULT_SLOTS: Slot[] = [
  { start: '10:00', end: '13:00' },
  { start: '13:00', end: '17:00' },
  { start: '17:00', end: '21:00' }
];
export const DEFAULT_WINDOW_DAYS = 60;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function getSettings(db: D1Database): Promise<AppSettings> {
  const rows = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const map = new Map(rows.results.map((r) => [r.key, r.value]));

  let slots = DEFAULT_SLOTS;
  const slotsRaw = map.get('slots');
  if (slotsRaw) {
    try {
      const parsed = JSON.parse(slotsRaw);
      // 形だけでなくドメイン条件（時刻形式・開始<終了・1件以上）も検証する。
      // 保存経路は parseSlotsText で検証するが、DB直接編集等で壊れた値が入っても
      // 「壊れた設定値はデフォルトにフォールバック」の制約を守るための多層防御
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every(
          (s) =>
            typeof s?.start === 'string' && typeof s?.end === 'string' &&
            TIME_RE.test(s.start) && TIME_RE.test(s.end) && s.start < s.end
        )
      ) {
        slots = parsed;
      }
    } catch {
      // 壊れた値はデフォルトにフォールバック（設定画面から保存し直せば直る）
    }
  }

  const windowRaw = Number(map.get('window_days'));
  const windowDays = Number.isInteger(windowRaw) && windowRaw >= 1 && windowRaw <= 365 ? windowRaw : DEFAULT_WINDOW_DAYS;

  const squareLocationId = (map.get('square_location_id') ?? '').trim();
  const squareServiceVariationId = (map.get('square_service_variation_id') ?? '').trim();
  const syncEnabled = squareLocationId !== '' && squareServiceVariationId !== '';

  return {
    slots,
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
// 設定画面の保存で複数キーをまとめて書くのに使う（ステップ②持ち越し: setSetting3連の解消）
export async function saveSettings(db: D1Database, entries: { key: SettingKey; value: string }[]): Promise<void> {
  if (entries.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  await db.batch(entries.map((e) => stmt.bind(e.key, e.value)));
}

// 1行1枠「HH:MM-HH:MM」。空行・前後空白は無視し、開始時刻順に整列して返す。不正は null
export function parseSlotsText(text: string): Slot[] | null {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0 || lines.length > 10) return null;
  const slots: Slot[] = [];
  for (const line of lines) {
    const m = line.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
    if (!m) return null;
    const [, start, end] = m;
    if (!TIME_RE.test(start) || !TIME_RE.test(end) || start >= end) return null;
    slots.push({ start, end });
  }
  slots.sort((a, b) => (a.start < b.start ? -1 : 1));
  for (let i = 1; i < slots.length; i++) {
    if (slots[i].start === slots[i - 1].start) return null;
  }
  return slots;
}

export function slotsToText(slots: Slot[]): string {
  return slots.map((s) => `${s.start}-${s.end}`).join('\n');
}

export function findSlot(slots: Slot[], start: string): Slot | null {
  return slots.find((s) => s.start === start) ?? null;
}
