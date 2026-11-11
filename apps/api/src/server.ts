import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createDatabase } from '@kanei/db';
import { createApp } from './app.js';
import { loadApiEnv } from './env.js';

const env = loadApiEnv();
const { db, pool } = createDatabase(env.databaseUrl);
const app = createApp({ db, secureCookies: env.isProduction });

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`KANEI CRM API listening on http://127.0.0.1:${info.port}`);
});

async function shutdown() {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await pool.end();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
