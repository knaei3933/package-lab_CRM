import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './packages/db/src/schema.ts',
  out: './packages/db/drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://kanei:local_only@127.0.0.1:5434/kanei_crm_mvp'
  },
  verbose: true,
  strict: true
});
