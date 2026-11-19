# Login guard deployment contract (2026-11-19)

1. Caddy sets `X-Forwarded-For $remote_addr` for `/api/auth/*` traffic.
2. The Next login relay must prepend that exact client address as the first value of API `X-Forwarded-For`. The web worker owns this code change; until merged, browser relay traffic is attributed to the relay socket.
3. API accepts XFF only when its socket peer is in `TRUSTED_PROXY_CIDRS`. Production compose trusts `127.0.0.1/32`, `::1/128`, and the explicit `172.28.28.0/24` API/web network. An external caller cannot make API trust a forged XFF.
4. Locking is account+IP with exponential backoff: 1→60m, then 2m, 4m, capped at 60m. A separate IP-limit starts after 10 failures from the same source. Expiry is automatic; successful login never rewrites audit history.
5. Representative recovery is append-only:
   `DATABASE_URL=... node scripts/unlock-login-guard.mjs --username NAME --remote-address IP --reason 'approved recovery'`
   Test DB works directly; production recovery additionally requires `ALLOW_PRODUCTION_LOGIN_UNLOCK=1` and representative approval.
6. Admin accounts are protected by the IP-level delay first, so one source cannot lock a representative account for all networks. Do not expose an unauthenticated unlock endpoint.

## R1-4 boundary correction

View/download authorization returns to the pre-R1-4 matrix: admin may act across projects (global recovery), an assigned staff member may access its project, and viewer/unassigned staff is refused. No project-membership pre-check is inserted in front of `canPerform`.
