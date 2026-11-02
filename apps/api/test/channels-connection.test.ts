// Verificación de la tarea 011 contra el Postgres local: conectar un número por QR desde el panel con el
// proveedor falso. El escaneo se simula como en producción: un webhook session.status firmado (WORKING con
// me.id) que procesa el worker de la app. Números ficticios.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InboundService } from '../src/whatsapp/inbound/inbound.service.js';
import { InboundWorker } from '../src/whatsapp/inbound/inbound.worker.js';
import { INBOX_EVENTS_CHANNEL } from '../src/realtime/publish.js';
import { WHATSAPP_PROVIDER_REGISTRY, type WhatsAppProviderRegistry } from '../src/whatsapp/provider.js';
import { FAKE_QR_IMAGE } from '../src/whatsapp/providers/fake/fake-qr.js';
import type { FakeWhatsAppProvider } from '../src/whatsapp/providers/fake/fake.provider.js';
import { SessionCloseWorker } from '../src/whatsapp/inbound/session-close.worker.js';
import {
  addMember,
  asApp,
  createTenant,
  createUser,
  errorCodeIn,
  HttpClient,
  postWahaWebhook,
  startTestContext,
  waitFor,
  withTenant,
  type TestContext,
} from './helpers.js';
import { fakePhone, uid } from './outbound-helpers.js';

let ctx: TestContext;
let fake: FakeWhatsAppProvider;

type UserKey = 'owner' | 'admin' | 'seller' | 'viewer' | 'ownerB';
const users = {} as Record<UserKey, { id: string; email: string }>;
const clients = {} as Record<UserKey, HttpClient>;
let tenantA: string;
let tenantB: string;

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/whatsapp/waha/session-status-working.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

/** session.status de WAHA para la sesión (WORKING con el número vinculado en me.id, o el estado dado). */
function sessionStatus(session: string, status: string, phone?: string) {
  return JSON.stringify({
    ...FIXTURE,
    id: `evt_${uid()}`,
    session,
    me: phone ? { id: `${phone.slice(1)}@c.us`, pushName: 'Negocio' } : null,
    payload: { status, statuses: [{ status, timestamp: Date.now() }], data: null },
  });
}

const NO_PAIRING = { qr: null, phoneNumber: null, disconnectReason: null, numberInUse: null };

/**
 * Espera a que el worker termine con todo lo que llegó por el webhook para la sesión: para comprobar que
 * un evento no cambió nada, sin pausas fijas.
 */
