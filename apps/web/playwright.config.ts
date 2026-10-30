import { defineConfig, devices } from '@playwright/test';

// Tests de punta a punta del panel contra la API real (con el seed cargado) a través del proxy de Angular.
// Levanta la API y el front si no están corriendo. Requiere Postgres arriba y `npm run db:seed`.
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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev:api',
      cwd: '../..',
      url: 'http://localhost:3000/api/health',
      reuseExistingServer: true,
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
