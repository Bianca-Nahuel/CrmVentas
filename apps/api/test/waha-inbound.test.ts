// Verificación de la tarea 004: webhook de WAHA (firma, forma, cola) y worker (guardado idempotente,
// carrera, aislamiento entre empresas, session.status, logs sin datos personales).
// Contra la app levantada, con pg-boss y el worker reales. Números ficticios.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InboundWorker } from '../src/whatsapp/inbound/inbound.worker.js';
import {
  asApp,
  createTenant,
  createUser,
  postWahaWebhook,
  startTestContext,
  waitFor,
  withTenant,
  type TestContext,
} from './helpers.js';

interface Envelope {
  id: string;
  session: string;
  event: string;
  payload: Record<string, unknown>;
}

interface Channel {
  tenantId: string;
  channelId: string;
  session: string;
}

let ctx: TestContext;
let a: Channel;
let b: Channel;

function fixture(name: string): Envelope {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/whatsapp/waha/${name}.json`, import.meta.url), 'utf8'),
  ) as Envelope;
}

const uid = () => randomBytes(8).toString('hex');

/** Mensaje de texto de `phone` (solo dígitos) al canal, con ids únicos. */
function textEvent(
  channel: Channel,
  phone: string,
  options: { text?: string; timestamp?: number } = {},
): Envelope {
  const base = fixture('message-text');
  const messageKey = uid().toUpperCase();
  const from = `${phone}@c.us`;
  return {
    ...base,
    id: `evt_${uid()}`,
    session: channel.session,
    payload: {
      ...base.payload,
      id: `false_${from}_${messageKey}`,
      from,
      timestamp: options.timestamp ?? 1792800000,
      body: options.text ?? 'Hola, ¿tienen porcelanato 60x60?',
      _data: { key: { remoteJid: from, fromMe: false, id: messageKey }, pushName: 'Cliente Prueba' },
    },
  };
}

async function createChannel(label: string): Promise<Channel> {
  const ownerId = (await createUser(ctx, `waha-owner-${label}`)).id;
  const tenantId = await createTenant(ctx, `waha-${label}`, ownerId);
  const session = `${ctx.prefix}_waha_${label}`;
  const channelId = await withTenant(ctx, tenantId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO channels (tenant_id, name, phone_number, provider, connection_type, external_id,
         status, risk_accepted_at, risk_accepted_by)
       VALUES ($1, 'ventas', '+5491100000099', 'waha', 'unofficial', $2, 'pending', now(), $3)
       RETURNING id`,
      [tenantId, session, ownerId],
    );
    return rows[0]!.id;
  });
  return { tenantId, channelId, session };
}

/** Trabajos de la cola para un evento (por el id del sobre), leídos como dueño. */
async function jobsFor(eventId: string) {
  const { rows } = await ctx.ownerPool.query<{ state: string; retry_count: number }>(
    `SELECT state, retry_count FROM pgboss.job
     WHERE name = 'whatsapp-inbound' AND data->'payload'->>'id' = $1`,
    [eventId],
  );
  return rows;
}

async function waitCompleted(eventId: string, count = 1) {
  return waitFor(async () => {
    const jobs = await jobsFor(eventId);
    return jobs.length === count && jobs.every((job) => job.state === 'completed') && jobs;
  });
}

/** Mensajes de un contacto en un canal, vistos como ventas_app con la empresa activa (con RLS). */
async function messagesVisibleTo(tenantId: string, channelId: string, waId: string) {
  return asApp(ctx, { tenantId }, async (c) => {
    const { rows } = await c.query(
      `SELECT m.tenant_id, m.type, m.body, m.sent_at, m.raw, m.conversation_id, cv.contact_id,
              ct.wa_id, ct.profile_name, cv.last_message_at, cv.last_inbound_at, cv.updated_at
       FROM messages m
       JOIN conversations cv ON cv.id = m.conversation_id
       JOIN contacts ct ON ct.id = cv.contact_id
       WHERE m.channel_id = $1 AND ct.wa_id = $2
       ORDER BY m.created_at`,
      [channelId, waId],
    );
    return rows;
  });
}

