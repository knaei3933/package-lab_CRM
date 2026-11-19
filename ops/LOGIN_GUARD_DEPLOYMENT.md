# Login guard deployment contract (2026-11-19 update)

## Required production chain

1. **Caddy → web.** Caddy is the public edge. For login traffic it sets the actual client address as the only/right-most proxy value in `X-Forwarded-For`. In Caddy 2 the reverse proxy defaults add the peer address to XFF; keep this behavior for `/api/auth/*`.
2. **Web relay → API.** The Next login relay sends exactly one API `X-Forwarded-For` value: the valid IP literal read from Caddy's value. This relay is active only when `KANEI_WEB_BEHIND_TRUSTED_PROXY=1`.
3. **Compose.** The web service must set `KANEI_WEB_BEHIND_TRUSTED_PROXY: "1"`. Port `3080` must remain unpublished; Caddy is the only public HTTP/HTTPS service.
4. **API trust.** API trusts XFF only when its socket peer is in `TRUSTED_PROXY_CIDRS`. Production compose trusts loopback and the explicit API/web network `172.28.28.0/24`. An Internet peer cannot forge a trusted forwarded value.

## Warning

Without `KANEI_WEB_BEHIND_TRUSTED_PROXY=1` (and the deployed web relay code), API sees every browser as the web socket. An attacker can make repeated failures for the representative's username and, although automatic delays expire, repeatedly prevent that account from logging in across all networks. Do not expose production login until validation passes.

## Limits and recovery

- Identity lock: 5 failures in 15 minutes, then exponential delay (1m, 2m, 4m, capped 60m), automatically expired.
- Source/IP lock: failures are counted across usernames. At 10 failures in 15 minutes, the source enters exponential delay (1m, 2m, 4m, capped 60m) before identity checks continue. This protects a representative account from one source rotating usernames.
- Recovery is append-only and representative-approved:
  `DATABASE_URL=... ALLOW_PRODUCTION_LOGIN_UNLOCK=1 node scripts/unlock-login-guard.mjs --username NAME --remote-address IP --reason 'approved recovery'`
- `scripts/validate-compose-security.mjs` must pass before deployment approval.
