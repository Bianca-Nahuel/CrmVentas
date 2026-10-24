// Cliente HTTP mínimo de la API de WAHA (header X-Api-Key). Los mensajes de error nunca incluyen
// identificadores de contactos.
import { toE164 } from './waha-normalize.js';

const TIMEOUT_MS = 3000;

export interface WahaSessionWebhook {
  url: string;
  events: string[];
  hmac: { key: string };
  retries?: { policy: 'constant' | 'linear' | 'exponential'; delaySeconds: number; attempts: number };
}

export interface CreateWahaSession {
  name: string;
  start?: boolean;
  config: {
    webhooks: WahaSessionWebhook[];
    ignore?: { status?: boolean; groups?: boolean; channels?: boolean };
    metadata?: Record<string, string>;
  };
}

export type WahaCallOutcome =
  | { kind: 'response'; status: number; text: string }
  /** No se pudo conectar: el pedido seguro que no llegó a WAHA. */
  | { kind: 'not_sent'; code: string }
  /** Se conectó (o no se sabe) y no hubo respuesta: el pedido pudo haberse procesado. */
  | { kind: 'no_response'; code: string };

// Errores de fetch/undici que pasan antes de abrir la conexión. Cualquier otro (timeout, ECONNRESET,
// UND_ERR_SOCKET…) puede pasar con el pedido ya enviado.
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function networkErrorCode(error: unknown): string {
  const failure = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  for (const candidate of [failure?.cause?.code, failure?.code, failure?.name]) {
    if (typeof candidate === 'string' && /^[A-Z0-9_]{1,40}$/i.test(candidate)) return candidate;
  }
  return 'desconocido';
}

export class WahaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private request(method: string, path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<Response> {
    return this.fetchImpl(new URL(path, this.baseUrl), {
      method,
      headers: {
        'X-Api-Key': this.apiKey,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /**
   * POST de una acción de chat (sendText, sendSeen, startTyping, stopTyping). Nunca lanza: devuelve la
   * respuesta (status y cuerpo como texto) o, si no la hubo, si el pedido llegó a salir o no.
   */
  async chatAction(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<WahaCallOutcome> {
    let response: Response;
    try {
      response = await this.request('POST', path, body, timeoutMs);
    } catch (error) {
      const code = networkErrorCode(error);
      return { kind: NOT_SENT_CODES.has(code) ? 'not_sent' : 'no_response', code };
    }
    try {
      return { kind: 'response', status: response.status, text: await response.text() };
    } catch (error) {
      // Se cortó leyendo la respuesta: WAHA ya recibió el pedido.
      return { kind: 'no_response', code: networkErrorCode(error) };
    }
  }

  /**
   * Número (E.164) de un contacto que llegó como LID (`GET /api/{session}/lids/{lid}`). null si WAHA no
   * lo conoce (404 o `pn` vacío). Errores de red o 5xx → excepción (la cola reintenta).
   */
  async findPhoneByLid(session: string, lid: string): Promise<string | null> {
    const digits = /^(\d{1,30})@lid$/.exec(lid)?.[1];
    if (!digits) return null;
    const response = await this.request('GET', `/api/${encodeURIComponent(session)}/lids/${digits}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`WAHA respondió ${response.status} al buscar un LID`);
    const data = (await response.json()) as { pn?: unknown };
    return typeof data.pn === 'string' ? toE164(data.pn) : null;
  }

  /**
   * Reemplaza la configuración completa de una sesión (`PUT /api/sessions/{session}`). Si está corriendo,
   * WAHA la detiene y la vuelve a iniciar; la vinculación con el teléfono se conserva.
   */
  async updateSession(session: CreateWahaSession): Promise<void> {
    const response = await this.request('PUT', `/api/sessions/${encodeURIComponent(session.name)}`, session);
    if (!response.ok) {
      throw new Error(`WAHA respondió ${response.status} al actualizar la sesión`);
    }
  }

  /** Crea (y por defecto inicia) una sesión con su configuración de webhooks. */
  async createSession(session: CreateWahaSession): Promise<void> {
    const response = await this.request('POST', '/api/sessions', session);
    if (!response.ok) {
      throw new Error(`WAHA respondió ${response.status} al crear la sesión`);
    }
  }
}
