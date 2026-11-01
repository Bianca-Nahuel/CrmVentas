// Verificación de la tarea 014 contra el Postgres local: visibilidad por número (servicio y RLS), grilla,
// detalle, mensajes, reactivar la IA y asignación de números a vendedores. Números ficticios.
import { roleCan, TENANT_ROLES, type TenantConfigInput } from '@ventas/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantConfigService } from '../src/ai/config/tenant-config.service.js';
import { APP_DB, type AppDatabase } from '../src/db/database.module.js';
import { withTenantTransaction } from '../src/db/tenant-context.js';
import { testConfigInput } from './ai-helpers.js';
import {
  addMember,
  asApp,
  errorCodeIn,
  createTenant,
  createUser,
  HttpClient,
  startTestContext,
  withTenant,
  type TestContext,
} from './helpers.js';
import { fakePhone, uid } from './outbound-helpers.js';

let ctx: TestContext;
const configs = new TenantConfigService();

type UserKey = 'owner' | 'admin' | 'seller' | 'seller2' | 'viewer' | 'disabled' | 'ownerB' | 'sellerB';
const users = {} as Record<UserKey, { id: string; email: string }>;
let tenantA: string;
let tenantB: string;
// A1: asignado al seller; A2: no. B1: de otra empresa.
const channels = {} as Record<'A1' | 'A2' | 'B1', string>;
const convs = {} as Record<'hot' | 'handed' | 'html' | 'other' | 'b', string>;
const clients = {} as Record<UserKey, HttpClient>;
const HTML = '<img src=x onerror=alert(1)> y *negrita*';

async function createChannel(tenantId: string, ownerId: string, name: string) {
  return withTenant(ctx, tenantId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO channels (tenant_id, name, phone_number, provider, connection_type, external_id,
         status, risk_accepted_at, risk_accepted_by)
       VALUES ($1, $2, $3, 'waha', 'unofficial', $4, 'connected', now(), $5) RETURNING id`,
      [tenantId, name, `+${fakePhone()}`, `${ctx.prefix}_${uid()}`, ownerId],
    );
    return rows[0]!.id;
  });
}

async function createConversation(
  tenantId: string,
  channelId: string,
  options: {
    name: string;
    waId?: string;
    score?: number | null;
    tier?: string | null;
    handedOff?: boolean;
    messages?: { from: 'contact' | 'ai' | 'user'; text: string | null; type?: string }[];
  },
) {
  return withTenant(ctx, tenantId, async (c) => {
    const contact = await c.query<{ id: string }>(
      `INSERT INTO contacts (tenant_id, wa_id, profile_name, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, now(), now()) RETURNING id`,
      [tenantId, options.waId ?? `+${fakePhone()}`, options.name],
    );
    const conversation = await c.query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, channel_id, contact_id, last_message_at, last_inbound_at)
       VALUES ($1, $2, $3, clock_timestamp(), now()) RETURNING id`,
      [tenantId, channelId, contact.rows[0]!.id],
    );
    const id = conversation.rows[0]!.id;
    for (const message of options.messages ?? [{ from: 'contact', text: 'Hola' }]) {
      const inbound = message.from === 'contact';
      await c.query(
        `INSERT INTO messages (tenant_id, conversation_id, channel_id, external_id, direction, sender_type,
           type, body, media_key, status, raw, sent_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '{"secreto": "crudo"}'::jsonb, clock_timestamp())`,
        [
          tenantId,
          id,
          channelId,
          `${uid()}`,
          inbound ? 'inbound' : 'outbound',
          message.from,
          message.type ?? 'text',
          message.text,
          message.type && message.type !== 'text' ? 'r2/clave-secreta' : null,
          inbound ? 'received' : 'sent',
        ],
      );
    }
    await c.query('UPDATE conversations SET last_message_at = clock_timestamp() WHERE id = $1', [id]);
    return id;
  });
}

/** Puntaje y derivación: columnas que escribe el worker de la IA (como dueño, para preparar datos). */
async function setLead(id: string, values: { score?: number; tier?: string; handedOff?: string | null }) {
  await ctx.ownerPool.query(
    `UPDATE conversations SET lead_score = $2, lead_tier = $3,
       handed_off_at = CASE WHEN $4::text IS NULL THEN NULL ELSE now() END, handoff_reason = $4,
       handoff_summary = CASE WHEN $4::text IS NULL THEN NULL ELSE 'Ya pagó todo, confirmale el envío' END,
       extracted_data = '{"m2": 45, "producto_ambiente": "baño"}'::jsonb
     WHERE id = $1`,
    [id, values.score ?? null, values.tier ?? null, values.handedOff ?? null],
  );
}

