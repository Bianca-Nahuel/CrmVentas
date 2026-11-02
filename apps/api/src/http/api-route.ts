import type { z } from 'zod';

/**
 * Un endpoint del panel descripto con sus esquemas zod. Los controllers validan con los mismos esquemas
 * (ZodValidationPipe) y scripts/openapi.ts arma el documento OpenAPI con la lista de rutas.
 * `path` va sin el prefijo /api y con los parámetros en formato OpenAPI ({id}).
 */
export interface ApiRoute {
  method: 'get' | 'post' | 'put' | 'delete';
  path: string;
  operationId: string;
  summary: string;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** Respuesta 200. Sin respuesta: 204. */
  response?: z.ZodType;
  /** Puede responder 409 con un code (por ejemplo, una regla de envío que no se cumple). */
  conflict?: boolean;
  /** Otros errores con code que puede responder (410 vencido, 413 muy grande, 429 límite, 503 IA apagada). */
  errors?: (410 | 413 | 429 | 503)[];
  /** Body multipart/form-data con un archivo en el campo `file` (body no se usa). */
  multipartFile?: boolean;
}
