import { registerLocaleData } from '@angular/common';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import localeEsAr from '@angular/common/locales/es-AR';
import {
  DEFAULT_CURRENCY_CODE,
  LOCALE_ID,
  provideBrowserGlobalErrorListeners,
  type ApplicationConfig,
} from '@angular/core';
import { TitleStrategy, provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';
import { PanelTitleStrategy } from './core/title-strategy';
import { apiErrorInterceptor } from './core/http/api-error.interceptor';

registerLocaleData(localeEsAr);

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch(), withInterceptors([apiErrorInterceptor])),
    { provide: TitleStrategy, useClass: PanelTitleStrategy },
    { provide: LOCALE_ID, useValue: 'es-AR' },
    { provide: DEFAULT_CURRENCY_CODE, useValue: 'ARS' },
  ],
};
