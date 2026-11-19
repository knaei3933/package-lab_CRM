#!/usr/bin/env node
// Static production-profile guard: fail before deployment if the web relay is
// disabled or the API would trust a public XFF peer.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const composeFile = process.env.COMPOSE_FILE ?? 'docker-compose.prod.yml';
const environment = {
  ...process.env,
  POSTGRES_PASSWORD: 'compose-validation-only-not-production',
  PROD_DATABASE_URL: 'compose-validation-database-url-injected-outside-the-repository',
  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN ?? 'https://crm.example.invalid',
  HTTP_BIND: process.env.HTTP_BIND ?? '127.0.0.1',
  HTTPS_BIND: process.env.HTTP_BIND ?? '127.0.0.1',
  TRUSTED_PROXY_CIDRS: process.env.TRUSTED_PROXY_CIDRS ?? '127.0.0.1/32,::1/128,172.28.28.0/24'
};
const result = spawnSync('docker', ['compose', '--profile', 'production', '-f', composeFile, 'config', '--format', 'json'], {
  env: environment,
  encoding: 'utf8',
  maxBuffer: 1024 * 1024 * 16
});
if (result.status !== 0) {
  console.error(result.stderr || result.stdout);
  process.exit(2);
}
const evidence = process.env.COMPOSE_VALIDATION_EVIDENCE ?? '/tmp/kanei-compose-security-validation.json';
writeFileSync(evidence, `${JSON.stringify({ generatedAt: new Date().toISOString(), composeFile }, null, 2)}\n`);
let config;
try {
  config = JSON.parse(result.stdout);
} catch (error) {
  console.error(`compose config was not JSON: ${error.message}`);
  process.exit(2);
}
const services = config.services ?? {};
const web = services.web;
const api = services.api;
const errors = [];
if (web?.environment?.KANEI_WEB_BEHIND_TRUSTED_PROXY !== '1') {
  errors.push('web KANEI_WEB_BEHIND_TRUSTED_PROXY must be exactly "1"');
}
if (!api?.environment?.TRUSTED_PROXY_CIDRS || String(api.environment.TRUSTED_PROXY_CIDRS).trim().length === 0) {
  errors.push('api TRUSTED_PROXY_CIDRS must be non-empty');
}
for (const cidr of String(api.environment.TRUSTED_PROXY_CIDRS ?? '').split(',')) {
  const [network, prefix] = cidr.trim().split('/');
  const bits = network?.includes(':') ? 128 : 32;
  if (!network || prefix === undefined || !/^[1-9][0-9]*$/.test(prefix)
    || Number(prefix) > bits) {
    errors.push(`invalid api TRUSTED_PROXY_CIDRS entry: ${cidr}`);
  }
}
const published = [];
for (const service of Object.entries(services)) {
  for (const port of service[1].ports ?? []) {
    const mapping = typeof port === 'string' ? port : `${port.host_ip ?? ''}:${port.published ?? ''}:${port.target ?? ''}`;
    published.push([service[0], mapping, port]);
    if (service[0] === 'web') errors.push(`web must not publish ports: ${mapping}`);
    if (service[0] === 'api') errors.push(`api must not publish ports: ${mapping}`);
  }
}
if (errors.length) {
  console.error(JSON.stringify({ ok: false, errors, published }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, webBehindTrustedProxy: web.environment.KANEI_WEB_BEHIND_TRUSTED_PROXY, trustedProxyCidrs: api.environment.TRUSTED_PROXY_CIDRS, published }, null, 2));