async function login(key: UserKey, tenantId: string) {
  const client = new HttpClient(ctx);
  expect((await client.signIn(users[key].email)).status).toBe(200);
  expect((await client.post('/api/auth/organization/set-active', { organizationId: tenantId })).status).toBe(
    200,
  );
  clients[key] = client;
}

async function setSellersSeeAll(tenantId: string, value: boolean | null) {
  const db = ctx.app.get<AppDatabase>(APP_DB);
  const input: TenantConfigInput = testConfigInput([channels.A1, channels.A2]);
  if (value !== null) input.inbox = { sellers_see_all_channels: value };
  await withTenantTransaction(db.db, { tenantId }, (tx) => configs.insertVersion(tx, input));
}

const put = (client: HttpClient, channelId: string, userIds: string[]) =>
  client.request('PUT', `/api/channels/${channelId}/members`, { userIds });

const leadIds = async (client: HttpClient, query = '') => {
  const response = await client.get(`/api/leads${query}`);
  expect(response.status).toBe(200);
  return (response.body!.items as { id: string }[]).map((item) => item.id);
};

beforeAll(async () => {
  ctx = await startTestContext();
  for (const key of [
    'owner',
    'admin',
    'seller',
    'seller2',
    'viewer',
    'disabled',
    'ownerB',
    'sellerB',
  ] as const) {
    users[key] = await createUser(ctx, `inbox-${key}`);
  }
  tenantA = await createTenant(ctx, 'inbox-a', users.owner.id);
  tenantB = await createTenant(ctx, 'inbox-b', users.ownerB.id);
  await addMember(ctx, tenantA, users.admin.id, 'admin');
  await addMember(ctx, tenantA, users.seller.id, 'seller');
  await addMember(ctx, tenantA, users.seller2.id, 'seller');
  await addMember(ctx, tenantA, users.viewer.id, 'viewer');
  await addMember(ctx, tenantA, users.disabled.id, 'seller');
  await addMember(ctx, tenantB, users.sellerB.id, 'seller');

  channels.A1 = await createChannel(tenantA, users.owner.id, 'Ventas');
  channels.A2 = await createChannel(tenantA, users.owner.id, 'Sucursal');
  channels.B1 = await createChannel(tenantB, users.ownerB.id, 'Ventas B');

  convs.hot = await createConversation(tenantA, channels.A1, {
    name: 'Ana Caliente',
    waId: '+5491155550001',
  });
  convs.handed = await createConversation(tenantA, channels.A1, {
    name: 'Beto Derivado',
    messages: [
      { from: 'contact', text: 'Quiero 45 m² de porcelanato' },
      { from: 'ai', text: '¿Para qué ambiente?' },
      { from: 'contact', text: null, type: 'audio' },
    ],
  });
  convs.html = await createConversation(tenantA, channels.A1, {
    name: 'Ceci 50%_off',
    messages: [{ from: 'contact', text: HTML }],
  });
  convs.other = await createConversation(tenantA, channels.A2, { name: 'Dani Sucursal' });
  convs.b = await createConversation(tenantB, channels.B1, { name: 'Otra Empresa' });
  await setLead(convs.hot, { score: 85, tier: 'hot' });
  await setLead(convs.handed, { score: 60, tier: 'warm', handedOff: 'asks_human' });
  await setLead(convs.other, { score: 20, tier: 'cold' });

  await login('owner', tenantA);
  await login('admin', tenantA);
  await login('seller', tenantA);
  await login('seller2', tenantA);
  await login('viewer', tenantA);
  await login('disabled', tenantA);
  await login('ownerB', tenantB);

  expect((await put(clients.owner, channels.A1, [users.seller.id, users.disabled.id])).status).toBe(200);
  await ctx.ownerPool.query(`UPDATE memberships SET status = 'disabled' WHERE user_id = $1`, [
    users.disabled.id,
  ]);
});

afterAll(async () => {
  await ctx?.close();
});

