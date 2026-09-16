import { createStore } from './store.js';
import { createWorker } from './worker.js';
import { createApp } from './app.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT) || 4173;
const store = createStore(process.env.GEOXPL_DB || 'runtime/geoxpl.sqlite');
let boundary = null;
try { boundary = JSON.parse(readFileSync('public/victoria.geojson', 'utf8')); } catch { console.warn('Victoria boundary unavailable. Publication will require review.'); }
const worker = createWorker(store, { boundary });
const app = createApp(store, { localSetup: (host === '127.0.0.1' || host === 'localhost') && process.env.ALLOW_ADMIN_SETUP !== 'false', secureCookies: process.env.SECURE_COOKIES === 'true' });
if (process.argv.includes('--production')) {
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
const server = app.listen(port, host, () => console.log(`GeoXpl: http://${host}:${port}\nAdministration: http://${host}:${port}/admin`));
server.on('error', err => { console.error(err.message); process.exit(1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { worker.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
