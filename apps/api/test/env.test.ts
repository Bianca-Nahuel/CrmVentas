// Validación de la configuración de la API (sin base de datos).
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

const BASE = {
  DATABASE_URL: 'postgres://app:x@localhost:5432/ventas',
  DATABASE_URL_AUTH: 'postgres://auth:x@localhost:5432/ventas',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
  TRUSTED_ORIGINS: 'http://localhost:4200',
  WAHA_BASE_URL: 'http://localhost:3001',
  WAHA_API_KEY: 'clave-de-prueba',
  WAHA_WEBHOOK_URL: 'http://host.docker.internal:3000/api/webhooks/waha',
  WAHA_WEBHOOK_HMAC_KEY: 'k'.repeat(32),
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

  it('rechaza una clave HMAC de WAHA de menos de 32 bytes, sin mostrarla', () => {
    let message = '';
    try {
      parseEnv({ ...BASE, WAHA_WEBHOOK_HMAC_KEY: 'clave-corta-secreta' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('WAHA_WEBHOOK_HMAC_KEY');
    expect(message).not.toContain('clave-corta-secreta');
    expect(() => parseEnv({ ...BASE, WAHA_WEBHOOK_HMAC_KEY: undefined })).toThrow(/WAHA_WEBHOOK_HMAC_KEY/);
  });

  it('rechaza un WAHA_WEBHOOK_URL que no apunta a /api/webhooks/waha', () => {
    for (const url of [
      'http://host.docker.internal:3000/webhooks/waha',
      'http://host.docker.internal:3000/api/webhooks/waha/',
      'http://host.docker.internal:3000/',
    ]) {
      expect(() => parseEnv({ ...BASE, WAHA_WEBHOOK_URL: url })).toThrow(/WAHA_WEBHOOK_URL/);
    }
  });

  it('una URL mal formada da error de validación con el nombre, nunca el valor', () => {
    for (const name of ['WAHA_WEBHOOK_URL', 'WAHA_BASE_URL', 'BETTER_AUTH_URL', 'TRUSTED_ORIGINS']) {
      let message = '';
      try {
        parseEnv({ ...BASE, [name]: 'valor-mal-formado-xyz' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/^Configuración inválida/);
      expect(message).toContain(name);
      expect(message).not.toContain('valor-mal-formado-xyz');
    }
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

  describe('IA (tarea 006)', () => {
    const KEY = 'sk-or-v1-clave-de-prueba-0123456789';

    it('por defecto la IA está apagada, sin clave y con el modelo por defecto', () => {
      const env = parseEnv({ ...BASE });
      expect(env.AI_ENABLED).toBe(false);
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(env.AI_DEFAULT_MODEL).toBe('deepseek/deepseek-v4.1-flash');
    });

    it('una clave vacía (línea del .env.example sin completar) cuenta como no definida', () => {
      expect(parseEnv({ ...BASE, OPENROUTER_API_KEY: '' }).OPENROUTER_API_KEY).toBeUndefined();
    });

    it('con AI_ENABLED=true la clave es obligatoria', () => {
      expect(() => parseEnv({ ...BASE, AI_ENABLED: 'true' })).toThrow(/OPENROUTER_API_KEY/);
      expect(parseEnv({ ...BASE, AI_ENABLED: 'true', OPENROUTER_API_KEY: KEY }).AI_ENABLED).toBe(true);
    });

    it('rechaza una clave con otro formato sin mostrarla, y un modelo fuera de la lista', () => {
      let message = '';
      try {
        parseEnv({ ...BASE, OPENROUTER_API_KEY: 'sk-ant-secreta-123' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('OPENROUTER_API_KEY');
      expect(message).not.toContain('sk-ant-secreta-123');
      expect(() => parseEnv({ ...BASE, AI_DEFAULT_MODEL: 'openai/inventado' })).toThrow(/AI_DEFAULT_MODEL/);
      expect(() => parseEnv({ ...BASE, AI_ENABLED: 'si' })).toThrow(/AI_ENABLED/);
    });
  });
});
