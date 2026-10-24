// Verificación 2 a 10 de la tarea 003: tablas de mensajería, RLS, grants, FKs compuestas,
// idempotencia y resolve_channel. Los números son ficticios.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  asApp,
  createTenant,
  createUser,
  errorCodeIn,
  pgErrorCode,
  startTestContext,
  withTenant,
  type TestContext,
} from './helpers.js';

const PERMISSION_DENIED = '42501'; // también es el código de una fila rechazada por la RLS
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

const TABLES = ['channels', 'contacts', 'conversations', 'messages'] as const;

interface TenantData {
  tenantId: string;
  ownerId: string;
  channelId: string;
  channelExternalId: string;
  contactId: string;
  conversationId: string;
  messageIds: string[];
}

let ctx: TestContext;
let a: TenantData;
let b: TenantData;
let sellerA: string;

async function insertId(client: pg.PoolClient, text: string, params: unknown[]): Promise<string> {
  const { rows } = await client.query<{ id: string }>(`${text} RETURNING id`, params);
  return rows[0]!.id;
}

// Punto 2: un canal, un contacto, una conversación y dos mensajes por empresa, insertados como
// ventas_app con la empresa activa (o sea, pasando por la RLS).
async function seedTenant(label: string): Promise<TenantData> {
  const ownerId = (await createUser(ctx, `msg-owner-${label}`)).id;
  const tenantId = await createTenant(ctx, `msg-${label}`, ownerId);
  const channelExternalId = `${ctx.prefix}-waha-${label}`;
  return withTenant(ctx, tenantId, async (c) => {
    const channelId = await insertId(
      c,
      `INSERT INTO channels (tenant_id, name, phone_number, provider, connection_type, external_id,
         status, risk_accepted_at, risk_accepted_by)
       VALUES ($1, 'ventas-principal', '+5491100000000', 'waha', 'unofficial', $2, 'connected', now(), $3)`,
      [tenantId, channelExternalId, ownerId],
    );
    const contactId = await insertId(
      c,
      `INSERT INTO contacts (tenant_id, wa_id, profile_name, first_seen_at, last_seen_at)
       VALUES ($1, '+5491100000001', 'Cliente de prueba', now(), now())`,
      [tenantId],
    );
    const conversationId = await insertId(
      c,
      `INSERT INTO conversations (tenant_id, channel_id, contact_id, last_message_at, last_inbound_at)
       VALUES ($1, $2, $3, now(), now())`,
      [tenantId, channelId, contactId],
    );
    const messageIds = [
      await insertId(
        c,
        `INSERT INTO messages (tenant_id, conversation_id, channel_id, external_id, direction, sender_type,
           type, body, status, raw, sent_at)
         VALUES ($1, $2, $3, 'in-1', 'inbound', 'contact', 'text', 'hola', 'received', '{}', now())`,
        [tenantId, conversationId, channelId],
      ),
      await insertId(
        c,
        `INSERT INTO messages (tenant_id, conversation_id, channel_id, external_id, direction, sender_type,
           type, body, status, raw, sent_at)
         VALUES ($1, $2, $3, 'out-1', 'outbound', 'ai', 'text', 'buenas', 'sent', '{}', now())`,
        [tenantId, conversationId, channelId],
      ),
    ];
    return { tenantId, ownerId, channelId, channelExternalId, contactId, conversationId, messageIds };
  });
}

beforeAll(async () => {
  ctx = await startTestContext();
  a = await seedTenant('a');
  b = await seedTenant('b');
  sellerA = (await createUser(ctx, 'msg-seller-a')).id;
  await addMember(ctx, a.tenantId, sellerA, 'seller');
});

afterAll(async () => {
  // Borrar las empresas se lleva en cascada canales, contactos, conversaciones y mensajes.
  await ctx?.close();
});

const idsOf = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
const rowIdsOf = (data: TenantData, table: (typeof TABLES)[number]) =>
  ({
    channels: [data.channelId],
    contacts: [data.contactId],
    conversations: [data.conversationId],
    messages: [...data.messageIds].sort(),
  })[table];

