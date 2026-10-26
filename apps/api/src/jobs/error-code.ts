// Código de Postgres (o de Node: ECONNREFUSED…) o, si no hay, el nombre del error (TimeoutError…).
// Identificadores sin datos personales; el mensaje nunca se usa.
export function errorCode(error: unknown): string {
  const failure = error as { code?: unknown; name?: unknown; cause?: { code?: unknown } } | null;
  for (const candidate of [failure?.cause?.code, failure?.code, failure?.name]) {
    if (typeof candidate === 'string' && /^[A-Z0-9_]{1,40}$/i.test(candidate)) return candidate;
  }
  return 'desconocido';
}
