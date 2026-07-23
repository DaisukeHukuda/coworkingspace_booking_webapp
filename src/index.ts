import { Hono } from 'hono';
import { admin } from './routes/admin';
import { member } from './routes/member';
import { STYLE_CSS } from './routes/style-css';
import type { Bindings } from './types';

const app = new Hono<{ Bindings: Bindings }>();

app.get('/health', (c) => c.json({ ok: true }));
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));
app.get('/style.css', (c) => {
  c.header('content-type', 'text/css; charset=utf-8');
  c.header('cache-control', 'public, max-age=3600');
  return c.body(STYLE_CSS);
});
app.route('/admin', admin);
app.route('/m', member);

export default app;
