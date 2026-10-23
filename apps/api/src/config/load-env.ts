import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// En desarrollo (app, tests, seed, drizzle-kit) las variables salen del .env de la raíz del repo.
// En producción las inyecta el entorno y este archivo no se carga.
const rootEnvFile = fileURLToPath(new URL('../../../../.env', import.meta.url));

export function loadLocalEnv(): void {
  if (process.env.NODE_ENV === 'production') return;
  if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);
}