describe('1. visibilidad por número', () => {
  it('el seller ve solo las conversaciones de A1', async () => {
    const ids = await leadIds(clients.seller);
    expect(ids.sort()).toEqual([convs.hot, convs.handed, convs.html].sort());
  });

  it('owner y admin ven todas las de la empresa (y nada de otra)', async () => {
    for (const key of ['owner', 'admin'] as const) {
      const ids = await leadIds(clients[key]);
      expect(ids.sort(), key).toEqual([convs.hot, convs.handed, convs.html, convs.other].sort());
    }
  });

  it('conversación de A2: detalle, mensajes y reactivar → 404 para el seller', async () => {
    expect((await clients.seller.get(`/api/conversations/${convs.other}`)).status).toBe(404);
    expect((await clients.seller.get(`/api/conversations/${convs.other}/messages`)).status).toBe(404);
    expect((await clients.seller.post(`/api/conversations/${convs.other}/reactivate-ai`)).status).toBe(404);
    expect((await clients.seller.get(`/api/conversations/${convs.hot}`)).status).toBe(200);
  });

  it('id malformado → 404 (no 400)', async () => {
    expect((await clients.owner.get('/api/conversations/no-es-un-uuid')).status).toBe(404);
  });

  it('viewer → 403 en todo', async () => {
    for (const path of [
      '/api/leads',
      '/api/leads/summary',
      `/api/conversations/${convs.hot}`,
      `/api/conversations/${convs.hot}/messages`,
      '/api/channels',
      '/api/members/sellers',
    ]) {
      const response = await clients.viewer.get(path);
      expect(response.status, path).toBe(403);
      expect(response.body?.code, path).toBe('FORBIDDEN_ROLE');
    }
    expect((await clients.viewer.post(`/api/conversations/${convs.hot}/reactivate-ai`)).status).toBe(403);
  });

  it('membresía desactivada → 403 (el guard, antes del permiso)', async () => {
    expect((await clients.disabled.get('/api/leads')).status).toBe(403);
  });

  it('3. un owner de otra empresa recibe 404 en las conversaciones de esta', async () => {
    expect((await clients.ownerB.get(`/api/conversations/${convs.hot}`)).status).toBe(404);
    expect((await clients.ownerB.get(`/api/conversations/${convs.hot}/messages`)).status).toBe(404);
    expect((await clients.ownerB.post(`/api/conversations/${convs.hot}/reactivate-ai`)).status).toBe(404);
    expect(await leadIds(clients.ownerB)).toEqual([convs.b]);
  });

  it('seller sin números: lista vacía con noChannels', async () => {
    const response = await clients.seller2.get('/api/leads');
    expect(response.body).toMatchObject({ items: [], total: 0, noChannels: true });
    expect((await clients.seller2.get('/api/leads/summary')).body).toEqual({
      pendingHandoffs: 0,
      channels: [],
    });
  });

  it('2. al quitarle el número, el pedido siguiente ya no las devuelve', async () => {
    expect((await put(clients.owner, channels.A1, [])).status).toBe(200);
    expect((await clients.seller.get('/api/leads')).body).toMatchObject({ items: [], noChannels: true });
    expect((await clients.seller.get(`/api/conversations/${convs.hot}`)).status).toBe(404);
    expect((await put(clients.owner, channels.A1, [users.seller.id])).status).toBe(200);
    expect(await leadIds(clients.seller)).toHaveLength(3);
  });

  it('inbox.sellers_see_all_channels: en true el seller ve todos los números; en false, solo los suyos', async () => {
    await setSellersSeeAll(tenantA, true);
    expect(await leadIds(clients.seller)).toHaveLength(4);
    expect(await leadIds(clients.seller2)).toHaveLength(4);
    expect((await clients.seller.get(`/api/conversations/${convs.other}`)).status).toBe(200);
    expect((await clients.viewer.get('/api/leads')).status).toBe(403);

    await setSellersSeeAll(tenantA, false);
    expect(await leadIds(clients.seller)).toHaveLength(3);
    expect((await clients.seller2.get('/api/leads')).body).toMatchObject({ noChannels: true });
    expect((await clients.seller.get(`/api/conversations/${convs.other}`)).status).toBe(404);
  });
});

