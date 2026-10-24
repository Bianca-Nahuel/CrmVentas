// Worker de whatsapp-inbound con dependencias falsas (sin base ni cola): orden de los pasos, errores
// sin datos personales y log del último intento.
import { readFileSync } from 'node:fs';
import type { PgBoss } from 'pg-boss';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboundService } from '../src/whatsapp/inbound/inbound.service.js';
import { InboundWorker } from '../src/whatsapp/inbound/inbound.worker.js';
import type { WhatsAppProvider, WhatsAppProviderRegistry } from '../src/whatsapp/provider.js';
import { normalizeWahaEvent } from '../src/whatsapp/providers/waha/waha-normalize.js';

const payload = JSON.parse(
  readFileSync(new URL('./fixtures/whatsapp/waha/message-text.json', import.meta.url), 'utf8'),
);

function setup(service: Partial<InboundService>) {
  const enrich = vi.fn(async (event) => event);
  const provider: WhatsAppProvider = {
    id: 'waha',
    capabilities: {
      templates: false,
      within24hWindowOnly: false,
      adAttribution: false,
      outboundCampaigns: false,
    },
    normalize: normalizeWahaEvent,
    enrich,
    sendText: vi.fn(),
    markSeen: vi.fn(),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
  const registry: WhatsAppProviderRegistry = new Map([['waha', provider]]);
  const worker = new InboundWorker({} as PgBoss, registry, service as InboundService);
  return { worker, enrich };
}

function captureOutput() {
  // Logger.log/warn escriben en stdout y Logger.error en stderr.
  let output = '';
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
  }
  return { read: () => output };
}

afterEach(() => vi.restoreAllMocks());

describe('InboundWorker.handle', () => {
  it('canal desconocido → descartado, sin consultar al proveedor ni guardar', async () => {
    const process = vi.fn();
    const { worker, enrich } = setup({ resolveChannel: vi.fn(async () => null), process });
    const out = captureOutput();
    await worker.handle({ provider: 'waha', payload }, { id: 'j1', retryCount: 0, retryLimit: 10 });
    expect(enrich).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
    expect(out.read()).toContain('descartado');
  });

  it('un error de base se re-lanza solo con el código, sin la consulta ni sus parámetros', async () => {
    // Así se ven los errores de Drizzle: la consulta y los parámetros en el mensaje, el código en cause.
    const dbError = Object.assign(
      new Error('Failed query: insert into "contacts" ... params: +5491100000001,Hola, ¿tienen porcelanato?'),
      { cause: { code: '57P01' } },
    );
    const { worker } = setup({
      resolveChannel: vi.fn(async () => ({ channelId: 'c', tenantId: 't' })),
      process: vi.fn(async () => {
        throw dbError;
      }),
    });
    const out = captureOutput();
    const attempt = worker.handle({ provider: 'waha', payload }, { id: 'j2', retryCount: 3, retryLimit: 10 });
    await expect(attempt).rejects.toThrow(/^Falló el procesamiento \(código 57P01\)$/);
    expect(out.read()).toContain('reintento');
    expect(out.read()).not.toContain('5491100000001');
  });

  it('el último intento fallido se registra como fallido', async () => {
    const { worker } = setup({
      resolveChannel: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    });
    const out = captureOutput();
    await expect(
      worker.handle({ provider: 'waha', payload }, { id: 'j3', retryCount: 10, retryLimit: 10 }),
    ).rejects.toThrow('Falló el procesamiento (código Error)');
    expect(out.read()).toContain('fallido');
    expect(out.read()).not.toContain('ECONNREFUSED');
  });
});