// La cola vive en la misma base que desarrollo: si hay otra API corriendo (npm run dev:api), su worker
// toma los trabajos de estos tests y los logs que se verifican salen por otro proceso.
async function assertNoOtherWorker(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_MIGRATIONS, max: 1 });
  try {
    const { rows } = await pool.query<{ live: number }>(
      `SELECT count(*)::int AS live FROM pgboss.instance
       WHERE stopped_on IS NULL AND heartbeat_on > now() - make_interval(secs => heartbeat_seconds * 3)`,
    );
    if (rows[0]!.live > 0) {
      throw new Error(
        'Hay otra instancia de la API corriendo (npm run dev:api): bajala antes de correr los tests.',
      );
    }
  } finally {
    await pool.end();
  }
}

beforeAll(async () => {
  await assertNoOtherWorker();
  ctx = await startTestContext();
  a = await createChannel('a');
  b = await createChannel('b');
});

afterAll(async () => {
  // Los trabajos de esta corrida tienen datos ficticios, pero no se dejan en la cola.
  await ctx?.ownerPool.query(`DELETE FROM pgboss.job WHERE data->'payload'->>'session' LIKE $1`, [
    `${ctx.prefix}%`,
  ]);
  await ctx?.close();
});

describe('webhook: firma y forma', () => {
  it('1. firma válida → 200; ausente, inválida, otro algoritmo o cuerpo alterado → 401', async () => {
    const body = JSON.stringify(textEvent(a, '5491100000101'));
    expect(await postWahaWebhook(ctx, body)).toBe(200);
    expect(await postWahaWebhook(ctx, body, { hmac: null })).toBe(401);
    expect(await postWahaWebhook(ctx, body, { hmac: 'ab'.repeat(64) })).toBe(401);
    expect(await postWahaWebhook(ctx, body, { algorithm: 'sha256' })).toBe(401);
    const tampered = body.replace('porcelanato', 'cerámico');
    expect(await postWahaWebhook(ctx, tampered, { signedBody: body })).toBe(401);
  });

  it('la respuesta 401 no da detalles', async () => {
    const response = await fetch(`${ctx.baseUrl}/api/webhooks/waha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: 'Unauthorized', statusCode: 401 });
  });

  it('cuerpo de más de 1 MB → 413', async () => {
    const big = JSON.stringify({ ...textEvent(a, '5491100000102'), padding: 'x'.repeat(1_100_000) });
    expect(await postWahaWebhook(ctx, big)).toBe(413);
  });

  it('2. forma inválida → 400; evento no procesado → 200 sin trabajo en la cola', async () => {
    expect(await postWahaWebhook(ctx, 'no es json')).toBe(400);
    expect(await postWahaWebhook(ctx, JSON.stringify({ event: 'message', session: a.session }))).toBe(400);

    const presence = { ...fixture('presence-update'), id: `evt_${uid()}`, session: a.session };
    expect(await postWahaWebhook(ctx, JSON.stringify(presence))).toBe(200);
    expect(await jobsFor(presence.id)).toHaveLength(0);
  });

  it('las rutas JSON comunes siguen parseando el cuerpo', async () => {
    const response = await fetch(`${ctx.baseUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ctx.env.BETTER_AUTH_URL },
      body: JSON.stringify({ email: `${ctx.prefix}-nadie@example.test`, password: 'x'.repeat(12) }),
    });
    expect(response.status).toBe(401); // credenciales inválidas, no 400 por cuerpo vacío
  });
});

