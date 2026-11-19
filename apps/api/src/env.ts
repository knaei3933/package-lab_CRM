export interface ApiEnv {
  databaseUrl: string;
  port: number;
  host: string;
  allowedOrigins: readonly string[];
  trustProxy: boolean;
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
    trustProxy: env.TRUST_PROXY === '1',
    isProduction: env.NODE_ENV === 'production'
  };
}
