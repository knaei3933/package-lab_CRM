# KANEI CRM MVP (M0)

Isolated M0 foundation. This repository intentionally does not connect to the legacy
`kanei-crm` or `pouch-clacul` systems.

## Local services

- Web: Next.js 15 App Router, Japanese UI, port `3080`
- API: Hono + TypeScript strict, port `3081`
- DB: isolated PostgreSQL 16, host port `5434`, database `kanei_crm_mvp`

```bash
cp .env.example .env
npm install
npm run db:up
npm run db:migrate
npm run db:seed
npm test
```

Composite credentials (local development/test only):

| User | Role | Password |
| --- | --- | --- |
| `admin_composite` | `admin` | `composite-admin-pass` |
| `staff_composite` | `staff` | `composite-staff-pass` |
| `viewer_composite` | `viewer` | `composite-viewer-pass` |

## M0 contracts

- Project creation accepts only `route=F1`; `direct_film` and `F2` return 422 and persist nothing.
- Route mutation is rejected; the database additionally constrains projects to F1.
- Session tokens are random values and only SHA-256 hashes are stored.
- Authorization rechecks active user, session expiry, business unit, project assignment, and operation on every request.
