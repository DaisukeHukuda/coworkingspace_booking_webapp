/// <reference types="vite/client" />
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig(async () => {
  // decodeURIComponent は import.meta.url がスペースや全角文字を含むパス（%20 等）でも
  // 正しいファイルシステムパスに変換するために必要（このリポジトリのパスは両方含む）
  const migrationsPath = decodeURIComponent(new URL('./migrations', import.meta.url).pathname);
  const migrations = await readD1Migrations(migrationsPath);
  return {
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              ADMIN_PASSWORD: 'test-password',
              SESSION_SECRET: 'test-secret',
              NOTIFY_EMAIL_FROM: 'noreply@example.com'
            }
          }
        }
      }
    }
  };
});
