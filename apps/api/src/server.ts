import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createDatabase } from '@kanei/db';
import { createApp } from './app.js';
import { loadApiEnv } from './env.js';
import { validateDocumentStorageRoot } from './document-storage.js';

const env = loadApiEnv();
// Fail before opening a database connection or listener if the private
// document root was not explicitly provisioned and validated.
await validateDocumentStorageRoot();
const { db, pool } = createDatabase(env.databaseUrl);
const app = createApp({
  db,
  secureCookies: env.isProduction,
  allowedOrigins: env.allowedOrigins,
  trustedProxyCidrs: env.trustedProxyCidrs,
  trustedProxyConfigured: env.trustedProxyConfigured,
  port: env.port,
  loginTimeoutMs: env.loginTimeoutMs
});
if (env.isProduction && !env.trustedProxyConfigured) {
  throw new Error('TRUSTED_PROXY_CIDRS is required in production');
}

const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
  console.log(`KANEI CRM API listening on http://${env.host}:${info.port}`);
});

async function shutdown() {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await pool.end();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
