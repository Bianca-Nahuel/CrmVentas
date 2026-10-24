// Utilidades de los tests e2e. Corren contra el Postgres local con datos propios (prefijo único por
// corrida) que se borran al final con el usuario dueño.
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import pg from 'pg';
import { createAuth, type Auth } from '../src/auth/auth.js';
import { createApp } from '../src/bootstrap.js';
import { parseEnv, type Env } from '../src/config/env.js';
import { createAppDatabase, createAuthDatabase } from '../src/db/pools.js';

interface TestPools {
  appPool: pg.Pool;
  authPool: pg.Pool;
  close(): Promise<void>;
}

export const TEST_PASSWORD = 'test-only-Password-123';

export interface TestContext {
  env: Env;
  app: NestExpressApplication;
  baseUrl: string;
  auth: Auth;
  pools: TestPools;
  ownerPool: pg.Pool;
  prefix: string;
  close(): Promise<void>;
}

export async function startTestContext(): Promise<TestContext> {
  // La API no conoce las credenciales del dueño; solo los tests las usan para limpiar.
  const ownerUrl = process.env.DATABASE_URL_MIGRATIONS;
  if (!ownerUrl) throw new Error('Los tests necesitan DATABASE_URL_MIGRATIONS (limpieza como ventas_owner)');
  const env = parseEnv();
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  const appDatabase = createAppDatabase(env.DATABASE_URL);
  const authDatabase = createAuthDatabase(env.DATABASE_URL_AUTH);
  const pools: TestPools = {
    appPool: appDatabase.pool,
    authPool: authDatabase.pool,
    close: async () => {
      await Promise.all([appDatabase.close(), authDatabase.close()]);
    },
  };
  const ownerPool = new pg.Pool({ connectionString: ownerUrl, max: 2 });
  const prefix = `t${randomBytes(4).toString('hex')}`;

  return {
    env,
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    auth: createAuth(env, authDatabase.db),
    pools,
    ownerPool,
    prefix,
    async close() {
      // Borra los datos de esta corrida (las FK en cascada se llevan sesiones, cuentas y membresías).
      await ownerPool.query('DELETE FROM tenants WHERE slug LIKE $1', [`${prefix}-%`]);
      await ownerPool.query('DELETE FROM users WHERE email LIKE $1', [`${prefix}-%`]);
      await app.close();
      await pools.close();
      await ownerPool.end();
    },
  };
}

/** Cliente HTTP con cookies, como un navegador del mismo origen. */
export class HttpClient {
  cookies = new Map<string, string>();
  lastSetCookie: string[] = [];

  constructor(private readonly ctx: TestContext) {}

  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async request(method: string, path: string, body?: unknown, cookieOverride?: string) {
    const headers: Record<string, string> = { Origin: this.ctx.env.BETTER_AUTH_URL };
    const cookie = cookieOverride ?? this.cookieHeader();
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${this.ctx.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.lastSetCookie = response.headers.getSetCookie();
    for (const raw of this.lastSetCookie) {
      const [pair] = raw.split(';');
      const index = pair!.indexOf('=');
      const name = pair!.slice(0, index);
      const value = pair!.slice(index + 1);
      if (value === '' || /max-age=0/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: response.status, body: json as Record<string, unknown> | undefined };
  }

  get(path: string) {
    return this.request('GET', path);
  }

  post(path: string, body: unknown = {}) {
    return this.request('POST', path, body);
  }

  async signIn(email: string) {
    return this.post('/api/auth/sign-in/email', { email, password: TEST_PASSWORD });
  }
}

export async function createUser(ctx: TestContext, label: string): Promise<{ id: string; email: string }> {
  const email = `${ctx.prefix}-${label}@example.test`;
  const result = await ctx.auth.api.signUpEmail({ body: { email, name: label, password: TEST_PASSWORD } });
  return { id: result.user.id, email };
}

export async function createTenant(ctx: TestContext, label: string, ownerId: string): Promise<string> {
  const created = await ctx.auth.api.createOrganization({
    body: {
      name: `Test ${label}`,
      slug: `${ctx.prefix}-${label}`,
      industry: 'test',
      timezone: 'America/Argentina/Buenos_Aires',
      userId: ownerId,
    },
  });
  if (!created) throw new Error('No se pudo crear la empresa de prueba');
  return created.id;
}

export async function addMember(ctx: TestContext, tenantId: string, userId: string, role: string) {
  await ctx.auth.api.addMember({ body: { organizationId: tenantId, userId, role: role as 'seller' } });
}

/** Corre consultas como ventas_app dentro de una transacción con el contexto dado (o sin contexto). */
export async function asApp<T>(
  ctx: TestContext,
  context: { userId?: string; tenantId?: string },
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ctx.pools.appPool.connect();
  try {
    await client.query('BEGIN');
    if (context.userId) await client.query("SELECT set_config('app.user_id', $1, true)", [context.userId]);
    if (context.tenantId)
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [context.tenantId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** Como asApp con una empresa activa, pero hace COMMIT: para preparar datos pasando por la RLS. */
export async function withTenant<T>(
  ctx: TestContext,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ctx.pools.appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Código de error de una consulta dentro de una transacción abierta. Usa un SAVEPOINT para que el error
 * no aborte la transacción y se puedan seguir probando cosas con el mismo contexto.
 */
export async function errorCodeIn(
  client: pg.PoolClient,
  text: string,
  params: unknown[] = [],
): Promise<string | undefined> {
  await client.query('SAVEPOINT probe');
  try {
    await client.query(text, params);
    await client.query('RELEASE SAVEPOINT probe');
    return undefined;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT probe');
    return (error as { code?: string }).code;
  }
}

/** Devuelve el código de error de Postgres (42501 = permission denied). */
export async function pgErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}
