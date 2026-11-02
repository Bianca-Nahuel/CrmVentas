import type { NextFunction, Request, Response } from 'express';

// Pedidos que cambian estado (POST, PUT, PATCH, DELETE) solo desde un origen confiable: la sesión viaja en
// una cookie, así que sin este control otro sitio podría disparar pedidos con la sesión del usuario (CSRF).
// Better Auth valida su parte, pero se aplica también a /api/auth para no depender de cuándo lo hace.
// Excepción: los webhooks, que no traen Origin y se autentican con HMAC.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Rutas exactas (no un prefijo): un endpoint nuevo bajo /api/webhooks que use la cookie no queda exento.
const EXEMPT_PATHS = new Set(['/api/webhooks/waha']);

export function createOriginGuard(trustedOrigins: readonly string[]) {
  // Comparación exacta de esquema + host + puerto (new URL normaliza mayúsculas y el puerto por defecto).
  const allowed = new Set(trustedOrigins.map((value) => new URL(value).origin));

  return (request: Request, response: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(request.method) || EXEMPT_PATHS.has(request.path)) {
      return next();
    }
    const origin = request.headers.origin;
    const normalized = typeof origin === 'string' ? normalize(origin) : undefined;
    if (normalized !== undefined && allowed.has(normalized)) return next();
    response.status(403).json({ statusCode: 403, code: 'ORIGIN_NOT_ALLOWED' });
  };
}

function normalize(origin: string): string | undefined {
  try {
    const url = new URL(origin);
    // Un Origin es solo esquema://host[:puerto]; cualquier otra cosa (ruta, "null") no se acepta.
    return url.origin === origin.toLowerCase() ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
