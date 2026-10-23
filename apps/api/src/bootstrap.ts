import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

export async function createApp(): Promise<NestExpressApplication> {
  // bodyParser: false → Better Auth lee el body crudo en /api/auth; la librería de integración
  // vuelve a poner los parsers para el resto de las rutas.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: ['error', 'warn', 'log'],
  });
  app.setGlobalPrefix('api');
  app.disable('x-powered-by');
  app.enableShutdownHooks();
  return app;
}
