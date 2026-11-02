import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { useBusinessMessages } from '@ventas/shared';
import { AppModule } from './app.module.js';
import { parseEnv } from './config/env.js';
import { createOriginGuard } from './http/origin-guard.js';

export async function createApp(): Promise<NestExpressApplication> {
  // bodyParser: false → Better Auth lee el body crudo en /api/auth; la librería de integración
  // vuelve a poner los parsers para el resto de las rutas.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: ['error', 'warn', 'log'],
  });
  app.setGlobalPrefix('api');
  app.disable('x-powered-by');
  // Antes que cualquier ruta (incluida /api/auth, que la librería monta al iniciar la app).
  app.use(createOriginGuard(parseEnv().TRUSTED_ORIGINS));
  app.enableShutdownHooks();
  // Errores de validación de la config en lenguaje de negocio, los mismos que muestra el panel (tarea 027).
  // Después de validar el entorno (parseEnv): los errores de variables faltantes conservan su texto.
  useBusinessMessages();
  return app;
}
