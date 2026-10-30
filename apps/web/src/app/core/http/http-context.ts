import { HttpContext, HttpContextToken } from '@angular/common/http';

/** Para pedidos que interpretan sus propios errores (el contexto de la sesión, al arrancar). */
export const SKIP_API_ERROR_HANDLING = new HttpContextToken<boolean>(() => false);

export function skipApiErrorHandling() {
  return { context: new HttpContext().set(SKIP_API_ERROR_HANDLING, true) };
}
