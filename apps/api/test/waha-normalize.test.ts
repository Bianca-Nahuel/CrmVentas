// Normalización de payloads de WAHA a eventos internos (funciones puras, sin base ni red).
import { readFileSync } from 'node:fs';
import type { MessageReceivedEvent } from '@ventas/shared';
import { describe, expect, it } from 'vitest';
import {
  normalizeWahaEvent,
  toE164,
  type NormalizeResult,
} from '../src/whatsapp/providers/waha/waha-normalize.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/whatsapp/waha/${name}.json`, import.meta.url), 'utf8'));
}

function message(result: NormalizeResult): MessageReceivedEvent {
  if (result.kind !== 'event' || result.event.type !== 'message.received') {
    throw new Error(`Se esperaba message.received y llegó ${JSON.stringify(result)}`);
  }
  return result.event;
}

describe('normalizeWahaEvent: mensajes', () => {
  it('texto → text con body, contacto en E.164, sent_at del payload y raw completo', () => {
    const raw = fixture('message-text');
    const event = message(normalizeWahaEvent(raw));
    expect(event).toMatchObject({
      provider: 'waha',
      channelExternalId: 'ch_session_de_prueba',
      eventId: 'evt_01jabcdefghjkmnpqrstvwxyz0',
      externalMessageId: 'false_5491100000001@c.us_AAA0000000000000000000000000001',
      contact: { waId: '+5491100000001', profileName: 'Cliente Prueba' },
      messageType: 'text',
      body: 'Hola, ¿tienen porcelanato 60x60?',
      sentAt: new Date(1792800000 * 1000).toISOString(),
    });
    expect(event.raw).toEqual(raw);
  });

  it('imagen con epígrafe → image con el epígrafe como body', () => {
    const event = message(normalizeWahaEvent(fixture('message-image-caption')));
    expect(event.messageType).toBe('image');
    expect(event.body).toBe('Este modelo');
  });

  it('audio → audio sin body', () => {
    const event = message(normalizeWahaEvent(fixture('message-audio')));
    expect(event.messageType).toBe('audio');
    expect(event.body).toBeNull();
  });

  it('ubicación (solo en _data del engine) → location', () => {
    const event = message(normalizeWahaEvent(fixture('message-location')));
    expect(event.messageType).toBe('location');
    expect(event.body).toBeNull();
  });

  it('video y documento según el mimetype; sticker → other', () => {
    const base = fixture('message-image-caption') as { payload: Record<string, unknown> };
    const withMedia = (mimetype: string, data: Record<string, unknown> = {}) => ({
      ...base,
      payload: { ...base.payload, body: '', media: { url: null, mimetype }, _data: { message: data } },
    });
    expect(message(normalizeWahaEvent(withMedia('video/mp4'))).messageType).toBe('video');
    expect(message(normalizeWahaEvent(withMedia('application/pdf'))).messageType).toBe('document');
    expect(
      message(normalizeWahaEvent(withMedia('image/webp', { stickerMessage: { mimetype: 'image/webp' } })))
        .messageType,
    ).toBe('other');
  });

  it('LID con remoteJidAlt → E.164', () => {
    const event = message(normalizeWahaEvent(fixture('message-lid-with-alt')));
    expect(event.contact.waId).toBe('+5491100000004');
    expect(event.contact.profileName).toBe('Cliente LID');
  });

  it('LID sin número → identificador opaco <n>@lid', () => {
    const event = message(normalizeWahaEvent(fixture('message-lid-without-alt')));
    expect(event.contact.waId).toBe('100000000000002@lid');
  });

  it.each([
    ['message-from-me', 'from_me'],
    ['message-group', 'group'],
    ['message-status', 'status'],
    ['message-newsletter', 'newsletter'],
  ])('%s → ignorado (%s)', (name, reason) => {
    expect(normalizeWahaEvent(fixture(name))).toEqual({
      kind: 'ignored',
      reason,
      eventId: 'evt_01jabcdefghjkmnpqrstvwxyz0',
    });
  });

  it('eventos no procesados → ignorados', () => {
    expect(normalizeWahaEvent(fixture('presence-update'))).toMatchObject({
      kind: 'ignored',
      reason: 'unsupported_event',
    });
  });

  it('payload de mensaje inválido → ignorado (no se reintenta lo que nunca va a pasar)', () => {
    const base = fixture('message-text') as { payload: Record<string, unknown> };
    expect(normalizeWahaEvent({ ...base, payload: { ...base.payload, timestamp: 'ayer' } })).toMatchObject({
      kind: 'ignored',
      reason: 'invalid_payload',
    });
    expect(normalizeWahaEvent({ ...base, payload: { ...base.payload, timestamp: 1e20 } })).toMatchObject({
      kind: 'ignored',
      reason: 'invalid_payload',
    });
    expect(normalizeWahaEvent({ ...base, payload: { ...base.payload, from: 'abc@c.us' } })).toMatchObject({
      kind: 'ignored',
      reason: 'invalid_sender',
    });
  });
});

describe('normalizeWahaEvent: session.status', () => {
  it('WORKING → connected', () => {
    expect(normalizeWahaEvent(fixture('session-status-working'))).toEqual({
      kind: 'event',
      event: {
        type: 'session.status',
        provider: 'waha',
        channelExternalId: 'ch_session_de_prueba',
        eventId: 'evt_01jabcdefghjkmnpqrstvwxyz0',
        status: 'connected',
      },
    });
  });

  it.each([
    ['STARTING', 'pending'],
    ['SCAN_QR_CODE', 'pending'],
    ['PASSKEY_REQUIRED', 'pending'],
    ['PASSKEY_CONFIRMATION_REQUIRED', 'pending'],
    ['STOPPED', 'disconnected'],
    ['FAILED', 'disconnected'],
  ])('%s → %s', (wahaStatus, status) => {
    const base = fixture('session-status-working') as { payload: Record<string, unknown> };
    const result = normalizeWahaEvent({ ...base, payload: { ...base.payload, status: wahaStatus } });
    expect(result).toMatchObject({ kind: 'event', event: { status } });
  });

  it('estado desconocido → ignorado', () => {
    const base = fixture('session-status-working') as { payload: Record<string, unknown> };
    expect(normalizeWahaEvent({ ...base, payload: { status: 'NUEVO' } })).toMatchObject({
      kind: 'ignored',
      reason: 'unknown_status',
    });
  });
});

describe('toE164', () => {
  it.each([
    ['5491100000001@c.us', '+5491100000001'],
    ['5491100000001@s.whatsapp.net', '+5491100000001'],
    ['5491100000001', '+5491100000001'],
    ['5491100000001:12@s.whatsapp.net', '+5491100000001'],
  ])('%s → %s', (input, expected) => {
    expect(toE164(input)).toBe(expected);
  });

  it.each(['abc@c.us', '0123456789@c.us', '12345@c.us', '1234567890123456@c.us', '100000000000001@lid'])(
    '%s → null',
    (input) => {
      expect(toE164(input)).toBeNull();
    },
  );
});