describe('estructura y permisos', () => {
  it('las 4 tablas tienen RLS habilitada y forzada', async () => {
    const { rows } = await ctx.ownerPool.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1) ORDER BY relname`,
      [TABLES],
    );
    expect(rows).toEqual(
      [...TABLES].sort().map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })),
    );
  });

  it('ventas_app tiene exactamente los grants de la tarea y ventas_auth ninguno', async () => {
    const tableGrants = await ctx.ownerPool.query<{
      grantee: string;
      table_name: string;
      privilege_type: string;
    }>(
      `SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = ANY($1) AND grantee <> 'ventas_owner'
       ORDER BY grantee, table_name, privilege_type`,
      [TABLES],
    );
    expect(tableGrants.rows).toEqual(
      [...TABLES].sort().flatMap((table_name) =>
        ['INSERT', 'SELECT'].map((privilege_type) => ({
          grantee: 'ventas_app',
          table_name,
          privilege_type,
        })),
      ),
    );

    const updateColumns = await ctx.ownerPool.query<{
      grantee: string;
      table_name: string;
      column_name: string;
    }>(
      `SELECT grantee, table_name, column_name FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = ANY($1) AND privilege_type = 'UPDATE'
         AND grantee <> 'ventas_owner'
       ORDER BY table_name, column_name`,
      [TABLES],
    );
    const byTable = (table: string) =>
      updateColumns.rows
        .filter((r) => r.table_name === table && r.grantee === 'ventas_app')
        .map((r) => r.column_name);
    expect(updateColumns.rows.every((r) => r.grantee === 'ventas_app')).toBe(true);
    expect(byTable('messages')).toEqual(['cost_usd', 'status']);
    // channels, contacts y conversations: todo menos id, tenant_id, created_at y updated_at.
    for (const table of ['channels', 'contacts', 'conversations']) {
      const { rows } = await ctx.ownerPool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
           AND column_name NOT IN ('id', 'tenant_id', 'created_at', 'updated_at')
         ORDER BY column_name`,
        [table],
      );
      expect(byTable(table)).toEqual(rows.map((r) => r.column_name));
    }
  });

  it('ventas_app no puede alterar las tablas', async () => {
    for (const table of TABLES) {
      expect(await pgErrorCode(ctx.pools.appPool.query(`ALTER TABLE ${table} ADD COLUMN x int`))).toBe(
        PERMISSION_DENIED,
      );
    }
  });
});