describe('RLS: channel_visibility (red de seguridad)', () => {
  const counts = (context: { userId?: string; tenantId?: string }) =>
    asApp(ctx, context, async (c) => {
      const result: Record<string, number> = {};
      for (const table of [
        'conversations',
        'messages',
        'outbound_messages',
        'ai_runs',
        'conversation_events',
      ]) {
        const { rows } = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
          [tenantA],
        );
        result[table] = rows[0]!.n;
      }
      const { rows } = await c.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM conversations WHERE channel_id = $1',
        [channels.A2],
      );
      result.a2 = rows[0]!.n;
      return result;
    });

  it('con app.user_id de un seller, A2 no existe; sin usuario (workers) se ve todo', async () => {
    expect((await counts({ tenantId: tenantA, userId: users.seller.id })).a2).toBe(0);
    expect((await counts({ tenantId: tenantA, userId: users.seller.id })).conversations).toBe(3);
    expect((await counts({ tenantId: tenantA })).conversations).toBe(4);
    expect((await counts({ tenantId: tenantA, userId: users.owner.id })).conversations).toBe(4);
  });

  it('seller sin números y viewer: 0 filas en las tablas con contenido de conversaciones', async () => {
    for (const key of ['seller2', 'viewer'] as const) {
      const result = await counts({ tenantId: tenantA, userId: users[key].id });
      expect(result, key).toMatchObject({
        conversations: 0,
        messages: 0,
        outbound_messages: 0,
        ai_runs: 0,
        conversation_events: 0,
      });
    }
  });

  it('un seller no puede insertar un mensaje en un número que no tiene', async () => {
    const code = await asApp(ctx, { tenantId: tenantA, userId: users.seller.id }, async (c) => {
      try {
        await c.query(
          `INSERT INTO messages (tenant_id, conversation_id, channel_id, external_id, direction, sender_type,
             type, body, raw, sent_at)
           VALUES ($1, $2, $3, 'x', 'outbound', 'user', 'text', 'hola', '{}', now())`,
          [tenantA, convs.other, channels.A2],
        );
        return undefined;
      } catch (error) {
        return (error as { code?: string }).code;
      }
    });
    expect(code).toBe('42501');
  });

  it('con la opción en true, el seller ve todo también por RLS; el viewer sigue sin ver', async () => {
    await setSellersSeeAll(tenantA, true);
    expect((await counts({ tenantId: tenantA, userId: users.seller2.id })).conversations).toBe(4);
    expect((await counts({ tenantId: tenantA, userId: users.viewer.id })).conversations).toBe(0);
    await setSellersSeeAll(tenantA, false);
    expect((await counts({ tenantId: tenantA, userId: users.seller2.id })).conversations).toBe(0);
  });

  it('app_sees_all_channels() coincide con read_all de libs/shared para cada rol', async () => {
    const probe = (await createUser(ctx, 'inbox-probe')).id;
    await addMember(ctx, tenantA, probe, 'viewer');
    for (const role of TENANT_ROLES) {
      if (role !== 'owner') {
        await ctx.ownerPool.query('UPDATE memberships SET role = $1 WHERE user_id = $2', [role, probe]);
      }
      const userId = role === 'owner' ? users.owner.id : probe;
      const seesAll = await asApp(ctx, { tenantId: tenantA, userId }, async (c) => {
        const { rows } = await c.query<{ v: boolean }>('SELECT app_sees_all_channels() AS v');
        return rows[0]!.v;
      });
      expect(seesAll, role).toBe(roleCan(role, { conversation: ['read_all'] }));
    }
  });
});

