// Vinculación por QR con WAHA (tarea 011): pedidos a la API de sesiones y lectura de sus respuestas.
// fetch falso, sin red.
import { describe, expect, it } from 'vitest';
import { WahaClient } from '../src/whatsapp/providers/waha/waha-client.js';
import { pairingFromQr, pairingFromSession } from '../src/whatsapp/providers/waha/waha-pairing.js';
import { wahaSessionName } from '../src/whatsapp/providers/waha/waha-session.js';
import { WahaProvider } from '../src/whatsapp/providers/waha/waha.provider.js';

const TEST_WEBHOOK = { webhookUrl: 'http://api/api/webhooks/waha', hmacKey: 'k'.repeat(32) };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABc3UBGAAAAABJRU5ErkJggg==';

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** Proveedor con un fetch que responde, en orden, lo que se le pasa (status y cuerpo). */
function provider(responses: [number, unknown][], calls: Call[] = []) {
  const queue = [...responses];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const [status, body] = queue.shift() ?? [500, {}];
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return new WahaProvider(new WahaClient('http://waha:3000', 'k', fetchImpl), TEST_WEBHOOK);
}

const response = (status: number, body: unknown) => ({
  kind: 'response' as const,
  status,
  text: JSON.stringify(body),
});

describe('nombre de la sesión', () => {
  it("'ch_' + id del canal sin guiones", () => {
    expect(wahaSessionName('01a19916-CEE2-7bc6-a858-93b504bd76cc')).toBe(
      'ch_01a19916cee27bc6a85893b504bd76cc',
    );
  });
});

describe('pairingFromSession', () => {
  it.each([
    ['WORKING', { state: 'connected' }],
    ['STARTING', { state: 'starting' }],
    ['PASSKEY_REQUIRED', { state: 'starting' }],
    ['STOPPED', { state: 'expired' }],
    ['FAILED', { state: 'expired' }],
    ['OTRO', { state: 'unavailable', code: 'estado_desconocido' }],
  ])('%s → %j', (status, expected) => {
    expect(pairingFromSession(response(200, { name: 's', status }))).toEqual(expected);
  });

  it('SCAN_QR_CODE → null (hay que pedir el QR); 404 → expired; error → unavailable', () => {
    expect(pairingFromSession(response(200, { status: 'SCAN_QR_CODE' }))).toBeNull();
    expect(pairingFromSession(response(404, {}))).toEqual({ state: 'expired' });
    expect(pairingFromSession(response(500, {}))).toEqual({ state: 'unavailable', code: 'http_500' });
    expect(pairingFromSession({ kind: 'not_sent', code: 'ECONNREFUSED' })).toEqual({
      state: 'unavailable',
      code: 'ECONNREFUSED',
    });
  });
});

describe('pairingFromQr', () => {
  it('PNG en base64 → data URL', () => {
    expect(pairingFromQr(response(200, { mimetype: 'image/png', data: PNG }))).toEqual({
      state: 'qr',
      image: `data:image/png;base64,${PNG}`,
    });
  });

  it.each([
    [{ mimetype: 'image/svg+xml', data: PNG }],
    [{ mimetype: 'image/png', data: '<script>' }],
    [{ mimetype: 'image/png', data: '' }],
    [{ mimetype: 'image/png', data: 'A'.repeat(100_001) }],
    [{ value: '2@abc' }],
  ])('rechaza lo que no es un PNG razonable: %j', (body) => {
    expect(pairingFromQr(response(200, body))).toEqual({ state: 'unavailable', code: 'qr_ilegible' });
  });

  it('422 (ya no espera el escaneo) → starting; 404 → expired', () => {
    expect(pairingFromQr(response(422, {}))).toEqual({ state: 'starting' });
    expect(pairingFromQr(response(404, {}))).toEqual({ state: 'expired' });
  });
});