describe('aislamiento entre empresas (ventas_app)', () => {
  it('los datos de prueba quedaron cargados en las dos empresas (punto 2)', async () => {
    for (const data of [a, b]) {
      const { rows } = await ctx.ownerPool.query(
        `SELECT (SELECT count(*) FROM channels WHERE tenant_id = $1)::int AS channels,
                (SELECT count(*) FROM contacts WHERE tenant_id = $1)::int AS contacts,
                (SELECT count(*) FROM conversations WHERE tenant_id = $1)::int AS conversations,
                (SELECT count(*) FROM messages WHERE tenant_id = $1)::int AS messages`,
        [data.tenantId],
      );
      expect(rows[0]).toEqual({ channels: 1, contacts: 1, conversations: 1, messages: 2 });
    }
  });

  it.each(TABLES)('sin app.tenant_id, %s devuelve 0 filas (punto 3)', async (table) => {
    await asApp(ctx, {}, async (c) => {
      expect((await c.query(`SELECT id FROM ${table}`)).rowCount).toBe(0);
    });
    // Un usuario con sesión pero sin empresa activa tampoco ve nada.
    await asApp(ctx, { userId: a.ownerId }, async (c) => {
      expect((await c.query(`SELECT id FROM ${table}`)).rowCount).toBe(0);
    });
  });

  it.each(TABLES)('con la empresa A, %s muestra solo filas de A (punto 4)', async (table) => {
    await asApp(ctx, { userId: a.ownerId, tenantId: a.tenantId }, async (c) => {
      expect(idsOf((await c.query(`SELECT id FROM ${table}`)).rows)).toEqual(rowIdsOf(a, table));
    });
  });

  it('un UPDATE sobre filas de B afecta 0 filas (punto 4)', async () => {
    await asApp(ctx, { userId: a.ownerId, tenantId: a.tenantId }, async (c) => {
      const updates: [string, string][] = [
        ["UPDATE channels SET name = 'x' WHERE id = $1", b.channelId],
        ["UPDATE contacts SET display_name = 'x' WHERE id = $1", b.contactId],
        ["UPDATE conversations SET status = 'closed' WHERE id = $1", b.conversationId],
        ["UPDATE messages SET status = 'read' WHERE id = $1", b.messageIds[0]!],
      ];
      for (const [text, id] of updates) expect((await c.query(text, [id])).rowCount).toBe(0);
    });
  });

  it('un INSERT con el tenant_id de B falla (punto 4)', async () => {
    await asApp(ctx, { userId: a.ownerId, tenantId: a.tenantId }, async (c) => {
      expect(
        await errorCodeIn(
          c,
          `INSERT INTO channels (tenant_id, name, phone_number, provider, connection_type)
           VALUES ($1, 'x', '+5491100000099', 'cloud_api', 'official')`,
          [b.tenantId],
        ),
      ).toBe(PERMISSION_DENIED);
      expect(
        await errorCodeIn(
          c,
          `INSERT INTO contacts (tenant_id, wa_id, first_seen_at, last_seen_at)
           VALUES ($1, '+5491100000099', now(), now())`,
          [b.tenantId],
        ),
      ).toBe(PERMISSION_DENIED);
      expect(
        await errorCodeIn(
          c,
          `INSERT INTO conversations (tenant_id, channel_id, contact_id, status, last_message_at)
           VALUES ($1, $2, $3, 'closed', now())`,
          [b.tenantId, b.channelId, b.contactId],
        ),
      ).toBe(PERMISSION_DENIED);
      expect(
        await errorCodeIn(
          c,
          `INSERT INTO messages (tenant_id, conversation_id, channel_id, external_id, direction, sender_type,
             type, raw, sent_at)
           VALUES ($1, $2, $3, 'x-1', 'inbound', 'contact', 'text', '{}', now())`,
          [b.tenantId, b.conversationId, b.channelId],
        ),
      ).toBe(PERMISSION_DENIED);
    });
  });
});

