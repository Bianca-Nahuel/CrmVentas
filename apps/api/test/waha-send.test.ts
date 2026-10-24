// Envío por WAHA (tarea 005): pedidos a la API, traducción de errores y lectura de la respuesta de
// sendText. fetch falso, sin red.
import { describe, expect, it } from 'vitest';
import { WahaClient } from '../src/whatsapp/providers/waha/waha-client.js';
import { classifyWahaFailure, toSendResult, wahaChatId } from '../src/whatsapp/providers/waha/waha-send.js';
import { WahaProvider } from '../src/whatsapp/providers/waha/waha.provider.js';

interface Call {
  url: string;
  body: unknown;
}

function provider(respond: () => Promise<Response> | Response, calls: Call[] = []) {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return respond();
  }) as typeof fetch;
  return new WahaProvider(new WahaClient('http://waha:3000', 'k', fetchImpl));
}

const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });
const networkError = (code: string) => () => {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code } });
};

const target = { channelExternalId: 'ch_abc', waId: '+5491100000001' };

// Respuesta de NOWEB: el mensaje de Baileys.
const baileysMessage = {
  key: { remoteJid: '5491100000001@s.whatsapp.net', fromMe: true, id: '3EB0ABCDEF0123456789' },
  messageTimestamp: 1792800000,
  status: 1,
};

describe('wahaChatId', () => {
  it.each([
    ['+5491100000001', '5491100000001@c.us'],
    ['100000000000002@lid', '100000000000002@lid'],
    ['5491100000001', null],
    ['120363000000000000@g.us', null],
  ])('%s → %s', (waId, expected) => {
    expect(wahaChatId(waId)).toBe(expected);
  });
});

describe('WahaProvider: pedidos', () => {
  it('sendText → POST /api/sendText con session, chatId y text; id canónico true_<key.id>', async () => {
    const calls: Call[] = [];
    const result = await provider(json(201, baileysMessage), calls).sendText({ ...target, text: 'Hola' });
    expect(result).toEqual({
      ok: true,
      externalId: 'true_3EB0ABCDEF0123456789',
      sentAt: new Date(1792800000 * 1000).toISOString(),
    });
    expect(calls).toEqual([
      {
        url: 'http://waha:3000/api/sendText',
        body: { session: 'ch_abc', chatId: '5491100000001@c.us', text: 'Hola', linkPreview: false },
      },
    ]);
  });

  it('visto → sendSeen con los ids originales de los entrantes (NOWEB sin store), con el chat como llegó', async () => {
    const calls: Call[] = [];
    const waha = provider(json(200, { result: true }), calls);
    // El contacto se guardó con su número, pero el chat llegó como @lid: vale el id original.
    const inbound = (key: string) => ({
      externalId: `false_${key}`,
      raw: { payload: { id: `false_100000000000002@lid_${key}`, from: '100000000000002@lid' } },
    });
    expect(
      await waha.markSeen({
        ...target,
        messages: [inbound('AAA1'), inbound('AAA2'), { externalId: 'x', raw: {} }],
      }),
    ).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        url: 'http://waha:3000/api/sendSeen',
        body: {
          session: 'ch_abc',
          chatId: '100000000000002@lid',
          messageIds: ['false_100000000000002@lid_AAA1', 'false_100000000000002@lid_AAA2'],
        },
      },
    ]);
  });

  it('visto sin entrantes legibles → no llama a WAHA', async () => {
    const calls: Call[] = [];
    expect(await provider(json(200, {}), calls).markSeen({ ...target, messages: [] })).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });

  it('escribiendo y dejar de escribir → startTyping y stopTyping con session y chatId', async () => {
    const calls: Call[] = [];
    const waha = provider(json(200, { result: true }), calls);
    const lid = { channelExternalId: 'ch_abc', waId: '100000000000002@lid' };
    expect(await waha.startTyping(lid)).toEqual({ ok: true });
    expect(await waha.stopTyping(lid)).toEqual({ ok: true });
    const body = { session: 'ch_abc', chatId: '100000000000002@lid' };
    expect(calls).toEqual([
      { url: 'http://waha:3000/api/startTyping', body },
      { url: 'http://waha:3000/api/stopTyping', body },
    ]);
  });

  it('wa_id inválido → invalid_recipient sin llamar a WAHA', async () => {
    const calls: Call[] = [];
    const result = await provider(json(201, baileysMessage), calls).sendText({
      channelExternalId: 'ch_abc',
      waId: 'basura',
      text: 'x',
    });
    expect(result).toEqual({ ok: false, error: 'invalid_recipient', code: 'invalid_chat_id' });
    expect(calls).toHaveLength(0);
  });
});