describe('GET /api/leads', () => {
  it('orden por defecto: derivadas sin atender primero, después puntaje', async () => {
    const ids = await leadIds(clients.owner);
    expect(ids.slice(0, 2)).toEqual([convs.handed, convs.hot]);
    const response = await clients.owner.get('/api/leads');
    const first = (response.body!.items as Record<string, unknown>[])[0]!;
    expect(first).toMatchObject({
      state: 'handed_off',
      pendingHandoff: true,
      tier: 'warm',
      contact: { name: 'Beto Derivado' },
      channel: { id: channels.A1, name: 'Ventas' },
      lastMessage: { type: 'audio', senderType: 'contact', preview: null },
    });
  });

  it('orden de la bandeja (priority): sin nadie esperando a una persona, manda el calor', async () => {
    // Todas esperan respuesta hace segundos: pesa el puntaje (hot 85, handed 60, other 20, html sin puntaje).
    expect(await leadIds(clients.owner, '?sort=priority')).toEqual([
      convs.hot,
      convs.handed,
      convs.other,
      convs.html,
    ]);
  });

  it('una respuesta de una persona después de la derivación la saca de "sin atender"', async () => {
    await withTenant(ctx, tenantA, (c) =>
      c.query(
        `INSERT INTO messages (tenant_id, conversation_id, channel_id, external_id, direction, sender_type,
           type, body, status, raw, sent_at)
         VALUES ($1, $2, $3, $4, 'outbound', 'user', 'text', 'Hola, soy del equipo', 'sent', '{}', now() + interval '1 second')`,
        [tenantA, convs.handed, channels.A1, uid()],
      ),
    );
    const summary = (await clients.owner.get('/api/leads/summary')).body!;
    expect(summary.pendingHandoffs).toBe(0);
    const response = await clients.owner.get('/api/leads');
    const handed = (response.body!.items as { id: string; pendingHandoff: boolean }[]).find(
      (item) => item.id === convs.handed,
    );
    expect(handed?.pendingHandoff).toBe(false);
  });

  it('ordena por puntaje en las dos direcciones (sin puntaje al final)', async () => {
    expect(await leadIds(clients.owner, '?sort=score&dir=desc')).toEqual([
      convs.hot,
      convs.handed,
      convs.other,
      convs.html,
    ]);
    expect(await leadIds(clients.owner, '?sort=score&dir=asc')).toEqual([
      convs.other,
      convs.handed,
      convs.hot,
      convs.html,
    ]);
  });

  it('filtra por nivel, estado y número', async () => {
    expect(await leadIds(clients.owner, '?tier=hot')).toEqual([convs.hot]);
    expect((await leadIds(clients.owner, '?tier=hot,cold')).sort()).toEqual([convs.hot, convs.other].sort());
    expect(await leadIds(clients.owner, '?tier=none')).toEqual([convs.html]);
    expect(await leadIds(clients.owner, '?status=handed_off')).toEqual([convs.handed]);
    expect(await leadIds(clients.owner, `?channelId=${channels.A2}`)).toEqual([convs.other]);
    // El filtro por número no amplía lo que ve el seller.
    expect(await leadIds(clients.seller, `?channelId=${channels.A2}`)).toEqual([]);
  });

  it('busca por nombre (comodines literales) y por número (solo dígitos)', async () => {
    expect(await leadIds(clients.owner, '?q=caliente')).toEqual([convs.hot]);
    expect(await leadIds(clients.owner, `?q=${encodeURIComponent('50%_')}`)).toEqual([convs.html]);
    expect(await leadIds(clients.owner, `?q=${encodeURIComponent('%%')}`)).toEqual([]);
    expect(await leadIds(clients.owner, `?q=${encodeURIComponent('+54 9 11 5555-0001')}`)).toEqual([
      convs.hot,
    ]);
    expect(await leadIds(clients.owner, '?q=55550001')).toEqual([convs.hot]);
  });

  it('pagina en el servidor con total', async () => {
    const page = await clients.owner.get('/api/leads?sort=score&pageSize=2&page=1');
    expect(page.body).toMatchObject({ total: 4, page: 1, pageSize: 2 });
    expect((page.body!.items as { id: string }[]).map((item) => item.id)).toEqual([convs.other, convs.html]);
  });

  it('parámetros inválidos → 400 sin eco del valor', async () => {
    for (const query of ['?pageSize=51', '?sort=raw', '?tier=hot;drop', '?channelId=x', '?q=a', '?extra=1']) {
      const response = await clients.owner.get(`/api/leads${query}`);
      expect(response.status, query).toBe(400);
      expect(response.body?.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(response.body)).not.toContain('drop');
    }
  });
});

