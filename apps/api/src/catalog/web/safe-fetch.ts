// Lectura de una página de producto con protección SSRF (tarea 007). Pasos de cada pedido (también de
// cada redirección):
// 1. URL: https, sin usuario ni contraseña, puerto 443, host (no una IP) exactamente en allowed_domains.
// 2. DNS: todas las IPs del host tienen que ser públicas; si una sola no lo es, se rechaza.
// 3. Conexión a ESA IP ya validada (lookup propio: no se vuelve a resolver, así no puede cambiar entre la
//    validación y la conexión); el certificado se valida contra el host. Sin agente compartido ni proxy.
// 4. Redirecciones manuales, como mucho 3, cada una con los pasos 1 a 3, sin leer el cuerpo.
// 5. Solo 200 con text/html, como mucho 2 MB (también después de descomprimir), timeout total de 8 s.
// 6. Como mucho un pedido por segundo por dominio.
// Nunca devuelve ni loguea el contenido de la página: eso lo hace el que llama (y no lo loguea).
import { lookup as dnsLookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Transform } from 'node:stream';
import { wwwVariant } from '@ventas/shared';
import { PUBLIC_ONLY, type IpPolicy } from './ip-policy.js';
import { DomainRateLimiter } from './domain-rate-limiter.js';

export type FetchErrorCode =
  | 'url_invalid'
  | 'url_not_https'
  | 'url_domain'
  | 'url_domain_www_variant'
  | 'dns_failed'
  | 'ip_not_public'
  | 'redirect_not_allowed'
  | 'redirect_www_variant'
  | 'too_many_redirects'
  | 'http_status'
  | 'not_html'
  | 'too_large'
  | 'bad_encoding'
  | 'timeout'
  | 'fetch_failed';

export type FetchResult =
  | { ok: true; html: string; finalUrl: string; status: number }
  | { ok: false; errorCode: FetchErrorCode; status?: number; finalUrl?: string };

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

export interface SafeFetchOptions {
  userAgent: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Solo los tests la cambian (su servidor local está en 127.0.0.1). */
  ipPolicy?: IpPolicy;
  resolver?: Resolver;
  rateLimiter?: DomainRateLimiter;
  /** CA extra (solo tests: certificado propio del servidor local). */
  ca?: string | Buffer;
  /** Puerto de conexión (solo tests: el servidor local no escucha en 443). La URL igual exige 443. */
  connectPort?: number;
}

const DEFAULTS = { timeoutMs: 8_000, maxBytes: 2 * 1024 * 1024, maxRedirects: 3 };

const systemResolver: Resolver = async (host) => {
  const addresses = await dnsLookup(host, { all: true, verbatim: true });
  return addresses.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
};

class FetchFailure extends Error {
  constructor(
    readonly code: FetchErrorCode,
    readonly status?: number,
  ) {
    super(code);
  }
}

