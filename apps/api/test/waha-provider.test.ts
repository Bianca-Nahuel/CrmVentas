// Resolución de LIDs con la API de WAHA (fetch falso, sin red).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WahaClient } from '../src/whatsapp/providers/waha/waha-client.js';
import { WahaProvider } from '../src/whatsapp/providers/waha/waha.provider.js';

function fakeFetch(status: number, body: unknown, calls: { url: string; apiKey: string | null }[] = []) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), apiKey: new Headers(init?.headers).get('X-Api-Key') });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

const lidEvent = () => {
  const raw = JSON.parse(
    readFileSync(new URL('./fixtures/whatsapp/waha/message-lid-without-alt.json', import.meta.url), 'utf8'),
  );
  const result = new WahaProvider(new WahaClient('http://waha', 'k')).normalize(raw);
  if (result.kind !== 'event') throw new Error('fixture inválido');
  return result.event;
};

describe('WahaClient.findPhoneByLid', () => {
  it('pide /api/{session}/lids/{n} con la API key y devuelve E.164', async () => {
    const calls: { url: string; apiKey: string | null }[] = [];
    const client = new WahaClient(
      'http://waha:3000',
      'clave',
      fakeFetch(200, { lid: 'x', pn: '5491100000005@c.us' }, calls),
    );
    expect(await client.findPhoneByLid('ch_abc', '100000000000002@lid')).toBe('+5491100000005');
    expect(calls).toEqual([{ url: 'http://waha:3000/api/ch_abc/lids/100000000000002', apiKey: 'clave' }]);
  });

  it('404 o pn vacío → null', async () => {
    expect(
      await new WahaClient('http://waha', 'k', fakeFetch(404, {})).findPhoneByLid('s', '1@lid'),
    ).toBeNull();
    expect(
      await new WahaClient('http://waha', 'k', fakeFetch(200, { pn: null })).findPhoneByLid('s', '1@lid'),
    ).toBeNull();
  });

  it('5xx → excepción sin el identificador del contacto (la cola reintenta)', async () => {
    const client = new WahaClient('http://waha', 'k', fakeFetch(500, {}));
    await expect(client.findPhoneByLid('s', '100000000000002@lid')).rejects.toThrow(
      /^WAHA respondió 500 al buscar un LID$/,
    );
  });
});

describe('WahaClient: sesiones', () => {
  const session = {
    name: 'ch_0123456789abcdef0123456789abcdef',
    config: {
      webhooks: [
        {
          url: 'http://host.docker.internal:3000/api/webhooks/waha',
          events: ['message', 'session.status'],
          hmac: { key: 'k'.repeat(64) },
        },
      ],
    },
  };

  function recordingFetch(status: number) {
    const calls: { method: string; url: string; apiKey: string | null; body: unknown }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: String(input),
        apiKey: new Headers(init?.headers).get('X-Api-Key'),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response('{}', { status });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it('createSession → POST /api/sessions con la configuración completa', async () => {
    const { calls, fetchImpl } = recordingFetch(201);
    await new WahaClient('http://waha:3000', 'clave', fetchImpl).createSession(session);
    expect(calls).toEqual([
      { method: 'POST', url: 'http://waha:3000/api/sessions', apiKey: 'clave', body: session },
    ]);
  });

  it('updateSession → PUT /api/sessions/{nombre} con la configuración completa', async () => {
    const { calls, fetchImpl } = recordingFetch(200);
    await new WahaClient('http://waha:3000', 'clave', fetchImpl).updateSession(session);
    expect(calls).toEqual([
      { method: 'PUT', url: `http://waha:3000/api/sessions/${session.name}`, apiKey: 'clave', body: session },
    ]);
  });

  it('un 4xx lanza un error con solo el código', async () => {
    const client = new WahaClient('http://waha', 'k', recordingFetch(422).fetchImpl);
    await expect(client.createSession(session)).rejects.toThrow(/^WAHA respondió 422 al crear la sesión$/);
    await expect(client.updateSession(session)).rejects.toThrow(
      /^WAHA respondió 422 al actualizar la sesión$/,
    );
  });
});

describe('WahaProvider.enrich', () => {
  it('reemplaza el LID por el número si WAHA lo conoce', async () => {
    const provider = new WahaProvider(
      new WahaClient('http://waha', 'k', fakeFetch(200, { pn: '5491100000005@c.us' })),
    );
    const event = await provider.enrich(lidEvent());
    expect(event).toMatchObject({ contact: { waId: '+5491100000005' } });
  });

  it('deja el LID si WAHA no lo conoce', async () => {
    const provider = new WahaProvider(new WahaClient('http://waha', 'k', fakeFetch(404, {})));
    expect(await provider.enrich(lidEvent())).toMatchObject({ contact: { waId: '100000000000002@lid' } });
  });

  it('no llama a WAHA si el contacto ya tiene número', async () => {
    const calls: { url: string; apiKey: string | null }[] = [];
    const provider = new WahaProvider(new WahaClient('http://waha', 'k', fakeFetch(500, {}, calls)));
    const event = { ...lidEvent(), contact: { waId: '+5491100000005', profileName: null } };
    expect(await provider.enrich(event)).toBe(event);
    expect(calls).toHaveLength(0);
  });
});