describe('bandeja: prioridad, sin responder y sin ver (#82)', () => {
  /** Mensaje en A1 o A2 con sent_at relativo a ahora (segundos; negativo = en el pasado). */
  async function addMessage(
    conversationId: string,
    channelId: string,
    from: 'contact' | 'user',
    offset: number,
  ) {
    await withTenant(ctx, tenantA, (c) =>
      c.query(
        `INSERT INTO messages (tenant_id, conversation_id, channel_id, external_id, direction, sender_type,
           type, body, status, raw, sent_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'text', 'texto', $7, '{}', now() + make_interval(secs => $8))`,
        [
          tenantA,
          conversationId,
          channelId,
          uid(),
          from === 'contact' ? 'inbound' : 'outbound',
          from,
          from === 'contact' ? 'received' : 'sent',
          offset,
        ],
      ),
    );
  }

  it('el cliente le contesta a una persona del equipo → arriba de todo', async () => {
    await addMessage(convs.hot, channels.A1, 'user', -20);
    await addMessage(convs.hot, channels.A1, 'contact', -10);
    const response = await clients.owner.get('/api/leads?sort=priority');
    const items = response.body!.items as {
      id: string;
      awaitingReply: boolean;
      waitingSince: string | null;
    }[];
    expect(items.map((item) => item.id)).toEqual([convs.hot, convs.handed, convs.other, convs.html]);
    expect(items[0]).toMatchObject({ awaitingReply: true });
    // handed: la última respuesta es de una persona → no espera.
    expect(items[1]).toMatchObject({ awaitingReply: false, waitingSince: null });
  });

  it('a igual situación, el que espera hace más (tope 24 h) sube por encima de uno más caliente', async () => {
    // other (puntaje 20) espera hace un día: 0,5 × 0,2 + 0,5 × 1 = 0,6 > handed (0,5 × 0,6 = 0,3).
    await ctx.ownerPool.query(
      `UPDATE messages SET sent_at = now() - interval '25 hours' WHERE conversation_id = $1`,
      [convs.other],
    );
    expect(await leadIds(clients.owner, '?sort=priority')).toEqual([
      convs.hot,
      convs.other,
      convs.handed,
      convs.html,
    ]);
  });

  it('filtro "sin responder": solo las que esperan respuesta', async () => {
    expect((await leadIds(clients.owner, '?attention=unanswered')).sort()).toEqual(
      [convs.hot, convs.other, convs.html].sort(),
    );
  });

  it('"sin ver" es por persona y vuelve con un mensaje nuevo del cliente', async () => {
    expect(await leadIds(clients.owner, '?attention=unread')).toContain(convs.hot);
    expect((await clients.owner.post(`/api/conversations/${convs.hot}/read`)).status).toBe(204);
    expect(await leadIds(clients.owner, '?attention=unread')).not.toContain(convs.hot);
    // Para el admin sigue sin ver.
    expect(await leadIds(clients.admin, '?attention=unread')).toContain(convs.hot);
    const row = (
      (await clients.owner.get('/api/leads')).body!.items as { id: string; unread: boolean }[]
    ).find((item) => item.id === convs.hot);
    expect(row?.unread).toBe(false);

    await addMessage(convs.hot, channels.A1, 'contact', 5);
    expect(await leadIds(clients.owner, '?attention=unread')).toContain(convs.hot);
  });

  it('marcar como visto: 404 en un número ajeno, 403 al viewer, idempotente', async () => {
    expect((await clients.seller.post(`/api/conversations/${convs.other}/read`)).status).toBe(404);
    expect((await clients.viewer.post(`/api/conversations/${convs.hot}/read`)).status).toBe(403);
    expect((await clients.seller.post(`/api/conversations/${convs.hot}/read`)).status).toBe(204);
    expect((await clients.seller.post(`/api/conversations/${convs.hot}/read`)).status).toBe(204);
  });

  it('RLS: cada usuario ve y escribe solo sus lecturas', async () => {
    const own = (userId: string) =>
      asApp(ctx, { tenantId: tenantA, userId }, async (c) => {
        const { rows } = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM conversation_reads');
        return rows[0]!.n;
      });
    expect(await own(users.owner.id)).toBeGreaterThan(0);
    expect(await own(users.admin.id)).toBe(0);
    const code = await asApp(ctx, { tenantId: tenantA, userId: users.admin.id }, (c) =>
      errorCodeIn(
        c,
        `INSERT INTO conversation_reads (tenant_id, conversation_id, user_id, last_read_at) VALUES ($1, $2, $3, now())`,
        [tenantA, convs.hot, users.owner.id],
      ),
    );
    expect(code).toBe('42501');
  });
});

