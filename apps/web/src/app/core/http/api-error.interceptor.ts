import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { ME_ERROR_CODES } from '@ventas/shared/auth';
import { catchError, throwError } from 'rxjs';
import { NotifyService } from '../../ui/toast';
import { AuthService } from '../auth/auth.service';
import { safeRedirect } from '../auth/safe-redirect';
import { SKIP_API_ERROR_HANDLING } from './http-context';

/**
 * 401 → login (guardando adónde iba) · 403 sin empresa activa → elegir empresa · otro 403 → sin acceso ·
 * error de red → aviso. Nunca muestra el cuerpo del error. El error se propaga igual a quien llamó.
 */
export const apiErrorInterceptor: HttpInterceptorFn = (request, next) => {
  if (request.context.get(SKIP_API_ERROR_HANDLING)) return next(request);
  const router = inject(Router);
  const auth = inject(AuthService);
  const notify = inject(NotifyService);

  return next(request).pipe(
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse) {
        if (error.status === 401) {
          auth.reset();
          const redirect = safeRedirect(router.url);
          void router.navigate(['/ingresar'], {
            queryParams: redirect === '/' ? {} : { redirect },
          });
        } else if (error.status === 403) {
          const code = (error.error as { code?: unknown } | null)?.code;
          void router.navigateByUrl(
            code === ME_ERROR_CODES.noActiveTenant ? '/elegir-empresa' : '/sin-acceso',
          );
        } else if (error.status === 0) {
          notify.networkError();
        }
      }
      return throwError(() => error);
    }),
  );
};
