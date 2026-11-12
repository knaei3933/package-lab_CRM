import 'dotenv/config';
import { makerPurchaseOrderTransitions } from '@kanei/core';

const url = process.env.DATABASE_URL;
if (!url || !url.includes('@127.0.0.1:5434/') || !url.includes('/kanei_crm_mvp')) {
  throw new Error('Tests require the isolated kanei_crm_mvp database on 127.0.0.1:5434');
}

// tests/m4/core-rules.test.ts references the maker PO transition-table helper
// bare, with no import statement for it, so publish the @kanei/core export as
// a test global for that identifier to resolve against.
Object.assign(globalThis, { makerPurchaseOrderTransitions });
