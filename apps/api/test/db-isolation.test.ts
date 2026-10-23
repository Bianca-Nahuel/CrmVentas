// Verificación 7 y 8 de la tarea 002: aislamiento por usuario de base y RLS.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  asApp,
  createTenant,
  createUser,
  pgErrorCode,
  startTestContext,
  TEST_PASSWORD,
  type TestContext,
} from './helpers.js';

const PERMISSION_DENIED = '42501';

let ctx: TestContext;
const ids = {} as Record<'ownerA' | 'ownerB' | 'multi' | 'tenantA' | 'tenantB', string>;

beforeAll(async () => {
  ctx = await startTestContext();
  ids.ownerA = (await createUser(ctx, 'iso-owner-a')).id;
  ids.ownerB = (await createUser(ctx, 'iso-owner-b')).id;
  ids.multi = (await createUser(ctx, 'iso-multi')).id;
  ids.tenantA = await createTenant(ctx, 'iso-a', ids.ownerA);
  ids.tenantB = await createTenant(ctx, 'iso-b', ids.ownerB);
  await addMember(ctx, ids.tenantA, ids.multi, 'seller');
  await addMember(ctx, ids.tenantB, ids.multi, 'viewer');
});

afterAll(async () => {
  await ctx?.close();
});

const idsOf = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe('roles de conexión', () => {
  it('cada pool se conecta con su usuario', async () => {
    expect((await ctx.pools.appPool.query('SELECT current_user AS u')).rows[0].u).toBe('ventas_app');
    expect((await ctx.pools.authPool.query('SELECT current_user AS u')).rows[0].u).toBe('ventas_auth');
  });

  it('las contraseñas se guardan hasheadas (scrypt salt:hash)', async () => {
    const { rows } = await ctx.ownerPool.query<{ password: string }>(
      "SELECT a.password FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.id = $1 AND a.provider_id = 'credential'",
      [ids.ownerA],
    );
    expect(rows[0]!.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(rows[0]!.password).not.toContain(TEST_PASSWORD);
  });
});

describe('ventas_app', () => {
  it.each(['accounts', 'sessions', 'verifications'])('no puede leer %s', async (table) => {
    expect(await pgErrorCode(ctx.pools.appPool.query(`SELECT * FROM ${table} LIMIT 1`))).toBe(
      PERMISSION_DENIED,
    );
  });

  it('en users solo puede leer id, name, email e image', async () => {
    expect(await pgErrorCode(ctx.pools.appPool.query('SELECT role FROM users LIMIT 1'))).toBe(
      PERMISSION_DENIED,
    );
    expect(await pgErrorCode(ctx.pools.appPool.query('SELECT * FROM users LIMIT 1'))).toBe(PERMISSION_DENIED);
  });

  it('no puede crear ni alterar tablas', async () => {
    expect(await pgErrorCode(ctx.pools.appPool.query('ALTER TABLE tenants ADD COLUMN x int'))).toBe(
      PERMISSION_DENIED,
    );
    expect(await pgErrorCode(ctx.pools.appPool.query('CREATE TABLE x_probe (id int)'))).toBe(
      PERMISSION_DENIED,
    );
  });

  it('sin app.user_id ve 0 filas', async () => {
    await asApp(ctx, {}, async (c) => {
      expect((await c.query('SELECT id FROM tenants')).rowCount).toBe(0);
      expect((await c.query('SELECT id FROM memberships')).rowCount).toBe(0);
      expect((await c.query('SELECT id FROM users')).rowCount).toBe(0);
      expect((await c.query('SELECT id FROM invitations')).rowCount).toBe(0);
    });
  });

  it('el owner de A solo ve la empresa A, sus membresías y sus compañeros', async () => {
    await asApp(ctx, { userId: ids.ownerA }, async (c) => {
      expect(idsOf((await c.query('SELECT id FROM tenants')).rows)).toEqual([ids.tenantA]);
      const own = await c.query('SELECT tenant_id, user_id FROM memberships');
      expect(own.rows).toEqual([{ tenant_id: ids.tenantA, user_id: ids.ownerA }]);
      expect(idsOf((await c.query('SELECT id FROM users')).rows)).toEqual([ids.ownerA, ids.multi].sort());
    });
    // Con la empresa activa seteada ve todas las membresías de A, ninguna de B.
    await asApp(ctx, { userId: ids.ownerA, tenantId: ids.tenantA }, async (c) => {
      const { rows } = await c.query<{ tenant_id: string }>('SELECT tenant_id FROM memberships');
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.tenant_id === ids.tenantA)).toBe(true);
    });
  });

  it('el usuario de las dos empresas ve las dos', async () => {
    await asApp(ctx, { userId: ids.multi }, async (c) => {
      expect(idsOf((await c.query('SELECT id FROM tenants')).rows)).toEqual(
        [ids.tenantA, ids.tenantB].sort(),
      );
      expect(idsOf((await c.query('SELECT id FROM users')).rows)).toEqual(
        [ids.ownerA, ids.ownerB, ids.multi].sort(),
      );
    });
  });

  it('no puede modificar otra empresa ni membresías de otra empresa', async () => {
    await asApp(ctx, { userId: ids.ownerA, tenantId: ids.tenantA }, async (c) => {
      expect((await c.query("UPDATE tenants SET name = 'x' WHERE id = $1", [ids.tenantB])).rowCount).toBe(0);
      expect(
        (await c.query("UPDATE memberships SET role = 'viewer' WHERE tenant_id = $1", [ids.tenantB]))
          .rowCount,
      ).toBe(0);
      expect(
        await pgErrorCode(c.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [ids.tenantA])),
      ).toBe(PERMISSION_DENIED);
    });
  });

  it('una membresía desactivada deja de dar acceso a la empresa', async () => {
    await ctx.ownerPool.query(
      "UPDATE memberships SET status = 'disabled' WHERE tenant_id = $1 AND user_id = $2",
      [ids.tenantB, ids.multi],
    );
    try {
      await asApp(ctx, { userId: ids.multi }, async (c) => {
        expect(idsOf((await c.query('SELECT id FROM tenants')).rows)).toEqual([ids.tenantA]);
      });
    } finally {
      await ctx.ownerPool.query(
        "UPDATE memberships SET status = 'active' WHERE tenant_id = $1 AND user_id = $2",
        [ids.tenantB, ids.multi],
      );
    }
  });
});

describe('ventas_auth', () => {
  it('no puede crear tablas', async () => {
    expect(await pgErrorCode(ctx.pools.authPool.query('CREATE TABLE x_probe (id int)'))).toBe(
      PERMISSION_DENIED,
    );
  });

  it('no tiene acceso a tablas de negocio', async () => {
    // Una tabla nueva creada por el dueño, como las de la tarea 003.
    const table = `${ctx.prefix}_business_probe`;
    await ctx.ownerPool.query(`CREATE TABLE ${table} (id int)`);
    try {
      expect(await pgErrorCode(ctx.pools.authPool.query(`SELECT * FROM ${table}`))).toBe(PERMISSION_DENIED);
      expect(await pgErrorCode(ctx.pools.authPool.query(`INSERT INTO ${table} VALUES (1)`))).toBe(
        PERMISSION_DENIED,
      );
    } finally {
      await ctx.ownerPool.query(`DROP TABLE ${table}`);
    }
  });

  it('no tiene acceso al historial de migraciones', async () => {
    expect(await pgErrorCode(ctx.pools.authPool.query('SELECT * FROM drizzle.__drizzle_migrations'))).toBe(
      PERMISSION_DENIED,
    );
  });
});