async function processed(session: string) {
  await waitFor(async () => {
    const { rows } = await ctx.ownerPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pgboss.job
       WHERE name = 'whatsapp-inbound' AND data->'payload'->>'session' = $1
         AND state NOT IN ('completed', 'failed', 'cancelled')`,
      [session],
    );
    return rows[0]!.n === 0;
  });
}

const scan = (session: string, phone: string) =>
  postWahaWebhook(ctx, sessionStatus(session, 'WORKING', phone));

async function login(key: UserKey, tenantId: string) {
  const client = new HttpClient(ctx);
  expect((await client.signIn(users[key].email)).status).toBe(200);
  expect((await client.post('/api/auth/organization/set-active', { organizationId: tenantId })).status).toBe(
    200,
  );
  clients[key] = client;
}

async function channelRow(id: string) {
  const { rows } = await ctx.ownerPool.query<{
    status: string;
    phone_number: string | null;
    external_id: string;
    provider: string;
    connection_type: string;
    risk_accepted_by: string;
    disconnect_reason: string | null;
    connected_at: Date | null;
    sending_paused_until: Date | null;
  }>('SELECT * FROM channels WHERE id = $1', [id]);
  return rows[0];
}

async function events(id: string) {
  const { rows } = await ctx.ownerPool.query<{ type: string; user_id: string | null; data: unknown }>(
    'SELECT type, user_id, data FROM channel_events WHERE channel_id = $1 ORDER BY created_at, id',
    [id],
  );
  return rows;
}

/** Alta desde el panel: devuelve el id y la sesión que generó el sistema. */
async function createPending(client = clients.owner, name = `Canal ${uid()}`) {
  const response = await client.post('/api/channels', { name });
  expect(response.status).toBe(200);
  const id = response.body!.id as string;
  return { id, session: (await channelRow(id))!.external_id };
}

/** Alta y escaneo con un número nuevo, hasta quedar conectado. */
async function createConnected(phone = `+${fakePhone()}`) {
  const channel = await createPending();
  expect(await scan(channel.session, phone)).toBe(200);
  await waitFor(async () => (await channelRow(channel.id))?.status === 'connected');
  return { ...channel, phone };
}

/** Escucha los avisos de tiempo real (LISTEN) mientras corre fn. */
async function noticesDuring(fn: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL_MIGRATIONS });
  await client.connect();
  const received: Record<string, unknown>[] = [];
  client.on('notification', (message) => received.push(JSON.parse(message.payload ?? '{}')));
  await client.query(`LISTEN ${INBOX_EVENTS_CHANNEL}`);
  try {
    await fn();
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    await client.end();
  }
  return received;
}

/** Todo lo que se escribe en stdout/stderr mientras corre fn. */
async function outputDuring(fn: () => Promise<void>): Promise<string> {
  let output = '';
  const originals = [process.stdout.write, process.stderr.write];
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      output += String(chunk);
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write;
  }
  try {
    await fn();
  } finally {
    process.stdout.write = originals[0]!;
    process.stderr.write = originals[1]!;
  }
  return output;
}

beforeAll(async () => {
  ctx = await startTestContext();
  fake = ctx.app
    .get<WhatsAppProviderRegistry>(WHATSAPP_PROVIDER_REGISTRY)
    .get('waha') as FakeWhatsAppProvider;
  for (const k of ['owner', 'admin', 'seller', 'viewer', 'ownerB'] as const) {
    users[k] = await createUser(ctx, `canales-${k}`);
  }
  tenantA = await createTenant(ctx, 'canales-a', users.owner.id);
  tenantB = await createTenant(ctx, 'canales-b', users.ownerB.id);
  await addMember(ctx, tenantA, users.admin.id, 'admin');
  await addMember(ctx, tenantA, users.seller.id, 'seller');
  await addMember(ctx, tenantA, users.viewer.id, 'viewer');
  for (const k of ['owner', 'admin', 'seller', 'viewer'] as const) await login(k, tenantA);
  await login('ownerB', tenantB);
});

afterAll(async () => {
  await ctx?.close();
});

describe('alta de un canal', () => {
  it('crea el canal pending sin número, con la sesión y quién aceptó el riesgo puestos por el sistema', async () => {
    const response = await clients.admin.post('/api/channels', {
      name: '  Ventas Centro ',
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      name: 'Ventas Centro',
      status: 'pending',
      phoneNumber: null,
      disconnectReason: null,
      sendingPause: null,
    });
    const id = response.body!.id as string;
    const row = await channelRow(id);
    expect(row).toMatchObject({
      provider: 'waha',
      connection_type: 'unofficial',
      external_id: `ch_${id.replaceAll('-', '')}`,
      risk_accepted_by: users.admin.id,
      phone_number: null,
    });
    expect(fake.sessions.has(row!.external_id)).toBe(true);
    expect(await events(id)).toEqual([{ type: 'created', user_id: users.admin.id, data: {} }]);
  });

  it('sin nombre, o con provider/external_id/número/quién conectó en el body → 400 y no crea nada', async () => {
    const before = await ctx.ownerPool.query('SELECT count(*)::int AS n FROM channels WHERE tenant_id = $1', [
      tenantA,
    ]);
    for (const body of [
      {},
      { name: '' },
      { name: '   ' },
      { name: 'X', externalId: 'ceramicos-demo' },
      { name: 'X', provider: 'cloud_api' },
      { name: 'X', phoneNumber: '+5491100000001' },
      { name: 'X', riskAcceptedBy: users.ownerB.id },
    ]) {
      expect((await clients.owner.post('/api/channels', body)).status).toBe(400);
    }
    const after = await ctx.ownerPool.query('SELECT count(*)::int AS n FROM channels WHERE tenant_id = $1', [
      tenantA,
    ]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('QR', () => {
  it('devuelve el QR vigente con Cache-Control: no-store y nunca lo escribe en los logs', async () => {
    const channel = await createPending();
    let response: Response | undefined;
    const output = await outputDuring(async () => {
      response = await fetch(`${ctx.baseUrl}/api/channels/${channel.id}/pairing`, {
        headers: { Origin: ctx.env.BETTER_AUTH_URL, Cookie: clients.owner.cookieHeader() },
      });
    });
    expect(response!.status).toBe(200);
    expect(response!.headers.get('cache-control')).toBe('no-store');
    const body = (await response!.json()) as { state: string; qr: string };
    expect(body).toEqual({ ...NO_PAIRING, state: 'qr', qr: FAKE_QR_IMAGE });
    expect(body.qr.startsWith('data:image/png;base64,')).toBe(true);
    const base64 = FAKE_QR_IMAGE.slice('data:image/png;base64,'.length);
    expect(output).not.toContain(base64.slice(0, 40));
  });

  it('si el QR se agota (FAILED) el canal queda desconectado con pairing_expired y el QR dice expired', async () => {
    const channel = await createPending();
    expect(await postWahaWebhook(ctx, sessionStatus(channel.session, 'FAILED'))).toBe(200);
    await waitFor(async () => (await channelRow(channel.id))?.status === 'disconnected');
    expect((await channelRow(channel.id))!.disconnect_reason).toBe('pairing_expired');
    expect((await clients.owner.get(`/api/channels/${channel.id}/pairing`)).body).toEqual({
      ...NO_PAIRING,
      state: 'expired',
    });
  });

  it('un STOPPED mientras espera el escaneo (pedido de QR nuevo) no lo desconecta', async () => {
    const channel = await createPending();
    expect(await postWahaWebhook(ctx, sessionStatus(channel.session, 'STOPPED'))).toBe(200);
    expect(await postWahaWebhook(ctx, sessionStatus(channel.session, 'SCAN_QR_CODE'))).toBe(200);
    await processed(channel.session);
    expect((await channelRow(channel.id))!.status).toBe('pending');
  });
});

describe('escaneo', () => {
  it('conecta el canal con el número escaneado y publica channel.updated', async () => {
    const channel = await createPending();
    const phone = `+${fakePhone()}`;
    const notices = await noticesDuring(async () => {
      expect(await scan(channel.session, phone)).toBe(200);
      await waitFor(async () => (await channelRow(channel.id))?.status === 'connected');
    });
    expect(notices).toContainEqual({
      kind: 'channel',
      type: 'channel.updated',
      tenantId: tenantA,
      channelId: channel.id,
    });
    const row = await channelRow(channel.id);
    expect(row!.phone_number).toBe(phone);
    expect(row!.connected_at).not.toBeNull();
    expect((await clients.owner.get(`/api/channels/${channel.id}/pairing`)).body).toEqual({
      ...NO_PAIRING,
      state: 'connected',
      phoneNumber: phone,
    });
    const list = await clients.owner.get('/api/channels');
    const item = (list.body!.items as Record<string, unknown>[]).find((c) => c.id === channel.id);
    expect(item).toMatchObject({ status: 'connected', phoneNumber: phone, disconnectReason: null });
    expect((await events(channel.id)).map((e) => e.type)).toEqual(['created', 'connected']);
  });

  it('reescanear con otro teléfono no pisa el número: desconectado con phone_mismatch y sesión cerrada', async () => {
    const channel = await createConnected();
    const other = `+${fakePhone()}`;
    expect(await scan(channel.session, other)).toBe(200);
    await waitFor(async () => (await channelRow(channel.id))?.status === 'disconnected');
    const row = await channelRow(channel.id);
    expect(row).toMatchObject({ phone_number: channel.phone, disconnect_reason: 'phone_mismatch' });
    expect((await events(channel.id)).map((e) => e.type)).toContain('phone_mismatch');
    // El worker de whatsapp-session-close desvincula la sesión en el proveedor.
    await waitFor(async () => !fake.sessions.has(channel.session));
    // Lo que llegue por esa sesión ya no es de esta empresa.
    const { rows } = await ctx.ownerPool.query('SELECT * FROM resolve_channel($1, $2)', [
      'waha',
      channel.session,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('un número que ya está en otro canal de la empresa: number_in_use, sin reintentos y explicado', async () => {
    const first = await createConnected();
    const second = await createPending(clients.owner, 'Segundo');
    expect(await scan(second.session, first.phone)).toBe(200);
    await waitFor(async () => (await channelRow(second.id))?.status === 'disconnected');
    expect(await channelRow(second.id)).toMatchObject({
      phone_number: null,
      disconnect_reason: 'number_in_use',
    });
    // Un reenvío del mismo evento (o uno nuevo) no hace nada: resolve_channel descarta la sesión rechazada.
    expect(await scan(second.session, first.phone)).toBe(200);
    await processed(second.session);
    expect((await events(second.id)).filter((e) => e.type === 'number_in_use')).toHaveLength(1);
    const firstName = (
      (await clients.owner.get('/api/channels')).body!.items as Record<string, unknown>[]
    ).find((c) => c.id === first.id)!.name;
    const item = ((await clients.owner.get('/api/channels')).body!.items as Record<string, unknown>[]).find(
      (c) => c.id === second.id,
    );
    expect(item).toMatchObject({
      status: 'disconnected',
      disconnectReason: 'number_in_use',
      numberInUse: { scope: 'same_tenant', channelName: firstName },
    });
    expect((await channelRow(first.id))!.status).toBe('connected');
  });

  it('el mismo número en otra empresa se bloquea, sin decir en cuál', async () => {
    const inA = await createConnected();
    const inB = await createPending(clients.ownerB, 'Ventas B');
    expect(await scan(inB.session, inA.phone)).toBe(200);
    await waitFor(async () => (await channelRow(inB.id))?.status === 'disconnected');
    const item = ((await clients.ownerB.get('/api/channels')).body!.items as Record<string, unknown>[]).find(
      (c) => c.id === inB.id,
    );
    expect(item).toMatchObject({
      phoneNumber: null,
      disconnectReason: 'number_in_use',
      numberInUse: { scope: 'other_tenant', channelName: null },
    });
    expect(JSON.stringify(item)).not.toContain(inA.phone);
    expect((await channelRow(inA.id))!.status).toBe('connected');
    // El diálogo del QR explica lo mismo que la lista (no dice "venció").
    const pairing = await clients.ownerB.get(`/api/channels/${inB.id}/pairing`);
    expect(pairing.body).toEqual({
      ...NO_PAIRING,
      state: 'rejected',
      disconnectReason: 'number_in_use',
      numberInUse: { scope: 'other_tenant', channelName: null },
    });
  });

  it('el QR de un canal rechazado por otro teléfono dice rejected, con el número del canal', async () => {
    const channel = await createConnected();
    await scan(channel.session, `+${fakePhone()}`);
    await waitFor(async () => (await channelRow(channel.id))?.disconnect_reason === 'phone_mismatch');
    expect((await clients.owner.get(`/api/channels/${channel.id}/pairing`)).body).toEqual({
      ...NO_PAIRING,
      state: 'rejected',
      phoneNumber: channel.phone,
      disconnectReason: 'phone_mismatch',
    });
  });

  it('un WORKING sin número después de un QR no usa el número viejo; sin QR de por medio, sí', async () => {
    const channel = await createConnected();
    await clients.owner.post(`/api/channels/${channel.id}/disconnect`);
    await clients.owner.post(`/api/channels/${channel.id}/reconnect`);
    // Después del QR: podría ser otro teléfono, queda esperando el número.
    expect(await postWahaWebhook(ctx, sessionStatus(channel.session, 'WORKING'))).toBe(200);
    await processed(channel.session);
    expect((await channelRow(channel.id))!.status).toBe('pending');
    expect(await scan(channel.session, channel.phone)).toBe(200);
    await waitFor(async () => (await channelRow(channel.id))?.status === 'connected');

    // El proveedor vuelve a levantar la misma sesión (sin QR): el número del canal vale.
    expect(await postWahaWebhook(ctx, sessionStatus(channel.session, 'STARTING'))).toBe(200);
    await waitFor(async () => (await channelRow(channel.id))?.status === 'pending');
    expect(await postWahaWebhook(ctx, sessionStatus(channel.session, 'WORKING'))).toBe(200);
    await waitFor(async () => (await channelRow(channel.id))?.status === 'connected');
    expect((await channelRow(channel.id))!.phone_number).toBe(channel.phone);
  });

  it('se agotan los QR de una reconexión: pairing_expired; una sesión que falla sola: session_failed', async () => {
    const channel = await createConnected();
    await clients.owner.post(`/api/channels/${channel.id}/disconnect`);
    await clients.owner.post(`/api/channels/${channel.id}/reconnect`);
    expect(await postWahaWebhook(ctx, sessionStatus(channel.session, 'FAILED'))).toBe(200);
    await waitFor(async () => (await channelRow(channel.id))?.status === 'disconnected');
    expect((await channelRow(channel.id))!.disconnect_reason).toBe('pairing_expired');

    const other = await createConnected();
    expect(await postWahaWebhook(ctx, sessionStatus(other.session, 'FAILED'))).toBe(200);
    await waitFor(async () => (await channelRow(other.id))?.status === 'disconnected');
    expect((await channelRow(other.id))!.disconnect_reason).toBe('session_failed');
  });
});

describe('acciones del panel', () => {
  it('desconectar: cierra la sesión, queda logged_out y registrado; otra vez → 409', async () => {
    const channel = await createConnected();
    fake.sessions.add(channel.session);
    const response = await clients.admin.post(`/api/channels/${channel.id}/disconnect`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'disconnected', disconnectReason: 'logged_out' });
    expect(fake.sessions.has(channel.session)).toBe(false);
    expect((await events(channel.id)).at(-1)).toEqual({
      type: 'disconnected',
      user_id: users.admin.id,
      data: { by: 'user' },
    });
    const again = await clients.admin.post(`/api/channels/${channel.id}/disconnect`);
    expect(again).toMatchObject({ status: 409, body: { code: 'CHANNEL_NOT_CONNECTED' } });
    // Un WORKING que ya estaba en la cola no lo vuelve a conectar: el camino es reconectar.
    expect(await scan(channel.session, channel.phone)).toBe(200);
    await processed(channel.session);
    expect(await channelRow(channel.id)).toMatchObject({
      status: 'disconnected',
      disconnect_reason: 'logged_out',
    });
  });

  it('desconectar uno que nunca se conectó → 409 (se cancela)', async () => {
    const channel = await createPending();
    const response = await clients.owner.post(`/api/channels/${channel.id}/disconnect`);
    expect(response).toMatchObject({ status: 409, body: { code: 'CHANNEL_NEVER_CONNECTED' } });
    expect((await channelRow(channel.id))!.status).toBe('pending');
  });

  it('reconectar: QR nuevo para el mismo canal, con su historial; el mismo teléfono vuelve a conectarlo', async () => {
    const channel = await createConnected();
    await withTenant(ctx, tenantA, async (c) => {
      const contact = await c.query<{ id: string }>(
        `INSERT INTO contacts (tenant_id, wa_id, first_seen_at, last_seen_at) VALUES ($1, $2, now(), now())
         RETURNING id`,
        [tenantA, `+${fakePhone()}`],
      );
      await c.query(
        `INSERT INTO conversations (tenant_id, channel_id, contact_id, last_message_at)
         VALUES ($1, $2, $3, now())`,
        [tenantA, channel.id, contact.rows[0]!.id],
      );
    });
    expect((await clients.owner.post(`/api/channels/${channel.id}/reconnect`)).status).toBe(409);
    await clients.owner.post(`/api/channels/${channel.id}/disconnect`);

    const response = await clients.owner.post(`/api/channels/${channel.id}/reconnect`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: channel.id, status: 'pending', disconnectReason: null });
    expect(fake.sessions.has(channel.session)).toBe(true);
    expect((await clients.owner.get(`/api/channels/${channel.id}/pairing`)).body).toMatchObject({
      state: 'qr',
    });
    expect(await scan(channel.session, channel.phone)).toBe(200);
    await waitFor(async () => (await channelRow(channel.id))?.status === 'connected');
    const { rows } = await ctx.ownerPool.query(
      'SELECT count(*)::int AS n FROM conversations WHERE channel_id = $1',
      [channel.id],
    );
    expect(rows[0].n).toBe(1);
    expect((await events(channel.id)).map((e) => [e.type, e.user_id])).toEqual([
      ['created', users.owner.id],
      ['connected', null],
      ['disconnected', users.owner.id],
      ['reconnect_requested', users.owner.id],
      ['connected', null],
    ]);
  });

  it('reconectar después de phone_mismatch limpia el motivo y la sesión vuelve a recibir', async () => {
    const channel = await createConnected();
    await scan(channel.session, `+${fakePhone()}`);
    await waitFor(async () => (await channelRow(channel.id))?.disconnect_reason === 'phone_mismatch');
    await waitFor(async () => !fake.sessions.has(channel.session));
    expect((await clients.owner.post(`/api/channels/${channel.id}/reconnect`)).status).toBe(200);
    const { rows } = await ctx.ownerPool.query('SELECT * FROM resolve_channel($1, $2)', [
      'waha',
      channel.session,
    ]);
    expect(rows).toHaveLength(1);
    // Un trabajo de cierre viejo que corra ahora no desvincula la sesión nueva.
    expect(await ctx.app.get(SessionCloseWorker).handle({ tenantId: tenantA, channelId: channel.id })).toBe(
      'sin_cambios',
    );
    expect(fake.sessions.has(channel.session)).toBe(true);
  });

  it('levantar la pausa: limpia la pausa, no toca la sesión y registra quién; sin pausa → 409', async () => {
    const channel = await createConnected();
    await ctx.ownerPool.query(
      `UPDATE channels SET sending_paused_until = 'infinity', sending_paused_reason = 'blocked_risk:463'
       WHERE id = $1`,
      [channel.id],
    );
    const listed = ((await clients.owner.get('/api/channels')).body!.items as Record<string, unknown>[]).find(
      (c) => c.id === channel.id,
    );
    expect(listed).toMatchObject({ sendingPause: { until: null, blockedRisk: true } });

    const response = await clients.admin.post(`/api/channels/${channel.id}/resume-sending`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'connected', sendingPause: null });
    expect((await channelRow(channel.id))!.sending_paused_until).toBeNull();
    expect((await events(channel.id)).at(-1)).toEqual({
      type: 'sending_resumed',
      user_id: users.admin.id,
      data: { previousReason: 'blocked_risk:463' },
    });
    const again = await clients.admin.post(`/api/channels/${channel.id}/resume-sending`);
    expect(again).toMatchObject({ status: 409, body: { code: 'CHANNEL_NOT_PAUSED' } });
  });

  it('cancelar: borra un canal que nunca se conectó y su sesión; uno con historial → 409', async () => {
    const pending = await createPending();
    expect((await clients.owner.request('DELETE', `/api/channels/${pending.id}`)).status).toBe(204);
    expect(await channelRow(pending.id)).toBeUndefined();
    expect(fake.sessions.has(pending.session)).toBe(false);

    const connected = await createConnected();
    expect(await clients.owner.request('DELETE', `/api/channels/${connected.id}`)).toMatchObject({
      status: 409,
      body: { code: 'CHANNEL_HAS_HISTORY' },
    });
    expect(await channelRow(connected.id)).toBeDefined();
  });
});

describe('tope de sesiones abiertas', () => {
  it('con 20 canales pending o connected, otra alta (o reconectar uno desconectado) → 409 CHANNEL_LIMIT', async () => {
    const owner = await createUser(ctx, 'canales-tope');
    const tenant = await createTenant(ctx, 'canales-tope', owner.id);
    const client = new HttpClient(ctx);
    expect((await client.signIn(owner.email)).status).toBe(200);
    await client.post('/api/auth/organization/set-active', { organizationId: tenant });
    const disconnected = await withTenant(ctx, tenant, async (c) => {
      for (let i = 0; i < 20; i++) {
        await c.query(
          `INSERT INTO channels (tenant_id, name, provider, connection_type, external_id, status,
             risk_accepted_at, risk_accepted_by)
           VALUES ($1, $2, 'waha', 'unofficial', $3, 'pending', now(), $4)`,
          [tenant, `Abierto ${i}`, `${ctx.prefix}_${uid()}`, owner.id],
        );
      }
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO channels (tenant_id, name, provider, connection_type, external_id, status,
           risk_accepted_at, risk_accepted_by)
         VALUES ($1, 'Desconectado', 'waha', 'unofficial', $2, 'disconnected', now(), $3) RETURNING id`,
        [tenant, `${ctx.prefix}_${uid()}`, owner.id],
      );
      return rows[0]!.id;
    });
    expect(await client.post('/api/channels', { name: 'Uno más' })).toMatchObject({
      status: 409,
      body: { code: 'CHANNEL_LIMIT' },
    });
    expect(await client.post(`/api/channels/${disconnected}/reconnect`)).toMatchObject({
      status: 409,
      body: { code: 'CHANNEL_LIMIT' },
    });
  });
});

