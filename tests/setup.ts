import 'dotenv/config';

const url = process.env.DATABASE_URL;
if (!url || !url.includes('@127.0.0.1:5434/') || !url.includes('/kanei_crm_mvp')) {
  throw new Error('Tests require the isolated kanei_crm_mvp database on 127.0.0.1:5434');
}
