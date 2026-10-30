import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
import { appConfig } from './app/app.config';

// Sin datos de la sesión ni personales: solo el error de arranque.
bootstrapApplication(App, appConfig).catch((error: unknown) => console.error(error));
