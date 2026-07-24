import { getSettings } from './settings';
import { syncAvailability, getCacheStatus } from './square';
import { sendSyncStaleNotification } from './notify';

interface ScheduledEnv {
  RESEND_API_KEY?: string;
  NOTIFY_EMAIL_FROM?: string;
  APP_ORIGIN?: string;
  SQUARE_ACCESS_TOKEN?: string;
  SQUARE_API_BASE?: string;
}

const DAY_MS = 24 * 3600_000;

// 15分ごとの cron から呼ばれる定期処理。cron 実行そのものはテストせず、この関数を直接呼ぶ。
// nowMs は 24h 判定・掃除の基準時刻。テストで注入して決定性を保つ。絶対に例外を投げない。
export async function runScheduled(
  db: D1Database,
  env: ScheduledEnv,
  fetcher: typeof fetch = fetch,
  nowMs: number = Date.now()
): Promise<void> {
  try {
    const settings = await getSettings(db);

    // (a) 同期有効なら Square から取得（失敗しても例外にはならない）
    if (settings.syncEnabled) {
      await syncAvailability(db, env, fetcher);
    }

    // (b) ステップ②持ち越し: 1日より古いログイン失敗履歴を掃除する
    const cutoff = new Date(nowMs - DAY_MS).toISOString();
    await db.prepare('DELETE FROM login_failures WHERE created_at < ?').bind(cutoff).run();

    // (c) 同期有効かつ最終取得から24時間超（未取得=null含む）なら、同期停止をスタッフへ通知する。
    //     (a) の同期が成功していれば lastFetched は現在時刻になり stale にならない。
    if (settings.syncEnabled) {
      const { lastFetched } = await getCacheStatus(db);
      const stale = lastFetched === null || nowMs - Date.parse(lastFetched) > DAY_MS;
      if (stale) {
        await sendSyncStaleNotification(db, env, env.APP_ORIGIN ?? '', fetcher);
      }
    }
  } catch {
    // cron の定期処理は失敗しても握りつぶす（次回15分後に再試行される）
  }
}
