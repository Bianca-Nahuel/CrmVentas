import { defineConfig } from 'drizzle-kit';
import { loadLocalEnv } from './src/config/load-env.js';

loadLocalEnv();

// Las migraciones corren SIEMPRE como ventas_owner (DATABASE_URL_MIGRATIONS), nunca como la app.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/*.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL_MIGRATIONS ?? '' },
  migrations: { schema: 'drizzle', table: '__drizzle_migrations' },
  strict: true,
  verbose: true,
});
