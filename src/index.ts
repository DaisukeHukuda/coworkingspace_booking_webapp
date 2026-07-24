import { Hono } from 'hono';
import { admin } from './routes/admin';
import { member } from './routes/member';
import { STYLE_CSS } from './routes/style-css';
import { runScheduled } from './core/scheduled';
import type { Bindings } from './types';

// Hono アプリ本体。テストはこの named export を import して app.request(...) で叩く。
export const app = new Hono<{ Bindings: Bindings }>();

app.get('/health', (c) => c.json({ ok: true }));
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));
app.get('/style.css', (c) => {
  c.header('content-type', 'text/css; charset=utf-8');
  c.header('cache-control', 'public, max-age=3600');
  return c.body(STYLE_CSS);
});
app.route('/admin', admin);
app.route('/m', member);

// Workers のエントリ。fetch は Hono、scheduled は15分ごとの cron（薄いラッパ。実体は runScheduled）。
export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScheduled(env.DB, env));
  }
} satisfies ExportedHandler<Bindings>;
