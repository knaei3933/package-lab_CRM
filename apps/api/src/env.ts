export interface ApiEnv {
  databaseUrl: string;
  port: number;
  host: string;
  allowedOrigins: readonly string[];
  trustedProxyCidrs: readonly string[];
  isProduction: boolean;
}

export function loadApiEnv(
  env: Record<string, string | undefined> = process.env
): ApiEnv {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return {
    databaseUrl,
    port: Number(env.API_PORT ?? '3081'),
    host: env.API_HOST ?? '127.0.0.1',
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    trustedProxyCidrs: (env.TRUSTED_PROXY_CIDRS ?? '127.0.0.1/32,::1/128')
      .split(',')
      .map((cidr) => cidr.trim())
      .filter(Boolean),
    isProduction: env.NODE_ENV === 'production'
  };
}
