export interface ApiEnv {
  databaseUrl: string;
  port: number;
  isProduction: boolean;
}

export function loadApiEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return {
    databaseUrl,
    port: Number(env.API_PORT ?? '3081'),
    isProduction: env.NODE_ENV === 'production'
  };
}