describe('FKs compuestas (punto 5)', () => {
  it('una conversación no puede mezclar canal de A con contacto de B', async () => {
    await asApp(ctx, { userId: a.ownerId, tenantId: a.tenantId }, async (c) => {
      expect(
        await errorCodeIn(
          c,
          `INSERT INTO conversations (tenant_id, channel_id, contact_id, status, last_message_at)
           VALUES ($1, $2, $3, 'closed', now())`,
          [a.tenantId, a.channelId, b.contactId],
        ),
      ).toBe(FOREIGN_KEY_VIOLATION);
    });
    // También como dueño (sin RLS): lo frena la FK, no la RLS.
    expect(
      await pgErrorCode(
        ctx.ownerPool.query(
          `INSERT INTO conversations (tenant_id, channel_id, contact_id, status, last_message_at)
           VALUES ($1, $2, $3, 'closed', now())`,
          [a.tenantId, a.channelId, b.contactId],
        ),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('un mensaje no puede usar un canal de otra empresa', async () => {
    await asApp(ctx, { userId: a.ownerId, tenantId: a.tenantId }, async (c) => {
      expect(
        await errorCodeIn(
          c,
          `INSERT INTO messages (tenant_id, conversation_id, channel_id, external_id, direction, sender_type,
             type, raw, sent_at)
           VALUES ($1, $2, $3, 'x-2', 'inbound', 'contact', 'text', '{}', now())`,
          [a.tenantId, a.conversationId, b.channelId],
        ),
      ).toBe(FOREIGN_KEY_VIOLATION);
    });
  });

  it('un mensaje tiene que ir por el mismo canal que su conversación', async () => {
    await asApp(ctx, { userId: a.ownerId, tenantId: a.tenantId }, async (c) => {
      const otherChannel = await insertId(
        c,
        `INSERT INTO channels (tenant_id, name, phone_number, provider, connection_type)
         VALUES ($1, 'otro', '+5491100000098', 'cloud_api', 'official')`,
        [a.tenantId],
      );
      expect(
        await errorCodeIn(
          c,
          `INSERT INTO messages (tenant_id, conversation_id, channel_id, external_id, direction, sender_type,
             type, raw, sent_at)
           VALUES ($1, $2, $3, 'x-3', 'inbound', 'contact', 'text', '{}', now())`,
          [a.tenantId, a.conversationId, otherChannel],
        ),
      ).toBe(FOREIGN_KEY_VIOLATION);
    });
  });

  it('solo se puede asignar a usuarios de la misma empresa', async () => {
    await asApp(ctx, { userId: a.ownerId, tenantId: a.tenantId }, async (c) => {
      expect(
        await errorCodeIn(c, 'UPDATE conversations SET assigned_user_id = $1 WHERE id = $2', [
          b.ownerId,
          a.conversationId,
        ]),
      ).toBe(FOREIGN_KEY_VIOLATION);
      expect(
        await errorCodeIn(c, 'UPDATE channels SET default_user_id = $1 WHERE id = $2', [
          b.ownerId,
          a.channelId,
        ]),
      ).toBe(FOREIGN_KEY_VIOLATION);
      expect(
        await errorCodeIn(
          c,
          `INSERT INTO messages (tenant_id, conversation_id, channel_id, external_id, direction, sender_type,
             sent_by_user_id, type, raw, sent_at)
           VALUES ($1, $2, $3, 'x-5', 'outbound', 'user', $4, 'text', '{}', now())`,
          [a.tenantId, a.conversationId, a.channelId, b.ownerId],
        ),
      ).toBe(FOREIGN_KEY_VIOLATION);
      expect(
        (
          await c.query('UPDATE conversations SET assigned_user_id = $1 WHERE id = $2', [
            sellerA,
            a.conversationId,
          ])
        ).rowCount,
      ).toBe(1);
    });
  });

  it('al quitar la membresía, la conversación queda sin asignar', async () => {
    const seller = (await createUser(ctx, 'msg-seller-a2')).id;
    await addMember(ctx, a.tenantId, seller, 'seller');
    await withTenant(ctx, a.tenantId, (c) =>
      c.query('UPDATE conversations SET assigned_user_id = $1 WHERE id = $2', [seller, a.conversationId]),
    );
    await ctx.ownerPool.query('DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2', [
      a.tenantId,
      seller,
    ]);
    const { rows } = await ctx.ownerPool.query(
      'SELECT tenant_id, assigned_user_id FROM conversations WHERE id = $1',
      [a.conversationId],
    );
    expect(rows[0]).toEqual({ tenant_id: a.tenantId, assigned_user_id: null });
  });
});

describe('restricciones', () => {
  it('idempotencia por (channel_id, external_id) (punto 6)', async () => {
    await asApp(ctx, { userId: a.ownerId, tenantId: a.tenantId }, async (c) => {
      const insert = `INSERT INTO messages (tenant_id, conversation_id, channel_id, external_id, direction,
          sender_type, type, body, raw, sent_at)
        VALUES ($1, $2, $3, 'in-1', 'inbound', 'contact', 'text', 'duplicado', '{}', now())`;
      const params = [a.tenantId, a.conversationId, a.channelId];
      expect(
        (await c.query(`${insert} ON CONFLICT (channel_id, external_id) DO NOTHING`, params)).rowCount,
      ).toBe(0);
      expect(await errorCodeIn(c, insert, params)).toBe(UNIQUE_VIOLATION);
      const { rows } = await c.query(
        "SELECT body FROM messages WHERE channel_id = $1 AND external_id = 'in-1'",
        [a.channelId],
      );
      expect(rows).toEqual([{ body: 'hola' }]);
    });
  });

  it('una sola conversación abierta por canal y contacto', async () => {
    await asApp(ctx, { userId: a.ownerId, tenantId: a.tenantId }, async (c) => {
      const insert = `INSERT INTO conversations (tenant_id, channel_id, contact_id, status, last_message_at)
        VALUES ($1, $2, $3, $4, now())`;
      expect(await errorCodeIn(c, insert, [a.tenantId, a.channelId, a.contactId, 'open'])).toBe(
        UNIQUE_VIOLATION,
      );
      expect(await errorCodeIn(c, insert, [a.tenantId, a.channelId, a.contactId, 'closed'])).toBeUndefined();
    });
  });

  it('CHECKs de valores y de coherencia (punto 10)', async () => {
    await asApp(ctx, { userId: a.ownerId, tenantId: a.tenantId }, async (c) => {
      const channel = (phone: string, provider: string, type: string, risk: boolean) =>
        errorCodeIn(
          c,
          `INSERT INTO channels (tenant_id, name, phone_number, provider, connection_type, risk_accepted_at,
             risk_accepted_by)
           VALUES ($1, 'x', $2, $3, $4, $5, $6)`,
          [a.tenantId, phone, provider, type, risk ? new Date() : null, risk ? a.ownerId : null],
        );
      // Canal no oficial sin aceptar el riesgo.
      expect(await channel('+5491100000097', 'waha', 'unofficial', false)).toBe(CHECK_VIOLATION);
      expect(await channel('5491100000097', 'cloud_api', 'official', false)).toBe(CHECK_VIOLATION);
      expect(await channel('+5491100000097', 'waha', 'official', false)).toBe(CHECK_VIOLATION);
      expect(await channel('+5491100000097', 'cloud_api', 'unofficial', true)).toBe(CHECK_VIOLATION);
      expect(await channel('+5491100000097', 'waha', 'unofficial', true)).toBeUndefined();
      expect(
        await errorCodeIn(
          c,
          `INSERT INTO channels (tenant_id, name, phone_number, provider, connection_type, provider_config)
           VALUES ($1, 'x', '+5491100000095', 'cloud_api', 'official', '[]')`,
          [a.tenantId],
        ),
      ).toBe(CHECK_VIOLATION);
      // El external_id es único por proveedor en toda la base, no por empresa: el de B no se puede repetir.
      expect(
        await errorCodeIn(
          c,
          `INSERT INTO channels (tenant_id, name, phone_number, provider, connection_type, external_id,
             risk_accepted_at, risk_accepted_by)
           VALUES ($1, 'x', '+5491100000094', 'waha', 'unofficial', $2, now(), $3)`,
          [a.tenantId, b.channelExternalId, a.ownerId],
        ),
      ).toBe(UNIQUE_VIOLATION);

      expect(
        await errorCodeIn(
          c,
          `INSERT INTO contacts (tenant_id, wa_id, marketing_opt_in, first_seen_at, last_seen_at)
           VALUES ($1, '+5491100000096', true, now(), now())`,
          [a.tenantId],
        ),
      ).toBe(CHECK_VIOLATION);
      expect(
        await errorCodeIn(
          c,
          `INSERT INTO messages (tenant_id, conversation_id, channel_id, external_id, direction, sender_type,
             type, raw, sent_at)
           VALUES ($1, $2, $3, 'x-4', 'inbound', 'ai', 'text', '{}', now())`,
          [a.tenantId, a.conversationId, a.channelId],
        ),
      ).toBe(CHECK_VIOLATION);
    });
  });

  it('updated_at se actualiza solo en cada UPDATE', async () => {
    const before = await ctx.ownerPool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM contacts WHERE id = $1',
      [a.contactId],
    );
    await withTenant(ctx, a.tenantId, (c) =>
      c.query("UPDATE contacts SET display_name = 'Corregido' WHERE id = $1", [a.contactId]),
    );
    const after = await ctx.ownerPool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM contacts WHERE id = $1',
      [a.contactId],
    );
    expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThan(before.rows[0]!.updated_at.getTime());
  });
});

describe('operaciones prohibidas', () => {
  it('ventas_app no puede borrar ni editar el contenido de un mensaje (punto 7)', async () => {
    await asApp(ctx, { userId: a.ownerId, tenantId: a.tenantId }, async (c) => {
      for (const table of TABLES)
        expect(await errorCodeIn(c, `DELETE FROM ${table}`)).toBe(PERMISSION_DENIED);
      expect(await errorCodeIn(c, "UPDATE messages SET body = 'x' WHERE id = $1", [a.messageIds[0]])).toBe(
        PERMISSION_DENIED,
      );
      expect(
        await errorCodeIn(c, 'UPDATE channels SET tenant_id = $1 WHERE id = $2', [b.tenantId, a.channelId]),
      ).toBe(PERMISSION_DENIED);
      expect(
        (await c.query("UPDATE messages SET status = 'read' WHERE id = $1", [a.messageIds[1]])).rowCount,
      ).toBe(1);
      expect(
        (await c.query('UPDATE messages SET cost_usd = 0.00512 WHERE id = $1', [a.messageIds[1]])).rowCount,
      ).toBe(1);
    });
  });

  it.each(TABLES)('ventas_auth no puede leer %s (punto 8)', async (table) => {
    expect(await pgErrorCode(ctx.pools.authPool.query(`SELECT * FROM ${table} LIMIT 1`))).toBe(
      PERMISSION_DENIED,
    );
  });

  it('ventas_auth no puede ejecutar resolve_channel (punto 8)', async () => {
    expect(
      await pgErrorCode(
        ctx.pools.authPool.query("SELECT * FROM resolve_channel('waha', $1)", [a.channelExternalId]),
      ),
    ).toBe(PERMISSION_DENIED);
  });
});

describe('resolve_channel (punto 9)', () => {
  const resolve = (provider: string, externalId: string) =>
    ctx.pools.appPool.query('SELECT * FROM resolve_channel($1, $2)', [provider, externalId]);

  it('sin contexto devuelve solo el canal y la empresa', async () => {
    const { rows } = await resolve('waha', a.channelExternalId);
    expect(rows).toEqual([{ channel_id: a.channelId, tenant_id: a.tenantId }]);
    expect((await resolve('waha', b.channelExternalId)).rows).toEqual([
      { channel_id: b.channelId, tenant_id: b.tenantId },
    ]);
  });

  it('con un external_id inexistente o de otro proveedor devuelve 0 filas', async () => {
    expect((await resolve('waha', `${ctx.prefix}-no-existe`)).rowCount).toBe(0);
    expect((await resolve('cloud_api', a.channelExternalId)).rowCount).toBe(0);
  });

  it('un canal banned no se resuelve', async () => {
    await ctx.ownerPool.query("UPDATE channels SET status = 'banned' WHERE id = $1", [a.channelId]);
    try {
      expect((await resolve('waha', a.channelExternalId)).rowCount).toBe(0);
    } finally {
      await ctx.ownerPool.query("UPDATE channels SET status = 'connected' WHERE id = $1", [a.channelId]);
    }
  });

  it('el canal de una empresa suspendida no se resuelve', async () => {
    await ctx.ownerPool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [a.tenantId]);
    try {
      expect((await resolve('waha', a.channelExternalId)).rowCount).toBe(0);
    } finally {
      await ctx.ownerPool.query("UPDATE tenants SET status = 'active' WHERE id = $1", [a.tenantId]);
    }
  });
});
