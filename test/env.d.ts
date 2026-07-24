declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
    ADMIN_PASSWORD: string;
    SESSION_SECRET: string;
    RESEND_API_KEY?: string;
    NOTIFY_EMAIL_FROM?: string;
    APP_ORIGIN?: string;
    SQUARE_ACCESS_TOKEN?: string;
    SQUARE_API_BASE?: string;
  }
}
