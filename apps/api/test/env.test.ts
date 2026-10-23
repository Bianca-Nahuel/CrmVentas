// Validación de la configuración de la API (sin base de datos).
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

const BASE = {
  DATABASE_URL: 'postgres://app:x@localhost:5432/ventas',
  DATABASE_URL_AUTH: 'postgres://auth:x@localhost:5432/ventas',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
  TRUSTED_ORIGINS: 'http://localhost:4200',
};
const OWNER_URL = 'postgres://ventas_owner:secreto-de-prueba@localhost:5432/ventas';

describe('parseEnv', () => {
  it('arranca sin DATABASE_URL_MIGRATIONS', () => {
    expect(() => parseEnv({ ...BASE })).not.toThrow();
    expect(() => parseEnv({ ...BASE, NODE_ENV: 'production' })).not.toThrow();
  });

  it('la ignora fuera de producción', () => {
    const env = parseEnv({ ...BASE, NODE_ENV: 'development', DATABASE_URL_MIGRATIONS: OWNER_URL });
    expect(env).not.toHaveProperty('DATABASE_URL_MIGRATIONS');
    expect(() => parseEnv({ ...BASE, NODE_ENV: 'test', DATABASE_URL_MIGRATIONS: OWNER_URL })).not.toThrow();
  });

  it('no arranca en producción si la recibe, sin mostrar el valor', () => {
    let message = '';
    try {
      parseEnv({ ...BASE, NODE_ENV: 'production', DATABASE_URL_MIGRATIONS: OWNER_URL });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('DATABASE_URL_MIGRATIONS');
    expect(message).not.toContain('secreto-de-prueba');
    // Basta con que esté declarada, aunque venga vacía.
    expect(() => parseEnv({ ...BASE, NODE_ENV: 'production', DATABASE_URL_MIGRATIONS: '' })).toThrow(
      /DATABASE_URL_MIGRATIONS/,
    );
  });
});