describe('permisos', () => {
  it('seller y viewer → 403 en todo; otra empresa → 404', async () => {
    const channel = await createConnected();
    const calls = (client: HttpClient) => [
      client.post('/api/channels', { name: 'X' }),
      client.get(`/api/channels/${channel.id}/pairing`),
      client.post(`/api/channels/${channel.id}/reconnect`),
      client.post(`/api/channels/${channel.id}/disconnect`),
      client.post(`/api/channels/${channel.id}/resume-sending`),
      client.request('DELETE', `/api/channels/${channel.id}`),
    ];
    for (const key of ['seller', 'viewer'] as const) {
      for (const response of await Promise.all(calls(clients[key]))) expect(response.status).toBe(403);
    }
    const fromB = await Promise.all(calls(clients.ownerB).slice(1));
    for (const response of fromB)
      expect(response).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
    expect((await channelRow(channel.id))!.status).toBe('connected');
  });
});

describe('cola', () => {
  it('los workers toman JOBS_POLLING_SECONDS (inyectado por propiedad); creados a mano, el valor por defecto', () => {
    const polling = (worker: unknown) =>
      (worker as { workOptions(): { pollingIntervalSeconds: number } }).workOptions().pollingIntervalSeconds;
    expect(polling(ctx.app.get(InboundWorker))).toBe(0.5);
    expect(polling(ctx.app.get(SessionCloseWorker))).toBe(1);
    expect(polling(new InboundWorker({} as PgBoss, new Map(), {} as InboundService))).toBe(1);
  });
});

describe('migración (0019/0020)', () => {
  const insertPending = (c: pg.PoolClient, name: string) =>
    c.query(
      `INSERT INTO channels (tenant_id, name, provider, connection_type, external_id, status, risk_accepted_at,
         risk_accepted_by)
       VALUES ($1, $2, 'waha', 'unofficial', $3, 'pending', now(), $4) RETURNING id`,
      [tenantA, name, `${ctx.prefix}_${uid()}`, users.owner.id],
    );

  it('CHECK connected ⇒ número, varios pending sin número y columnas que la app no puede cambiar', async () => {
    await asApp(ctx, { tenantId: tenantA, userId: users.owner.id }, async (c) => {
      const one = await insertPending(c, 'Uno');
      await insertPending(c, 'Dos');
      const id = one.rows[0]!.id as string;
      expect(await errorCodeIn(c, "UPDATE channels SET status = 'connected' WHERE id = $1", [id])).toBe(
        '23514',
      );
      expect(await errorCodeIn(c, "UPDATE channels SET disconnect_reason = 'otro' WHERE id = $1", [id])).toBe(
        '23514',
      );
      expect(await errorCodeIn(c, "UPDATE channels SET external_id = 'x' WHERE id = $1", [id])).toBe('42501');
      expect(await errorCodeIn(c, "UPDATE channels SET provider = 'cloud_api' WHERE id = $1", [id])).toBe(
        '42501',
      );
      expect(
        await errorCodeIn(c, "UPDATE channels SET connection_type = 'official' WHERE id = $1", [id]),
      ).toBe('42501');
      expect(await errorCodeIn(c, 'UPDATE channels SET risk_accepted_by = NULL WHERE id = $1', [id])).toBe(
        '42501',
      );
      expect(await errorCodeIn(c, "UPDATE channel_events SET type = 'created'")).toBe('42501');
      expect(await errorCodeIn(c, 'DELETE FROM channel_events')).toBe('42501');
    });
  });

  it('DELETE solo de canales que nunca se conectaron, y channel_events aislado por empresa', async () => {
    const connected = await createConnected();
    const pendingB = await createPending(clients.ownerB, 'Pendiente B');
    await asApp(ctx, { tenantId: tenantA, userId: users.owner.id }, async (c) => {
      const deleted = await c.query('DELETE FROM channels WHERE id = $1', [connected.id]);
      expect(deleted.rowCount).toBe(0);
      expect((await c.query('DELETE FROM channels WHERE id = $1', [pendingB.id])).rowCount).toBe(0);
      expect(
        (await c.query('SELECT 1 FROM channel_events WHERE channel_id = $1', [pendingB.id])).rowCount,
      ).toBe(0);
      expect(
        await errorCodeIn(
          c,
          `INSERT INTO channel_events (tenant_id, channel_id, type) VALUES ($1, $2, 'created')`,
          [tenantB, pendingB.id],
        ),
      ).toBe('42501');
    });
    await asApp(ctx, {}, async (c) => {
      expect((await c.query('SELECT 1 FROM channel_events')).rowCount).toBe(0);
    });
  });
});