/** Paso 1: la URL y su host. Devuelve el código de rechazo o null. */
export function checkUrl(
  raw: string | URL,
  allowedDomains: readonly string[],
): { url: URL } | { error: FetchErrorCode } {
  let url: URL;
  try {
    url = typeof raw === 'string' ? new URL(raw) : raw;
  } catch {
    return { error: 'url_invalid' };
  }
  if (url.protocol !== 'https:') return { error: 'url_not_https' };
  if (url.username || url.password || (url.port !== '' && url.port !== '443'))
    return { error: 'url_invalid' };
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  // Una IP literal nunca está en allowed_domains (la config no las acepta), pero se rechaza explícito.
  if (host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return { error: 'url_domain' };
  if (allowedDomains.includes(host)) return { url };
  return { error: allowedDomains.includes(wwwVariant(host)) ? 'url_domain_www_variant' : 'url_domain' };
}

export class SafeFetcher {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly ipPolicy: IpPolicy;
  private readonly resolver: Resolver;
  private readonly rateLimiter: DomainRateLimiter;

  constructor(private readonly options: SafeFetchOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
    this.maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;
    this.ipPolicy = options.ipPolicy ?? PUBLIC_ONLY;
    this.resolver = options.resolver ?? systemResolver;
    this.rateLimiter = options.rateLimiter ?? new DomainRateLimiter();
  }

  async fetchHtml(rawUrl: string, allowedDomains: readonly string[]): Promise<FetchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let current: URL | null = null;
    try {
      const first = checkUrl(rawUrl, allowedDomains);
      if ('error' in first) return { ok: false, errorCode: first.error };
      current = first.url;
      for (let redirects = 0; ; redirects++) {
        const response = await this.requestOnce(current, controller.signal);
        if (response.kind === 'redirect') {
          if (redirects >= this.maxRedirects)
            return { ok: false, errorCode: 'too_many_redirects', finalUrl: current.href };
          let next: URL;
          try {
            next = new URL(response.location, current);
          } catch {
            return { ok: false, errorCode: 'redirect_not_allowed', finalUrl: current.href };
          }
          const checked = checkUrl(next, allowedDomains);
          if ('error' in checked) {
            return {
              ok: false,
              errorCode:
                checked.error === 'url_domain_www_variant' ? 'redirect_www_variant' : 'redirect_not_allowed',
              finalUrl: current.href,
            };
          }
          current = checked.url;
          continue;
        }
        return { ok: true, html: response.html, finalUrl: current.href, status: response.status };
      }
    } catch (error) {
      if (controller.signal.aborted)
        return { ok: false, errorCode: 'timeout', ...(current ? { finalUrl: current.href } : {}) };
      if (error instanceof FetchFailure) {
        return {
          ok: false,
          errorCode: error.code,
          ...(error.status !== undefined ? { status: error.status } : {}),
          ...(current ? { finalUrl: current.href } : {}),
        };
      }
      return { ok: false, errorCode: 'fetch_failed', ...(current ? { finalUrl: current.href } : {}) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Pasos 2 y 3: resolver, validar todas las IPs y conectarse a la validada. */
  private async pinnedAddress(host: string): Promise<ResolvedAddress> {
    let addresses: ResolvedAddress[];
    try {
      addresses = await this.resolver(host);
    } catch {
      throw new FetchFailure('dns_failed');
    }
    if (addresses.length === 0) throw new FetchFailure('dns_failed');
    if (!addresses.every((entry) => this.ipPolicy(entry.address))) throw new FetchFailure('ip_not_public');
    return addresses[0]!;
  }

  private async requestOnce(
    url: URL,
    signal: AbortSignal,
  ): Promise<{ kind: 'redirect'; location: string } | { kind: 'page'; html: string; status: number }> {
    const host = url.hostname.replace(/\.$/, '').toLowerCase();
    const pinned = await this.pinnedAddress(host);
    await this.rateLimiter.wait(host, signal);
    if (signal.aborted) throw new FetchFailure('timeout');

    // Devuelve siempre la IP validada, sin volver a resolver (también si Node pide todas las direcciones).
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if ((options as { all?: boolean }).all) {
        (callback as unknown as (error: null, addresses: { address: string; family: number }[]) => void)(
          null,
          [{ address: pinned.address, family: pinned.family }],
        );
      } else {
        callback(null, pinned.address, pinned.family);
      }
    };

    return new Promise((resolve, reject) => {
      const req = request(
        {
          protocol: 'https:',
          hostname: host,
          servername: host,
          port: this.options.connectPort ?? 443,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          agent: false,
          lookup,
          signal,
          ...(this.options.ca ? { ca: this.options.ca } : {}),
          headers: {
            'User-Agent': this.options.userAgent,
            Accept: 'text/html,application/xhtml+xml;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'es-AR,es;q=0.9',
          },
        },
        (res) => {
          // Defensa extra: la conexión tiene que ser a la IP validada.
          if (
            res.socket.remoteAddress &&
            res.socket.remoteAddress.replace(/^::ffff:/, '') !== pinned.address.replace(/^::ffff:/, '')
          ) {
            res.destroy();
            reject(new FetchFailure('ip_not_public'));
            return;
          }
          const status = res.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            const location = res.headers.location;
            res.destroy();
            if (!location) reject(new FetchFailure('http_status', status));
            else resolve({ kind: 'redirect', location });
            return;
          }
          if (status !== 200) {
            res.destroy();
            reject(new FetchFailure('http_status', status));
            return;
          }
          const contentType = (res.headers['content-type'] ?? '').toLowerCase();
          if (!/^\s*(text\/html|application\/xhtml\+xml)\b/.test(contentType)) {
            res.destroy();
            reject(new FetchFailure('not_html', status));
            return;
          }
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > this.maxBytes) {
            res.destroy();
            reject(new FetchFailure('too_large', status));
            return;
          }
          this.readBody(res, contentType).then(
            (html) => resolve({ kind: 'page', html, status }),
            (error: unknown) => reject(error),
          );
        },
      );
      req.on('error', (error) => reject(error));
      req.end();
    });
  }

  private readBody(res: IncomingMessage, contentType: string): Promise<string> {
    const encoding = (res.headers['content-encoding'] ?? 'identity').toLowerCase().trim();
    let decoder: Transform | null = null;
    if (encoding === 'gzip' || encoding === 'x-gzip') decoder = createGunzip();
    else if (encoding === 'deflate') decoder = createInflate();
    else if (encoding === 'br') decoder = createBrotliDecompress();
    else if (encoding !== 'identity' && encoding !== '') {
      res.destroy();
      return Promise.reject(new FetchFailure('bad_encoding'));
    }
    const charset = /charset\s*=\s*"?([\w-]+)/.exec(contentType)?.[1]?.toLowerCase() ?? 'utf-8';
    const max = this.maxBytes;

    return new Promise((resolve, reject) => {
      let raw = 0;
      let decoded = 0;
      const chunks: Buffer[] = [];
      const fail = (code: FetchErrorCode) => {
        res.destroy();
        decoder?.destroy();
        reject(new FetchFailure(code));
      };
      res.on('data', (chunk: Buffer) => {
        raw += chunk.length;
        if (raw > max) fail('too_large');
      });
      const source = decoder ? res.pipe(decoder) : res;
      source.on('data', (chunk: Buffer) => {
        decoded += chunk.length;
        if (decoded > max) fail('too_large');
        else chunks.push(chunk);
      });
      source.on('error', () => fail(decoder ? 'bad_encoding' : 'fetch_failed'));
      res.on('error', () => fail('fetch_failed'));
      source.on('end', () => {
        try {
          const label = ['utf-8', 'utf8', 'iso-8859-1', 'latin1', 'windows-1252'].includes(charset)
            ? charset
            : 'utf-8';
          resolve(new TextDecoder(label).decode(Buffer.concat(chunks)));
        } catch {
          reject(new FetchFailure('bad_encoding'));
        }
      });
    });
  }
}