describe('WahaProvider: errores de sendText', () => {
  it.each([
    ['no se pudo conectar (ECONNREFUSED)', networkError('ECONNREFUSED'), 'transient', 'ECONNREFUSED'],
    ['DNS (ENOTFOUND)', networkError('ENOTFOUND'), 'transient', 'ENOTFOUND'],
    [
      'conexión cortada (ECONNRESET): pudo haber salido',
      networkError('ECONNRESET'),
      'unknown_outcome',
      'ECONNRESET',
    ],
    [
      'timeout: pudo haber salido',
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
      'unknown_outcome',
      'TimeoutError',
    ],
    ['500', json(500, { message: 'boom' }), 'unknown_outcome', 'http_500'],
    ['502', json(502, {}), 'unknown_outcome', 'http_502'],
    [
      '422 (sesión no WORKING)',
      json(422, { message: 'Session status is not as expected' }),
      'session_down',
      'http_422',
    ],
    ['404 (sesión inexistente)', json(404, {}), 'session_down', 'http_404'],
    ['429', json(429, {}), 'rate_limited', 'http_429'],
    ['400', json(400, { message: 'bad chatId' }), 'invalid_recipient', 'http_400'],
    ['401 (API key): WAHA respondió, no se reintenta', json(401, {}), 'unknown_outcome', 'http_401'],
    ['408 de un proxy', json(408, {}), 'unknown_outcome', 'http_408'],
    ['302', json(302, {}), 'unknown_outcome', 'http_302'],
    [
      'un 475 suelto (línea de un stack) no es riesgo de bloqueo',
      json(500, { stack: 'at send (/app/dist/index.js:475:12)' }),
      'unknown_outcome',
      'http_500',
    ],
    [
      '463 (restricción por contactos nuevos)',
      json(500, { message: 'server returned error 463' }),
      'blocked_risk',
      'waha_463',
    ],
    [
      '475 (cuota del ciclo)',
      json(400, { exception: { message: 'server returned error 475' } }),
      'blocked_risk',
      'waha_475',
    ],
    ['200 sin id legible: pudo haber salido', json(200, { ok: true }), 'unknown_outcome', 'no_message_id'],
    ['200 que no es JSON', () => new Response('<html>', { status: 200 }), 'unknown_outcome', 'no_message_id'],
  ])('%s → %s', async (_label, respond, error, code) => {
    expect(await provider(respond).sendText({ ...target, text: 'Hola' })).toEqual({ ok: false, error, code });
  });

  it('los errores no llevan el texto, el teléfono ni la respuesta de WAHA', async () => {
    const result = await provider(json(500, { message: 'error con +5491100000001 y Hola' })).sendText({
      ...target,
      text: 'Hola',
    });
    expect(JSON.stringify(result)).not.toMatch(/5491100000001|Hola/);
  });
});

describe('toSendResult / classifyWahaFailure', () => {
  it('id serializado de otros engines → canónico', () => {
    expect(
      toSendResult({
        kind: 'response',
        status: 201,
        text: JSON.stringify({ id: 'true_5491100000001@c.us_ABC' }),
      }),
    ).toMatchObject({ ok: true, externalId: 'true_ABC' });
    expect(
      toSendResult({
        kind: 'response',
        status: 201,
        text: JSON.stringify({ id: { _serialized: 'true_100000000000002@lid_ABC' } }),
      }),
    ).toMatchObject({ ok: true, externalId: 'true_ABC' });
  });

  it('messageTimestamp como Long o string; sin timestamp, la hora actual', () => {
    const now = new Date('2026-10-24T12:00:00Z'); // distinta del timestamp del mensaje
    const withTimestamp = (messageTimestamp: unknown) =>
      toSendResult(
        { kind: 'response', status: 201, text: JSON.stringify({ ...baileysMessage, messageTimestamp }) },
        () => now,
      );
    expect(withTimestamp({ low: 1792800000, high: 0 })).toMatchObject({ sentAt: '2026-10-24T00:00:00.000Z' });
    expect(withTimestamp('1792800000')).toMatchObject({ sentAt: '2026-10-24T00:00:00.000Z' });
    expect(withTimestamp(undefined)).toMatchObject({ sentAt: now.toISOString() });
  });

  it('2xx → sin falla', () => {
    expect(classifyWahaFailure({ kind: 'response', status: 200, text: '{}' })).toBeNull();
  });
});
