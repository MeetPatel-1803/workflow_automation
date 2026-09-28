import { validateEnv } from './env.validation';

/** Typed, nested view over the validated environment. */
export interface AppConfig {
  nodeEnv: string;
  port: number;
  trustProxy?: number;
  database: { url: string };
  redis: { host: string; port: number; db: number };
  jwt: { secret: string; expiresIn: string };
}

/**
 * ConfigModule `load` factory. Re-runs the env validator so coercions and
 * defaults (PORT -> number, JWT_EXPIRES_IN -> "1h") are reflected here.
 */
export const configuration = (): AppConfig => {
  const env = validateEnv(process.env);
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    trustProxy: env.TRUST_PROXY,
    database: { url: env.DATABASE_URL },
    redis: { host: env.REDIS_HOST, port: env.REDIS_PORT, db: env.REDIS_DB },
    jwt: { secret: env.JWT_SECRET, expiresIn: env.JWT_EXPIRES_IN },
  };
};
