import { addDays, clampDate, currentJstDate } from './dates';
import { getSettings } from './settings';

interface SquareEnv {
  SQUARE_ACCESS_TOKEN?: string;
  SQUARE_API_BASE?: string;
}

export interface SyncResult {
  ok: boolean;
  days: number;   // upsert した日数
  error?: string; // 失敗理由（sync_disabled・HTTP xxx・例外メッセージ）
}

const DEFAULT_API_BASE = 'https://connect.squareup.com';
const MAX_CHUNK_DAYS = 31; // Square SearchAvailability の1リクエストの最大範囲

// Square応答の start_at（RFC3339）を JST の { date, time } に変換する。型不正・暦不正は null。
function toJstDateTime(startAt: unknown): { date: string; time: string } | null {
  if (typeof startAt !== 'string') return null;
  const ms = Date.parse(startAt);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms + 9 * 3600_000).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
}

// Square Bookings API SearchAvailability を今日〜今日+windowDays の範囲で呼び、
// 日別の空き開始時刻を availability_cache に upsert する。
// 絶対に例外を投げない（失敗は { ok:false, error } で返す）。実APIはテストで叩かず fetcher を注入する。
export async function syncAvailability(
  db: D1Database,
  env: SquareEnv,
  fetcher: typeof fetch = fetch
): Promise<SyncResult> {
  try {
    const settings = await getSettings(db);
    if (!settings.syncEnabled || !env.SQUARE_ACCESS_TOKEN) {
      // 設定不足では何もしない（呼び出し側でも同期有効を確認するが、多層防御）
      return { ok: false, days: 0, error: 'sync_disabled' };
    }

    const base = (env.SQUARE_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    const url = `${base}/v2/bookings/availability/search`;
    const today = currentJstDate();
    const end = addDays(today, settings.windowDays);
    const fetchedAt = new Date().toISOString();

    // 日別の開始時刻集合。範囲内の全日を空集合で先に埋め、
    // 「取得済みだが枠ゼロ（満枠）」と「未取得（行なし）」を確実に区別する。
    const byDate = new Map<string, Set<string>>();
    for (let d = today; d <= end; d = addDays(d, 1)) byDate.set(d, new Set<string>());

    let chunkStart = today;
    while (chunkStart <= end) {
      const chunkEnd = clampDate(addDays(chunkStart, MAX_CHUNK_DAYS - 1), chunkStart, end);
      const body = {
        query: {
          filter: {
            start_at_range: {
              start_at: `${chunkStart}T00:00:00+09:00`,
              end_at: `${addDays(chunkEnd, 1)}T00:00:00+09:00` // 終端の翌日0時（chunkEnd当日を丸ごと含める）
            },
            location_id: settings.squareLocationId,
            segment_filters: [{ service_variation_id: settings.squareServiceVariationId }]
          }
        }
      };

      const res = await fetcher(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
          'content-type': 'application/json',
          'square-version': '2024-08-21'
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        // 1チャンクでも失敗したら既存キャッシュを温存して中断（部分更新で表示を壊さない）
        return { ok: false, days: 0, error: `HTTP ${res.status}` };
      }

      const json = (await res.json()) as { availabilities?: unknown };
      const availabilities = Array.isArray(json.availabilities) ? json.availabilities : [];
      for (const a of availabilities) {
        const startAt = (a as { start_at?: unknown })?.start_at;
        const jst = toJstDateTime(startAt);
        // 範囲内の日だけ採用（範囲外の枠が混じっても無視）
        if (jst && byDate.has(jst.date)) byDate.get(jst.date)!.add(jst.time);
      }

      chunkStart = addDays(chunkEnd, 1);
    }

    // 日別に upsert（開始時刻は昇順にそろえる）
    const upsert = db.prepare(
      `INSERT INTO availability_cache (date, slots_json, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET slots_json = excluded.slots_json, fetched_at = excluded.fetched_at`
    );
    const batch = [...byDate.entries()].map(([date, starts]) =>
      upsert.bind(date, JSON.stringify([...starts].sort()), fetchedAt)
    );
    if (batch.length > 0) await db.batch(batch);

    return { ok: true, days: byDate.size };
  } catch (e) {
    // 応答JSONの破損・ネットワーク例外なども握りつぶし、既存キャッシュを温存する（会員ページは前回値で継続表示）
    return { ok: false, days: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

// 指定範囲のキャッシュを「日付→開始時刻配列」で返す。行が有る日だけキーが入る（空配列＝満枠）。
export async function getCachedStarts(db: D1Database, from: string, to: string): Promise<Map<string, string[]>> {
  const result = await db.prepare('SELECT date, slots_json FROM availability_cache WHERE date >= ? AND date <= ?')
    .bind(from, to).all<{ date: string; slots_json: string }>();
  const map = new Map<string, string[]>();
  for (const r of result.results) {
    let starts: string[] = [];
    try {
      const parsed = JSON.parse(r.slots_json);
      if (Array.isArray(parsed)) starts = parsed.filter((s): s is string => typeof s === 'string');
    } catch {
      // 壊れた値は空配列扱い（次回同期で直る）
    }
    map.set(r.date, starts);
  }
  return map;
}

// 同期状態（キャッシュ日数と最終取得時刻）。設定画面の表示と scheduled の24h判定で使う。
export async function getCacheStatus(db: D1Database): Promise<{ days: number; lastFetched: string | null }> {
  const row = await db.prepare('SELECT COUNT(*) AS n, MAX(fetched_at) AS m FROM availability_cache')
    .first<{ n: number; m: string | null }>();
  return { days: row?.n ?? 0, lastFetched: row?.m ?? null };
}

// --- ステップ⑤(§17.5): 設定画面用の一覧ヘルパー。絶対に例外を投げない・実APIはテストで叩かず fetcher を注入する ---

export interface SquareOption {
  id: string;
  name: string;
}

export type SquareListResult = { ok: true; items: SquareOption[] } | { ok: false; error: string };

// Square Locations API からロケーション一覧を取得する。name 欠落は id で代用。
// 想定外の形状は該当要素だけ無視して継続する（実APIとの形状差は結合確認で吸収）。
export async function fetchLocations(env: SquareEnv, fetcher: typeof fetch = fetch): Promise<SquareListResult> {
  try {
    if (!env.SQUARE_ACCESS_TOKEN) return { ok: false, error: 'no_token' };
    const base = (env.SQUARE_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    const res = await fetcher(`${base}/v2/locations`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'square-version': '2024-08-21'
      }
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const json = (await res.json()) as { locations?: unknown };
    const items: SquareOption[] = [];
    if (Array.isArray(json.locations)) {
      for (const l of json.locations) {
        const id = (l as { id?: unknown })?.id;
        const name = (l as { name?: unknown })?.name;
        if (typeof id === 'string' && id !== '') {
          items.push({ id, name: typeof name === 'string' && name !== '' ? name : id });
        }
      }
    }
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Square Catalog API から予約可能サービス（APPOINTMENTS_SERVICE）のバリエーション一覧を取得する。
// id はバリエーションID（= service_variation_id として設定に保存する値）、name は「アイテム名（バリエーション名）」。
export async function fetchBookableServices(env: SquareEnv, fetcher: typeof fetch = fetch): Promise<SquareListResult> {
  try {
    if (!env.SQUARE_ACCESS_TOKEN) return { ok: false, error: 'no_token' };
    const base = (env.SQUARE_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    const res = await fetcher(`${base}/v2/catalog/search-catalog-items`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'content-type': 'application/json',
        'square-version': '2024-08-21'
      },
      body: JSON.stringify({ product_types: ['APPOINTMENTS_SERVICE'] })
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const json = (await res.json()) as { items?: unknown };
    const items: SquareOption[] = [];
    if (Array.isArray(json.items)) {
      for (const item of json.items) {
        const itemData = (item as { item_data?: unknown })?.item_data as
          | { name?: unknown; variations?: unknown }
          | undefined;
        const rawItemName = itemData?.name;
        const itemName = typeof rawItemName === 'string' ? rawItemName : '';
        const rawVariations = itemData?.variations;
        const variations = Array.isArray(rawVariations) ? rawVariations : [];
        for (const v of variations) {
          const vid = (v as { id?: unknown })?.id;
          if (typeof vid !== 'string' || vid === '') continue;
          const vData = (v as { item_variation_data?: unknown })?.item_variation_data as
            | { name?: unknown }
            | undefined;
          const rawVName = vData?.name;
          const vName = typeof rawVName === 'string' ? rawVName : '';
          const name =
            itemName !== '' && vName !== '' && vName !== itemName
              ? `${itemName}（${vName}）`
              : itemName !== ''
                ? itemName
                : vName !== ''
                  ? vName
                  : vid;
          items.push({ id: vid, name });
        }
      }
    }
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