describe('worker: guardado', () => {
  const phone = '5491100000201';
  const text = 'Texto privado de prueba 7f3a';
  let output = '';

  it('4 y 5. se guarda una sola vez en la empresa del canal, sin datos personales en los logs', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      const event = textEvent(a, phone, { text, timestamp: 1792800100 });
      const body = JSON.stringify(event);
      expect(await postWahaWebhook(ctx, body)).toBe(200);
      await waitCompleted(event.id);

      const [first] = await messagesVisibleTo(a.tenantId, a.channelId, `+${phone}`);
      expect(first).toMatchObject({
        tenant_id: a.tenantId,
        type: 'text',
        body: text,
        wa_id: `+${phone}`,
        profile_name: 'Cliente Prueba',
      });
      expect(new Date(first.sent_at).toISOString()).toBe(new Date(1792800100 * 1000).toISOString());
      expect(first.raw).toEqual(event);
      expect(new Date(first.last_message_at).getTime()).toBe(1792800100 * 1000);

      // 5. El mismo evento otra vez: sigue habiendo un mensaje y last_message_at no cambia.
      expect(await postWahaWebhook(ctx, body)).toBe(200);
      await waitCompleted(event.id, 2);
      const again = await messagesVisibleTo(a.tenantId, a.channelId, `+${phone}`);
      expect(again).toHaveLength(1);
      expect(again[0].last_message_at).toEqual(first.last_message_at);
      // Ni siquiera se escribe la conversación (un UPDATE cambiaría updated_at por el trigger).
      expect(again[0].updated_at).toEqual(first.updated_at);
    } finally {
      stdout.mockRestore();
    }

    // 12. En la salida hay resultados (guardado, duplicado), pero ni teléfono ni texto ni nombre.
    expect(output).toContain('guardado');
    expect(output).toContain('duplicado');
    expect(output).not.toContain(phone);
    expect(output).not.toContain(text);
    expect(output).not.toContain('Cliente Prueba');
  });

  it('6. un segundo mensaje del mismo contacto va a la misma conversación y al mismo contacto', async () => {
    const event = textEvent(a, phone, { text: 'segundo', timestamp: 1792800200 });
    expect(await postWahaWebhook(ctx, JSON.stringify(event))).toBe(200);
    await waitCompleted(event.id);
    const rows = await messagesVisibleTo(a.tenantId, a.channelId, `+${phone}`);
    expect(rows).toHaveLength(2);
    expect(rows[1].conversation_id).toBe(rows[0].conversation_id);
    expect(rows[1].contact_id).toBe(rows[0].contact_id);
    expect(new Date(rows[1].last_inbound_at).getTime()).toBe(1792800200 * 1000);
  });

  it('7. carrera: dos eventos del mismo contacto nuevo en paralelo → 1 contacto y 1 conversación', async () => {
    const worker = ctx.app.get(InboundWorker);
    for (let round = 0; round < 10; round++) {
      const racePhone = `54911003${String(round).padStart(5, '0')}`;
      await Promise.all(
        [1, 2].map((n) =>
          worker.handle(
            { provider: 'waha', payload: textEvent(a, racePhone, { text: `carrera ${n}` }) },
            { id: `test-${round}-${n}`, retryCount: 0, retryLimit: 10 },
          ),
        ),
      );
      const counts = await asApp(ctx, { tenantId: a.tenantId }, async (c) => {
        const { rows } = await c.query<{ contacts: number; open: number; messages: number }>(
          `SELECT
             (SELECT count(*)::int FROM contacts WHERE wa_id = $1) AS contacts,
             (SELECT count(*)::int FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id
                WHERE ct.wa_id = $1 AND cv.status = 'open') AS open,
             (SELECT count(*)::int FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
                JOIN contacts ct ON ct.id = cv.contact_id WHERE ct.wa_id = $1) AS messages`,
          [`+${racePhone}`],
        );
        return rows[0]!;
      });
      expect(counts).toEqual({ contacts: 1, open: 1, messages: 2 });
    }
  });

  it('8. aislamiento: cada mensaje solo es visible en la empresa de su canal', async () => {
    const toA = textEvent(a, '5491100000301', { text: 'para A' });
    const toB = textEvent(b, '5491100000301', { text: 'para B' });
    expect(await postWahaWebhook(ctx, JSON.stringify(toA))).toBe(200);
    expect(await postWahaWebhook(ctx, JSON.stringify(toB))).toBe(200);
    await waitCompleted(toA.id);
    await waitCompleted(toB.id);

    const bodiesIn = (tenantId: string) =>
      asApp(ctx, { tenantId }, async (c) => {
        const { rows } = await c.query<{ body: string; tenant_id: string }>(
          `SELECT body, tenant_id FROM messages WHERE body IN ('para A', 'para B')`,
        );
        return rows;
      });
    expect(await bodiesIn(a.tenantId)).toEqual([{ body: 'para A', tenant_id: a.tenantId }]);
    expect(await bodiesIn(b.tenantId)).toEqual([{ body: 'para B', tenant_id: b.tenantId }]);
  });

  it('un texto con U+0000 se guarda sin ese carácter (jsonb no lo admite)', async () => {
    const nulPhone = '5491100000501';
    const event = textEvent(a, nulPhone, { text: 'antes\u0000después' });
    expect(await postWahaWebhook(ctx, JSON.stringify(event))).toBe(200);
    await waitCompleted(event.id);
    const [saved] = await messagesVisibleTo(a.tenantId, a.channelId, `+${nulPhone}`);
    expect(saved.body).toBe('antesdespués');
  });

  it('9. sesión desconocida → 200, nada guardado, descartado sin reintentos', async () => {
    const unknown = {
      ...textEvent(a, '5491100000401', { text: 'huérfano' }),
      session: `${ctx.prefix}_nadie`,
    };
    let output = '';
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      expect(await postWahaWebhook(ctx, JSON.stringify(unknown))).toBe(200);
      const [job] = await waitCompleted(unknown.id);
      expect(job!.retry_count).toBe(0);
    } finally {
      stdout.mockRestore();
    }
    expect(output).toContain('descartado');
    const { rows } = await ctx.ownerPool.query(`SELECT 1 FROM messages WHERE body = 'huérfano'`);
    expect(rows).toHaveLength(0);
  });

  it('10. session.status → cambia channels.status', async () => {
    const status = { ...fixture('session-status-working'), id: `evt_${uid()}`, session: b.session };
    expect(await postWahaWebhook(ctx, JSON.stringify(status))).toBe(200);
    await waitCompleted(status.id);
    const channelStatus = await asApp(ctx, { tenantId: b.tenantId }, async (c) => {
      const { rows } = await c.query<{ status: string }>('SELECT status FROM channels WHERE id = $1', [
        b.channelId,
      ]);
      return rows[0]!.status;
    });
    expect(channelStatus).toBe('connected');
  });

  it('eventos ignorados (propios, grupos, estados, newsletters) no guardan nada', async () => {
    const worker = ctx.app.get(InboundWorker);
    for (const name of ['message-from-me', 'message-group', 'message-status', 'message-newsletter']) {
      await worker.handle(
        { provider: 'waha', payload: { ...fixture(name), session: a.session } },
        { id: name, retryCount: 0, retryLimit: 10 },
      );
    }
    const { rows } = await ctx.ownerPool.query(
      `SELECT 1 FROM messages WHERE channel_id = $1 AND body IN
         ('Respuesta del vendedor', 'Mensaje en un grupo', 'Un estado', 'Publicación de un canal')`,
      [a.channelId],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('11. permisos sobre la cola', () => {
  it('ventas_auth sin acceso al schema de pg-boss; ventas_app sin CREATE en ningún schema', async () => {
    const { rows } = await ctx.ownerPool.query<{ auth_usage: boolean; app_create: number }>(
      `SELECT has_schema_privilege('ventas_auth', 'pgboss', 'USAGE') AS auth_usage,
              (SELECT count(*)::int FROM pg_namespace
                WHERE has_schema_privilege('ventas_app', oid, 'CREATE')) AS app_create`,
    );
    expect(rows[0]).toEqual({ auth_usage: false, app_create: 0 });
  });

  it('ventas_app no puede alterar ni borrar las tablas de pg-boss', async () => {
    for (const statement of ['ALTER TABLE pgboss.job_common ADD COLUMN x int', 'DROP TABLE pgboss.queue']) {
      await expect(ctx.pools.appPool.query(statement)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('la cola tiene la retención de 24 h y los reintentos de la migración 0005', async () => {
    const { rows } = await ctx.ownerPool.query(
      `SELECT retry_limit, retry_delay, retry_backoff, retry_delay_max, retention_seconds, deletion_seconds
       FROM pgboss.queue WHERE name = 'whatsapp-inbound'`,
    );
    expect(rows[0]).toEqual({
      retry_limit: 10,
      retry_delay: 5,
      retry_backoff: true,
      retry_delay_max: 300,
      retention_seconds: 86400,
      deletion_seconds: 86400,
    });
  });

  it('ventas_auth no puede leer trabajos', async () => {
    await expect(ctx.pools.authPool.query('SELECT 1 FROM pgboss.job LIMIT 1')).rejects.toMatchObject({
      code: '42501',
    });
  });
});
