import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

// Tests de punta a punta del panel contra la API real (con el seed cargado) a través del proxy de Angular.
// Levanta la API y el front si no están corriendo. Requiere Postgres arriba y `npm run db:seed`.
/** Las variables del proceso (sin las vacías), para sumarles las de la API de los e2e. */
function inheritedEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

// Clave HMAC del webhook de WAHA para esta corrida (tarea 025: los e2e simulan entrantes con el webhook
// firmado). Se genera al azar y se le pasa a la API; los tests la leen del entorno, que heredan los workers.
// Nunca es la clave de desarrollo.
process.env['E2E_WAHA_HMAC_KEY'] ??= randomBytes(32).toString('hex');

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/artifacts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:4200',
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
    trace: 'retain-on-failure',
  },
  // Las capturas (cada pantalla en claro y oscuro, a 375 y 1280 px) van aparte: se corren cuando cambia algo
  // visual, con npm run e2e:capturas.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /capturas\.spec\.ts/ },
    { name: 'capturas', use: { ...devices['Desktop Chrome'] }, testMatch: /capturas\.spec\.ts/ },
  ],
  webServer: [
    {
      command: 'npm run dev:api',
      cwd: '../..',
      url: 'http://localhost:3000/api/health',
      // Los e2e responden por WhatsApp desde el panel: la API arranca siempre con el proveedor falso (no
      // sale nada real). Nunca reusa una API ya levantada, que podría estar conectada a WAHA: si el
      // puerto 3000 está ocupado, falla (bajar el dev:api antes).
      reuseExistingServer: false,
      // La IA apagada: un entrante simulado encola ai-reply y nada tiene que salir a OpenRouter.
      env: {
        ...inheritedEnv(),
        WHATSAPP_FAKE_PROVIDER: 'true',
        WAHA_WEBHOOK_HMAC_KEY: process.env['E2E_WAHA_HMAC_KEY'],
        AI_ENABLED: 'false',
        // Los workers buscan trabajos cada 0,5 s (el mínimo de pg-boss): los tests esperan menos.
        JOBS_POLLING_SECONDS: '0.5',
      },
      timeout: 120_000,
    },
    {
      command: 'npx ng serve --port 4200',
      url: 'http://localhost:4200',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
