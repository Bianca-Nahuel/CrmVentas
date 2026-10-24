// Los webhooks verifican una firma sobre los bytes exactos del cuerpo, así que ningún parser global
// puede consumirlo antes: los parsers de JSON y urlencoded (que pone la librería de Better Auth) se
// saltean /api/webhooks/*, y cada webhook lee el cuerpo crudo con su propio express.raw.
import type { IncomingMessage } from 'node:http';
import express, { type RequestHandler } from 'express';

export const WEBHOOKS_PATH_PREFIX = '/api/webhooks/';
export const WEBHOOK_BODY_LIMIT = '1mb';

function isWebhookRequest(req: IncomingMessage): boolean {
  const url = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '';
  // Express no distingue mayúsculas en las rutas: /API/Webhooks/... también es un webhook.
  return url.toLowerCase().startsWith(WEBHOOKS_PATH_PREFIX);
}

function mediaType(req: IncomingMessage): string {
  return (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
}

/** `type` para los parsers globales: el mismo media type que su default, salvo en los webhooks. */
export const parseJsonUnlessWebhook = (req: IncomingMessage) =>
  !isWebhookRequest(req) && mediaType(req) === 'application/json';

export const parseUrlencodedUnlessWebhook = (req: IncomingMessage) =>
  !isWebhookRequest(req) && mediaType(req) === 'application/x-www-form-urlencoded';

/**
 * Copia de un JSON sin el carácter U+0000: JSON.parse lo acepta, pero jsonb no, así que un texto o un
 * nombre de perfil con ese carácter haría fallar el encolado (500) en cada reintento del proveedor.
 */
export function stripNulChars(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('\u0000', '');
  if (Array.isArray(value)) return value.map(stripNulChars);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [stripNulChars(key) as string, stripNulChars(item)]),
    );
  }
  return value;
}

/** Cuerpo crudo (Buffer en req.body) para un webhook, sea cual sea el Content-Type. */
export const rawWebhookBody: RequestHandler = express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT });
