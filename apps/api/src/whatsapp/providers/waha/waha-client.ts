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

export class WahaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private request(method: string, path: string, body?: unknown): Promise<Response> {
    return this.fetchImpl(new URL(path, this.baseUrl), {
      method,
      headers: {
        'X-Api-Key': this.apiKey,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
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