describe('WahaProvider: conexión', () => {
  it('openSession → POST /api/sessions con start y el webhook firmado (session.status incluido)', async () => {
    const calls: Call[] = [];
    expect(await provider([[201, {}]], calls).openSession('ch_abc')).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        method: 'POST',
        url: 'http://waha:3000/api/sessions',
        body: {
          name: 'ch_abc',
          start: true,
          config: {
            webhooks: [
              {
                url: TEST_WEBHOOK.webhookUrl,
                events: ['message.any', 'message.ack', 'session.status'],
                hmac: { key: TEST_WEBHOOK.hmacKey },
                retries: { policy: 'exponential', delaySeconds: 2, attempts: 6 },
              },
            ],
            ignore: { status: true, groups: true, channels: true },
          },
        },
      },
    ]);
  });

  it('openSession con error → código, sin lanzar', async () => {
    expect(await provider([[422, {}]]).openSession('ch_abc')).toEqual({ ok: false, code: 'http_422' });
  });

  it('getPairingQr: pregunta el estado y, si espera el escaneo, pide el QR', async () => {
    const calls: Call[] = [];
    const result = await provider(
      [
        [200, { status: 'SCAN_QR_CODE' }],
        [200, { mimetype: 'image/png', data: PNG }],
      ],
      calls,
    ).getPairingQr('ch_abc');
    expect(result).toEqual({ state: 'qr', image: `data:image/png;base64,${PNG}` });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET http://waha:3000/api/sessions/ch_abc',
      'GET http://waha:3000/api/ch_abc/auth/qr',
    ]);
  });

  it('restartPairing: detener → desvincular → configuración → iniciar', async () => {
    const calls: Call[] = [];
    const result = await provider(
      [
        [201, {}],
        // 422: la sesión no tenía un teléfono vinculado.
        [422, {}],
        [200, {}],
        [201, {}],
      ],
      calls,
    ).restartPairing('ch_abc');
    expect(result).toEqual({ ok: true });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://waha:3000/api/sessions/ch_abc/stop',
      'POST http://waha:3000/api/sessions/ch_abc/logout',
      'PUT http://waha:3000/api/sessions/ch_abc',
      'POST http://waha:3000/api/sessions/ch_abc/start',
    ]);
  });

  it('restartPairing: si desvincular falla, no sigue (podría quedar el teléfono anterior)', async () => {
    const calls: Call[] = [];
    const result = await provider(
      [
        [201, {}],
        [500, {}],
      ],
      calls,
    ).restartPairing('ch_abc');
    expect(result).toEqual({ ok: false, code: 'http_500' });
    expect(calls).toHaveLength(2);
  });

  it('restartPairing de una sesión que ya no existe en WAHA → la crea de nuevo', async () => {
    const calls: Call[] = [];
    const result = await provider(
      [
        [404, {}],
        [201, {}],
      ],
      calls,
    ).restartPairing('ch_abc');
    expect(result).toEqual({ ok: true });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://waha:3000/api/sessions/ch_abc/stop',
      'POST http://waha:3000/api/sessions',
    ]);
  });

  it('closeSession: desvincular y detener; con forget, borrar; 404 cuenta como hecho', async () => {
    const calls: Call[] = [];
    expect(
      await provider(
        [
          [201, {}],
          [201, {}],
        ],
        calls,
      ).closeSession('ch_abc', { forget: false }),
    ).toEqual({ ok: true });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://waha:3000/api/sessions/ch_abc/logout',
      'POST http://waha:3000/api/sessions/ch_abc/stop',
    ]);

    const deletes: Call[] = [];
    expect(await provider([[200, {}]], deletes).closeSession('ch_abc', { forget: true })).toEqual({
      ok: true,
    });
    expect(deletes.map((c) => `${c.method} ${c.url}`)).toEqual([
      'DELETE http://waha:3000/api/sessions/ch_abc',
    ]);
    expect(await provider([[404, {}]]).closeSession('ch_abc', { forget: true })).toEqual({ ok: true });
    // Sin teléfono vinculado (422) se detiene igual; un error al desvincular no se da por cerrada.
    expect(
      await provider([
        [422, {}],
        [201, {}],
      ]).closeSession('ch_abc', { forget: false }),
    ).toEqual({ ok: true });
    const failed: Call[] = [];
    expect(
      await provider(
        [
          [500, {}],
          [201, {}],
        ],
        failed,
      ).closeSession('ch_abc', { forget: false }),
    ).toEqual({ ok: false, code: 'http_500' });
    expect(failed).toHaveLength(1);
    expect(await provider([[500, {}]]).closeSession('ch_abc', { forget: true })).toEqual({
      ok: false,
      code: 'http_500',
    });
  });
});
