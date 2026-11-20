import { validateTrustedProxyCidrs } from './login-guard.js';

export interface ApiEnv {
  databaseUrl: string;
  port: number;
  host: string;
  allowedOrigins: readonly string[];
  trustedProxyCidrs: readonly string[];
  /** True only when the API expects a web relay and trusts its explicit CIDRs. */
  trustedProxyConfigured: boolean;
  isProduction: boolean;
  /** P0 R04: login answer deadline (LOGIN_TIMEOUT_MS, default 15000). */
  loginTimeoutMs: number;
}


/**
 * Production is fail-closed: an operator must explicitly name the trusted web
 * relay network. A silent loopback fallback could count an entire shared
 * relay as one source and lock unrelated accounts.
 */
export function loadApiEnv(
  env: Record<string, string | undefined> = process.env
): ApiEnv {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const isProduction = env.NODE_ENV === 'production';
  const configuredCidrs = (env.TRUSTED_PROXY_CIDRS ?? '')
    .split(',')
    .map((cidr) => cidr.trim())
    .filter(Boolean);
  const cidrErrors = validateTrustedProxyCidrs(configuredCidrs);
  if (cidrErrors.length > 0) throw new Error(`Invalid TRUSTED_PROXY_CIDRS: ${cidrErrors.join('; ')}`);
  if (isProduction && configuredCidrs.length === 0) {
    throw new Error('TRUSTED_PROXY_CIDRS is required when NODE_ENV=production');
  }
  return {
    databaseUrl,
    port: Number(env.API_PORT ?? '3081'),
    host: env.API_HOST ?? '127.0.0.1',
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    trustedProxyCidrs: configuredCidrs.length > 0
      ? configuredCidrs
      : ['127.0.0.1/32', '::1/128'],
    trustedProxyConfigured: configuredCidrs.length > 0,
    isProduction,
    loginTimeoutMs: Number.isInteger(Number(env.LOGIN_TIMEOUT_MS)) && Number(env.LOGIN_TIMEOUT_MS) > 0
      ? Number(env.LOGIN_TIMEOUT_MS)
      : 15_000
  };
}