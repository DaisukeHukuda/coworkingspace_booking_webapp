declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
    ADMIN_PASSWORD: string;
    SESSION_SECRET: string;
  }
}
