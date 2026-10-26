// PresenceService (tarea 006): visto + "escribiendo…" antes de tener el texto, con las mismas reglas que
// un envío. Contra el Postgres local, con un proveedor falso.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_DB, type AppDatabase } from '../src/db/database.module.js';
import { PresenceService } from '../src/messaging/outbound/presence.service.js';
import { startTestContext, type TestContext } from './helpers.js';
import { createChannelTenant, createChat, FakeProvider, registryWith, uid } from './outbound-helpers.js';

let ctx: TestContext;
let db: AppDatabase;

beforeAll(async () => {
  ctx = await startTestContext();
  db = ctx.app.get<AppDatabase>(APP_DB);
});

afterAll(async () => {
  await ctx?.close();
});

async function chatWith(options: { blocked?: boolean; lastInboundAgo?: string } = {}) {
  return createChat(ctx, await createChannelTenant(ctx, uid().slice(0, 8)), options);
}

describe('PresenceService', () => {
  it('marca visto y pone "escribiendo…"; después lo saca', async () => {
    const chat = await chatWith();
    const provider = new FakeProvider();
    const service = new PresenceService(db, registryWith(provider));
    const before = Date.now();
    const since = await service.startTyping(chat.tenantId, chat.conversationId);
    expect(since).not.toBeNull();
    expect(since!.getTime()).toBeGreaterThanOrEqual(before);
    await service.stopTyping(chat.tenantId, chat.conversationId);
    expect(provider.calls.map((call) => call.method)).toEqual(['markSeen', 'startTyping', 'stopTyping']);
    expect(provider.calls[0]!.target).toEqual({ channelExternalId: chat.session, waId: chat.waId });
  });

  it('si no se podría enviar (contacto bloqueado, ventana vencida), no muestra nada', async () => {
    for (const chat of [await chatWith({ blocked: true }), await chatWith({ lastInboundAgo: '25 hours' })]) {
      const provider = new FakeProvider();
      const service = new PresenceService(db, registryWith(provider));
      expect(await service.startTyping(chat.tenantId, chat.conversationId)).toBeNull();
      expect(provider.calls).toEqual([]);
    }
  });

  async function channelOf(channelId: string) {
    const { rows } = await ctx.ownerPool.query(
      'SELECT status, sending_paused_until, sending_paused_reason FROM channels WHERE id = $1',
      [channelId],
    );
    return rows[0];
  }

  it('un error común del proveedor no frena: devuelve null sin lanzar ni tocar el canal', async () => {
    const chat = await chatWith();
    const provider = new FakeProvider();
    provider.presence = { ok: false, error: 'unknown_outcome', code: 'TimeoutError' };
    const service = new PresenceService(db, registryWith(provider));
    expect(await service.startTyping(chat.tenantId, chat.conversationId)).toBeNull();
    expect(await channelOf(chat.channelId)).toMatchObject({
      status: 'connected',
      sending_paused_until: null,
    });
  });

  it('riesgo de bloqueo (463) en el visto: corta, pausa el canal sin vencimiento y nada sale después', async () => {
    const chat = await chatWith();
    const provider = new FakeProvider();
    provider.presence = { ok: false, error: 'blocked_risk', code: '463' };
    const service = new PresenceService(db, registryWith(provider));
    expect(await service.startTyping(chat.tenantId, chat.conversationId)).toBeNull();
    // No sigue con el "escribiendo…" contra una sesión en riesgo.
    expect(provider.calls.map((call) => call.method)).toEqual(['markSeen']);
    const channel = await channelOf(chat.channelId);
    expect(channel.sending_paused_reason).toBe('blocked_risk:463');
    expect(String(channel.sending_paused_until)).toMatch(/infinity/i);
    // Con el canal pausado, la presencia siguiente ni llama al proveedor (y un envío quedaría rechazado).
    const again = new FakeProvider();
    expect(
      await new PresenceService(db, registryWith(again)).startTyping(chat.tenantId, chat.conversationId),
    ).toBeNull();
    expect(again.calls).toEqual([]);
  });

  it('sesión caída en la presencia: marca el canal desconectado', async () => {
    const chat = await chatWith();
    const provider = new FakeProvider();
    provider.presence = { ok: false, error: 'session_down', code: '404' };
    const service = new PresenceService(db, registryWith(provider));
    expect(await service.startTyping(chat.tenantId, chat.conversationId)).toBeNull();
    expect(await channelOf(chat.channelId)).toMatchObject({ status: 'disconnected' });
  });

  it('una conversación de otra empresa no existe', async () => {
    const a = await chatWith();
    const b = await chatWith();
    const provider = new FakeProvider();
    const service = new PresenceService(db, registryWith(provider));
    expect(await service.startTyping(b.tenantId, a.conversationId)).toBeNull();
    expect(provider.calls).toEqual([]);
  });
});
