// Normalización de payloads de WAHA a eventos internos (funciones puras, sin base ni red).
import { readFileSync } from 'node:fs';
import type { MessageReceivedEvent } from '@ventas/shared';
import { describe, expect, it } from 'vitest';
import {
  canonicalMessageId,
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
      // Id canónico: sin el chat (el mismo mensaje puede llegar con @c.us o con @lid).
      externalMessageId: 'false_AAA0000000000000000000000000001',
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

describe('normalizeWahaEvent: ecos (fromMe) y acuses (tarea 005)', () => {
  it('eco: el chat sale de _data.key.remoteJid; un mensaje a nuestro propio número se ignora', () => {
    const base = fixture('message-from-me') as { payload: Record<string, unknown> };
    const withKey = (remoteJid: string) => ({
      ...base,
      payload: {
        ...base.payload,
        _data: { key: { remoteJid, fromMe: true, id: 'AAA0000000000000000000000000005' } },
      },
    });
    expect(normalizeWahaEvent(withKey('5491100000007@s.whatsapp.net'))).toMatchObject({
      event: { type: 'message.echo', contact: { waId: '+5491100000007' } },
    });
    expect(normalizeWahaEvent(withKey('5491100000099@s.whatsapp.net'))).toMatchObject({
      kind: 'ignored',
      reason: 'self_chat',
    });
  });

  it('message con fromMe → message.echo, contacto = el chat y sin nombre (el pushName es el nuestro)', () => {
    const result = normalizeWahaEvent(fixture('message-from-me'));
    expect(result).toMatchObject({
      kind: 'event',
      event: {
        type: 'message.echo',
        externalMessageId: 'true_AAA0000000000000000000000000005',
        contact: { waId: '+5491100000001', profileName: null },
        messageType: 'text',
        body: 'Respuesta del vendedor',
      },
    });
  });

  it('message.any con fromMe en un chat @lid → el número de remoteJidAlt, nunca senderPn (el nuestro)', () => {
    const result = normalizeWahaEvent(fixture('message-any-from-me-lid'));
    expect(result).toMatchObject({
      kind: 'event',
      event: {
        type: 'message.echo',
        externalMessageId: 'true_AAA0000000000000000000000000006',
        contact: { waId: '+5491100000004', profileName: null },
      },
    });
  });

  it('message.any entrante → message.received (mismo resultado que message)', () => {
    const base = fixture('message-text') as Record<string, unknown>;
    expect(message(normalizeWahaEvent({ ...base, event: 'message.any' })).externalMessageId).toBe(
      'false_AAA0000000000000000000000000001',
    );
  });

  it.each([
    [-1, 'failed'],
    [1, 'sent'],
    [2, 'delivered'],
    [3, 'read'],
    [4, 'read'],
  ])('message.ack %i → %s', (ack, status) => {
    const base = fixture('message-ack-read') as { payload: Record<string, unknown> };
    expect(normalizeWahaEvent({ ...base, payload: { ...base.payload, ack } })).toEqual({
      kind: 'event',
      event: {
        type: 'message.status',
        provider: 'waha',
        channelExternalId: 'ch_session_de_prueba',
        eventId: 'evt_01jabcdefghjkmnpqrstvwxyz0',
        externalMessageId: 'true_AAA0000000000000000000000000005',
        status,
      },
    });
  });

  it('acuses ignorados: PENDING, de entrantes (los genera nuestro sendSeen) y de grupos', () => {
    const base = fixture('message-ack-read') as { payload: Record<string, unknown> };
    const withPayload = (payload: Record<string, unknown>) =>
      normalizeWahaEvent({ ...base, payload: { ...base.payload, ...payload } });
    expect(withPayload({ ack: 0 })).toMatchObject({ kind: 'ignored', reason: 'ack_pending' });
    expect(withPayload({ fromMe: false })).toMatchObject({ kind: 'ignored', reason: 'ack_not_from_me' });
    expect(withPayload({ from: '120363000000000000@g.us' })).toMatchObject({
      kind: 'ignored',
      reason: 'group',
    });
    expect(withPayload({ ack: 'x' })).toMatchObject({ kind: 'ignored', reason: 'invalid_payload' });
  });
});

describe('canonicalMessageId', () => {
  it.each([
    ['true_5491100000001@c.us_ABC123', 'true_ABC123'],
    ['true_100000000000002@lid_ABC123', 'true_ABC123'],
    ['false_5491100000001@c.us_ABC123', 'false_ABC123'],
    ['false_120363000000000000@g.us_ABC123_5491100000001@c.us', 'false_ABC123'],
    ['otro-formato', 'otro-formato'],
  ])('%s → %s', (input, expected) => {
    expect(canonicalMessageId(input)).toBe(expected);
  });
});
