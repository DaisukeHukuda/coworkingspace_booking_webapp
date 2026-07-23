import { Hono } from 'hono';
import { admin } from './routes/admin';
import type { Bindings } from './types';

const app = new Hono<{ Bindings: Bindings }>();

app.get('/health', (c) => c.json({ ok: true }));
app.route('/admin', admin);

export default app;
