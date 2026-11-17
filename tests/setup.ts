import 'dotenv/config';

// Tests truncate tables. Only the isolated test database may be the target:
// the main kanei_crm_mvp database holds the real accounts and demo data, and a
// substring check on "/kanei_crm_mvp" would let it through.
const url = process.env.DATABASE_URL;
if (!url || !/@127\.0\.0\.1:5434\/kanei_crm_mvp_test(\?|$)/.test(url)) {
  throw new Error('Tests require the isolated kanei_crm_mvp_test database on 127.0.0.1:5434');
}