describe('detalle y mensajes', () => {
  it('detalle: puntaje, datos con su etiqueta, derivación y estado de la IA', async () => {
    await setSellersSeeAll(tenantA, false);
    const response = await clients.owner.get(`/api/conversations/${convs.handed}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      score: 60,
      tier: 'warm',
      handoff: { reason: 'asks_human', summary: 'Ya pagó todo, confirmale el envío' },
      ai: { state: 'handed_off', lastReactivation: null },
    });
    expect(response.body!.extractedData).toEqual(
      expect.arrayContaining([
        { key: 'm2', label: 'Metros cuadrados', value: '45' },
        { key: 'producto_ambiente', label: 'Producto o ambiente', value: 'baño' },
      ]),
    );
  });

  it('5. los mensajes no traen raw ni media_key, y el texto viene literal', async () => {
    const response = await clients.owner.get(`/api/conversations/${convs.html}/messages`);
    const text = JSON.stringify(response.body);
    expect(text).not.toMatch(/raw|media_?key|mediaKey|secreto|clave-secreta/i);
    expect((response.body!.items as { body: string }[])[0]!.body).toBe(HTML);

    const audio = await clients.owner.get(`/api/conversations/${convs.handed}/messages`);
    expect(JSON.stringify(audio.body)).not.toContain('clave-secreta');
    for (const item of audio.body!.items as Record<string, unknown>[]) {
      expect(Object.keys(item).sort()).toEqual(
        ['body', 'direction', 'id', 'senderType', 'sentAt', 'sentByName', 'status', 'type'].sort(),
      );
    }
  });

  it('paginados hacia atrás con cursor, del más viejo al más nuevo', async () => {
    const first = await clients.owner.get(`/api/conversations/${convs.handed}/messages?limit=2`);
    const newest = first.body!.items as { body: string | null; senderType: string }[];
    expect(newest.map((item) => item.senderType)).toEqual(['contact', 'user']);
    const before = first.body!.nextBefore as string;
    expect(before).toBeTruthy();
    const second = await clients.owner.get(
      `/api/conversations/${convs.handed}/messages?limit=2&before=${before}`,
    );
    expect((second.body!.items as { body: string }[]).map((item) => item.body)).toEqual([
      'Quiero 45 m² de porcelanato',
      '¿Para qué ambiente?',
    ]);
    expect(second.body!.nextBefore).toBeNull();
    // Basura, o una fecha que Date.parse acepta pero Postgres no ("1") → 400, no 500.
    const badCursors = [
      'basura',
      Buffer.from(`1|${convs.handed}`).toString('base64url'),
      Buffer.from(`2026-10-30T12:00:00Z|${'-'.repeat(36)}`).toString('base64url'),
    ];
    for (const bad of badCursors) {
      const response = await clients.owner.get(`/api/conversations/${convs.handed}/messages?before=${bad}`);
      expect(response.status, bad).toBe(400);
    }
  });
});

describe('6. reactivar la IA', () => {
  it('derivada → NULL, contadores en 0 y queda quién lo hizo; repetir no registra otra vez', async () => {
    await ctx.ownerPool.query(
      'UPDATE conversations SET qualification_turns = 4, hot_turns = 2 WHERE id = $1',
      [convs.handed],
    );
    const response = await clients.seller.post(`/api/conversations/${convs.handed}/reactivate-ai`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      handoff: null,
      ai: { state: 'active', lastReactivation: { byName: 'inbox-seller' } },
    });

    const { rows } = await ctx.ownerPool.query(
      'SELECT handed_off_at, handoff_reason, ai_paused_until, qualification_turns, hot_turns FROM conversations WHERE id = $1',
      [convs.handed],
    );
    expect(rows[0]).toEqual({
      handed_off_at: null,
      handoff_reason: null,
      ai_paused_until: null,
      qualification_turns: 0,
      hot_turns: 0,
    });
    expect((await clients.seller.post(`/api/conversations/${convs.handed}/reactivate-ai`)).status).toBe(200);
    const events = await ctx.ownerPool.query(
      'SELECT user_id, type, data FROM conversation_events WHERE conversation_id = $1',
      [convs.handed],
    );
    expect(events.rows).toMatchObject([
      { user_id: users.seller.id, type: 'ai_reactivated', data: { previous_handoff_reason: 'asks_human' } },
    ]);
    expect(JSON.stringify(events.rows)).not.toContain('pagó');
  });

  it('pausada por una persona → se reactiva', async () => {
    await ctx.ownerPool.query(
      `UPDATE conversations SET ai_paused_until = now() + interval '12 hours' WHERE id = $1`,
      [convs.hot],
    );
    expect((await clients.owner.get(`/api/conversations/${convs.hot}`)).body).toMatchObject({
      ai: { state: 'paused' },
    });
    const response = await clients.owner.post(`/api/conversations/${convs.hot}/reactivate-ai`);
    expect(response.body).toMatchObject({ ai: { state: 'active', pausedUntil: null } });
  });

  it('sin Origin confiable → 403 (control de origen)', async () => {
    const response = await fetch(`${ctx.baseUrl}/api/conversations/${convs.hot}/reactivate-ai`, {
      method: 'POST',
      headers: { Cookie: clients.owner.cookieHeader() },
    });
    expect(response.status).toBe(403);
  });
});

describe('4. números y vendedores', () => {
  it('GET /api/channels: números con vendedores activos (sin la membresía desactivada)', async () => {
    await ctx.ownerPool.query(
      'INSERT INTO channel_members (tenant_id, channel_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [tenantA, channels.A1, users.disabled.id],
    );
    const response = await clients.admin.get('/api/channels');
    expect(response.status).toBe(200);
    const a1 = (response.body!.items as { id: string; sellers: { userId: string }[] }[]).find(
      (item) => item.id === channels.A1,
    );
    expect(a1?.sellers.map((seller) => seller.userId)).toEqual([users.seller.id]);
    expect((response.body!.items as unknown[]).length).toBe(2);
  });

  it('GET /api/members/sellers: solo sellers activos de la empresa', async () => {
    const response = await clients.owner.get('/api/members/sellers');
    const ids = (response.body!.items as { userId: string }[]).map((item) => item.userId).sort();
    expect(ids).toEqual([users.seller.id, users.seller2.id].sort());
  });

  it('viewer, admin, desactivado, de otra empresa, repetido o inexistente → 400 y no cambia nada', async () => {
    for (const userIds of [
      [users.viewer.id],
      [users.admin.id],
      [users.disabled.id],
      [users.sellerB.id],
      [users.seller2.id, users.seller2.id],
      ['00000000-0000-7000-8000-000000000000'],
    ]) {
      const response = await put(clients.owner, channels.A2, userIds);
      expect(response.status, JSON.stringify(userIds)).toBe(400);
    }
    expect((await put(clients.owner, channels.A2, ['no-uuid'])).status).toBe(400);
    const channels2 = (await clients.owner.get('/api/channels')).body!.items as {
      id: string;
      sellers: unknown[];
    }[];
    expect(channels2.find((item) => item.id === channels.A2)?.sellers).toEqual([]);
  });

  it('un seller no puede asignar (403); un número de otra empresa → 404', async () => {
    expect((await put(clients.seller, channels.A1, [users.seller.id])).status).toBe(403);
    expect((await put(clients.owner, channels.B1, [users.seller.id])).status).toBe(404);
  });

  it('el admin asigna y queda quién lo hizo', async () => {
    const response = await put(clients.admin, channels.A2, [users.seller2.id]);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: channels.A2, sellers: [{ userId: users.seller2.id }] });
    const { rows } = await ctx.ownerPool.query(
      'SELECT created_by FROM channel_members WHERE channel_id = $1',
      [channels.A2],
    );
    expect(rows).toEqual([{ created_by: users.admin.id }]);
    expect(await leadIds(clients.seller2)).toEqual([convs.other]);
  });

  it('reasignar solo cambia lo que cambió: el que sigue conserva quién y cuándo lo asignaron', async () => {
    const before = await ctx.ownerPool.query(
      'SELECT created_by, created_at FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [channels.A2, users.seller2.id],
    );
    expect((await put(clients.owner, channels.A2, [users.seller2.id, users.seller.id])).status).toBe(200);
    const { rows } = await ctx.ownerPool.query(
      'SELECT user_id, created_by, created_at FROM channel_members WHERE channel_id = $1',
      [channels.A2],
    );
    const kept = rows.find((row) => row.user_id === users.seller2.id);
    const added = rows.find((row) => row.user_id === users.seller.id);
    expect(kept).toMatchObject(before.rows[0]!);
    expect(added?.created_by).toBe(users.owner.id);

    expect((await put(clients.owner, channels.A2, [users.seller2.id])).status).toBe(200);
    const after = await ctx.ownerPool.query('SELECT user_id FROM channel_members WHERE channel_id = $1', [
      channels.A2,
    ]);
    expect(after.rows).toEqual([{ user_id: users.seller2.id }]);
  });
});
