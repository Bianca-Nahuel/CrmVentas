// Protección SSRF del lector de páginas (tarea 007, verificación 4): http, otro dominio, la variante con o
// sin www que no está en la lista, IPs privadas o de loopback, redirecciones a otro dominio, respuestas
// demasiado grandes o que no son HTML. Todo rechazado sin leer el contenido. Un servidor HTTPS local con un
// certificado propio (generado acá con openssl) hace de "web de la empresa"; el resolvedor DNS es falso.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainRateLimiter } from '../src/catalog/web/domain-rate-limiter.js';
import { isPublicAddress } from '../src/catalog/web/ip-policy.js';
import { SafeFetcher, type Resolver } from '../src/catalog/web/safe-fetch.js';

const HOST = 'tienda.test';
const ALLOWED = [HOST];
const PAGE = '<html><body><h1>Producto de prueba</h1></body></html>';

let server: Server;
let port: number;
let ca: Buffer;
let dir: string;
/** Pedidos que llegaron al servidor y si se leyó el cuerpo de la respuesta. */
const hits: string[] = [];

type Handler = (res: import('node:http').ServerResponse) => void;
const routes: Record<string, Handler> = {
  '/ok': (res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  },
  '/gzip': (res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.end(gzipSync(PAGE));
  },
  '/a-otro-dominio': (res) => {
    res.writeHead(302, { location: 'https://evil.test/robar' });
    res.end('cuerpo de la redirección');
  },
  '/a-www': (res) => {
    res.writeHead(301, { location: `https://www.${HOST}/ok` });
    res.end();
  },
  '/a-http': (res) => {
    res.writeHead(302, { location: `http://${HOST}/ok` });
    res.end();
  },
  '/a-ok': (res) => {
    res.writeHead(302, { location: '/ok' });
    res.end();
  },
  '/bucle': (res) => {
    res.writeHead(302, { location: '/bucle' });
    res.end();
  },
  '/grande-declarado': (res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(3 * 1024 * 1024) });
    res.end();
  },
  '/grande-sin-largo': (res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    const chunk = Buffer.alloc(256 * 1024, 'a');
    let sent = 0;
    const push = () => {
      while (sent < 12 && res.write(chunk)) sent++;
      if (sent < 12) res.once('drain', push);
      else res.end();
    };
    push();
  },
  '/bomba-gzip': (res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.end(gzipSync(Buffer.alloc(20 * 1024 * 1024, ' ')));
  },
  '/pdf': (res) => {
    res.writeHead(200, { 'content-type': 'application/pdf' });
    res.end('%PDF');
  },
  '/404': (res) => {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('no');
  },
  '/lento': (res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    }, 1_500);
  },
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'safe-fetch-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${HOST}`,
      '-addext',
      `subjectAltName=DNS:${HOST},DNS:www.${HOST},DNS:evil.test`,
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  ca = readFileSync(join(dir, 'cert.pem'));
  server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: ca }, (req, res) => {
    hits.push(req.url ?? '');
    const route = routes[req.url ?? ''];
    if (route) route(res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

/** Resolvedor falso: cada host a las IPs indicadas (por defecto, el servidor local). */
function resolver(map: Record<string, string[]> = {}): Resolver {
  return async (host) => {
    const addresses = map[host] ?? ['127.0.0.1'];
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
}

/** Fetcher que puede hablar con el servidor local (solo 127.0.0.1 permitido, nada más). */
function localFetcher(options: Partial<ConstructorParameters<typeof SafeFetcher>[0]> = {}) {
  return new SafeFetcher({
    userAgent: 'VentasCatalogBot/test',
    ca,
    connectPort: port,
    resolver: resolver(),
    ipPolicy: (address) => address === '127.0.0.1',
    rateLimiter: new DomainRateLimiter(0),
    ...options,
  });
}

async function fetchCounting(fetcher: SafeFetcher, url: string, allowed = ALLOWED) {
  const before = hits.length;
  const result = await fetcher.fetchHtml(url, allowed);
  return { result, requests: hits.slice(before) };
}

describe('lectura permitida', () => {
  it('https del dominio permitido: devuelve el HTML (también con gzip)', async () => {
    const fetcher = localFetcher();
    const plain = await fetcher.fetchHtml(`https://${HOST}/ok`, ALLOWED);
    expect(plain).toMatchObject({ ok: true, html: PAGE, status: 200 });
    const gzip = await fetcher.fetchHtml(`https://${HOST}/gzip`, ALLOWED);
    expect(gzip).toMatchObject({ ok: true, html: PAGE });
  });

  it('una redirección dentro del dominio se sigue', async () => {
    const { result, requests } = await fetchCounting(localFetcher(), `https://${HOST}/a-ok`);
    expect(result).toMatchObject({ ok: true, finalUrl: `https://${HOST}/ok` });
    expect(requests).toEqual(['/a-ok', '/ok']);
  });

  it('valida el certificado contra el host: sin la CA de prueba falla', async () => {
    const fetcher = localFetcher({ ca: undefined as never });
    const result = await fetcher.fetchHtml(`https://${HOST}/ok`, ALLOWED);
    expect(result).toMatchObject({ ok: false, errorCode: 'fetch_failed' });
  });
});

describe('rechazos antes de conectarse', () => {
  it.each([
    [`http://${HOST}/ok`, 'url_not_https'],
    ['https://otro-dominio.test/ok', 'url_domain'],
    [`https://www.${HOST}/ok`, 'url_domain_www_variant'],
    [`https://usuario:clave@${HOST}/ok`, 'url_invalid'],
    [`https://${HOST}:8443/ok`, 'url_invalid'],
    ['https://127.0.0.1/ok', 'url_domain'],
    ['https://[::1]/ok', 'url_domain'],
    ['no es una url', 'url_invalid'],
  ])('%s → %s', async (url, code) => {
    const { result, requests } = await fetchCounting(localFetcher(), url);
    expect(result).toMatchObject({ ok: false, errorCode: code });
    expect(requests).toEqual([]);
  });

  it.each([
    ['127.0.0.1'],
    ['10.0.0.7'],
    ['192.168.1.10'],
    ['169.254.169.254'],
    ['::1'],
    ['::ffff:10.0.0.7'],
    ['fd00::1'],
  ])('el host resuelve a %s → ip_not_public, sin conectarse', async (address) => {
    const fetcher = localFetcher({ resolver: resolver({ [HOST]: [address] }), ipPolicy: isPublicAddress });
    const { result, requests } = await fetchCounting(fetcher, `https://${HOST}/ok`);
    expect(result).toMatchObject({ ok: false, errorCode: 'ip_not_public' });
    expect(requests).toEqual([]);
  });

  it('una IP pública y una privada para el mismo host: se rechaza', async () => {
    const fetcher = localFetcher({
      resolver: resolver({ [HOST]: ['93.184.216.34', '10.0.0.7'] }),
      ipPolicy: isPublicAddress,
    });
    expect(await fetcher.fetchHtml(`https://${HOST}/ok`, ALLOWED)).toMatchObject({
      errorCode: 'ip_not_public',
    });
  });

  it('DNS que no responde: corta con el timeout total', async () => {
    const fetcher = localFetcher({ timeoutMs: 200, resolver: () => new Promise(() => undefined) });
    expect(await fetcher.fetchHtml(`https://${HOST}/ok`, ALLOWED)).toMatchObject({ errorCode: 'timeout' });
  });

  it('DNS que falla', async () => {
    const fetcher = localFetcher({
      resolver: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(await fetcher.fetchHtml(`https://${HOST}/ok`, ALLOWED)).toMatchObject({ errorCode: 'dns_failed' });
  });

  it('se conecta a la IP validada: el DNS no se vuelve a consultar al conectar', async () => {
    let calls = 0;
    const fetcher = localFetcher({
      resolver: async () => {
        calls++;
        // Primera respuesta: el servidor local. Si se volviera a resolver, daría una privada.
        return [{ address: calls === 1 ? '127.0.0.1' : '10.0.0.7', family: 4 }];
      },
    });
    expect(await fetcher.fetchHtml(`https://${HOST}/ok`, ALLOWED)).toMatchObject({ ok: true });
    expect(calls).toBe(1);
  });
});

describe('redirecciones', () => {
  it('a otro dominio → rechazada; no se pide el otro dominio ni se lee el cuerpo', async () => {
    const { result, requests } = await fetchCounting(localFetcher(), `https://${HOST}/a-otro-dominio`);
    expect(result).toMatchObject({ ok: false, errorCode: 'redirect_not_allowed' });
    expect(requests).toEqual(['/a-otro-dominio']);
    expect(JSON.stringify(result)).not.toMatch(/cuerpo/);
  });

  it('a la variante con www que no está en la lista → redirect_www_variant', async () => {
    const { result, requests } = await fetchCounting(localFetcher(), `https://${HOST}/a-www`);
    expect(result).toMatchObject({ ok: false, errorCode: 'redirect_www_variant' });
    expect(requests).toEqual(['/a-www']);
  });

  it('con la variante en la lista, se sigue', async () => {
    const { result } = await fetchCounting(localFetcher(), `https://${HOST}/a-www`, [HOST, `www.${HOST}`]);
    expect(result).toMatchObject({ ok: true, finalUrl: `https://www.${HOST}/ok` });
  });

  it('a http → rechazada', async () => {
    const { result } = await fetchCounting(localFetcher(), `https://${HOST}/a-http`);
    expect(result).toMatchObject({ ok: false, errorCode: 'redirect_not_allowed' });
  });

  it('más de 3 → too_many_redirects', async () => {
    const { result, requests } = await fetchCounting(localFetcher(), `https://${HOST}/bucle`);
    expect(result).toMatchObject({ ok: false, errorCode: 'too_many_redirects' });
    expect(requests).toHaveLength(4);
  });

  it('a un dominio permitido que resuelve a una IP privada → rechazada', async () => {
    const fetcher = localFetcher({
      resolver: resolver({ [HOST]: ['127.0.0.1'], [`www.${HOST}`]: ['10.0.0.7'] }),
    });
    const result = await fetcher.fetchHtml(`https://${HOST}/a-www`, [HOST, `www.${HOST}`]);
    expect(result).toMatchObject({ ok: false, errorCode: 'ip_not_public' });
  });
});

describe('respuestas', () => {
  it('content-length de más de 2 MB → too_large sin leer el cuerpo', async () => {
    expect(await localFetcher().fetchHtml(`https://${HOST}/grande-declarado`, ALLOWED)).toMatchObject({
      ok: false,
      errorCode: 'too_large',
    });
  });

  it('sin content-length, más de 2 MB → corta al pasar el tope', async () => {
    expect(await localFetcher().fetchHtml(`https://${HOST}/grande-sin-largo`, ALLOWED)).toMatchObject({
      ok: false,
      errorCode: 'too_large',
    });
  });

  it('bomba gzip (20 MB descomprimidos) → too_large', async () => {
    expect(await localFetcher().fetchHtml(`https://${HOST}/bomba-gzip`, ALLOWED)).toMatchObject({
      ok: false,
      errorCode: 'too_large',
    });
  });

  it('no es HTML → not_html; un 404 → http_status', async () => {
    expect(await localFetcher().fetchHtml(`https://${HOST}/pdf`, ALLOWED)).toMatchObject({
      errorCode: 'not_html',
    });
    expect(await localFetcher().fetchHtml(`https://${HOST}/404`, ALLOWED)).toMatchObject({
      errorCode: 'http_status',
      status: 404,
    });
  });

  it('timeout total', async () => {
    const fetcher = localFetcher({ timeoutMs: 300 });
    expect(await fetcher.fetchHtml(`https://${HOST}/lento`, ALLOWED)).toMatchObject({ errorCode: 'timeout' });
  });
});

describe('límite por dominio', () => {
  it('un pedido por intervalo por dominio; otro dominio no espera', async () => {
    let now = 0;
    const limiter = new DomainRateLimiter(1_000, () => now);
    await limiter.wait('a.test');
    const started = Date.now();
    now = 900;
    // Le faltan 100 ms para su turno.
    await limiter.wait('a.test');
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    const other = Date.now();
    await limiter.wait('b.test');
    expect(Date.now() - other).toBeLessThan(50);
  });
});

describe('política de IPs', () => {
  it.each([
    ['93.184.216.34', true],
    ['8.8.8.8', true],
    ['2606:4700::1111', true],
    ['10.1.2.3', false],
    ['172.16.0.1', false],
    ['100.64.0.1', false],
    ['0.0.0.0', false],
    ['224.0.0.1', false],
    ['::', false],
    ['fe80::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:7f00:1', false],
    ['64:ff9b::a00:1', false],
    ['2002:a00:1::', false],
    ['::ffff:8.8.8.8', true],
    ['no-ip', false],
  ])('%s → %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});
