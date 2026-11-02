// Documento OpenAPI de los endpoints del panel, armado con los mismos esquemas zod que validan los
// controllers (src/inbox/*.contracts.ts). Lo lee ng-openapi-gen para generar el cliente del panel.
//   npm run api:openapi            → escribe apps/api/openapi.json
//   npm run api:openapi -- --check → falla si el archivo no está al día (lo corre npm run lint)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import type { ApiRoute } from '../src/http/api-route.js';
import { channelRoutes } from '../src/inbox/channels.contracts.js';
import { inboxRoutes } from '../src/inbox/inbox.contracts.js';
import { performanceRoutes } from '../src/performance/performance.contracts.js';
import { eventsRoute } from '../src/realtime/events.contracts.js';

const OUTPUT = fileURLToPath(new URL('../openapi.json', import.meta.url));
const ROUTES: ApiRoute[] = [...inboxRoutes, ...channelRoutes, ...performanceRoutes];

const errorSchema = {
  description: 'Error con un código estable (code) y, en las validaciones, la ruta de cada campo',
  content: {
    'application/json': {
      schema: {
        type: 'object' as const,
        properties: { code: { type: 'string' as const } },
        required: ['code'],
      },
    },
  },
};

export function buildDocument() {
  const registry = new OpenAPIRegistry();
  // Stream SSE (tarea 025): lo abre EventSource, no el cliente generado; se documenta para tener los tipos
  // de sus mensajes (InboxEvent, StreamEnd).
  registry.registerPath({
    method: 'get',
    path: eventsRoute.path,
    operationId: eventsRoute.operationId,
    tags: ['panel'],
    summary: eventsRoute.summary,
    responses: {
      200: { description: 'Stream SSE', content: { 'text/event-stream': { schema: eventsRoute.message } } },
      401: errorSchema,
      403: errorSchema,
      429: errorSchema,
    },
  });
  for (const route of ROUTES) {
    registry.registerPath({
      method: route.method,
      path: route.path,
      operationId: route.operationId,
      tags: ['panel'],
      summary: route.summary,
      request: {
        ...(route.params ? { params: route.params } : {}),
        ...(route.query ? { query: route.query } : {}),
        ...(route.body ? { body: { content: { 'application/json': { schema: route.body } } } } : {}),
      },
      responses: {
        ...(route.response
          ? { 200: { description: 'OK', content: { 'application/json': { schema: route.response } } } }
          : { 204: { description: 'Sin contenido' } }),
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
        ...(route.conflict ? { 409: errorSchema } : {}),
      },
    });
  }
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: { title: 'API del panel', version: '1' },
    servers: [{ url: '/api' }],
  });
}

const json = `${JSON.stringify(buildDocument(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    // Sin archivo: desactualizado.
  }
  if (current !== json) {
    console.error('apps/api/openapi.json no está al día: correr npm run api:generate');
    process.exit(1);
  }
} else {
  writeFileSync(OUTPUT, json);
  console.log('openapi.json actualizado');
}
