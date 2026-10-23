import { defineConfig } from 'drizzle-kit';
import { loadLocalEnv } from './src/config/load-env.js';

loadLocalEnv();

// Las migraciones corren SIEMPRE como ventas_owner (DATABASE_URL_MIGRATIONS), nunca como la app.
// La API no valida esta variable: solo la leen drizzle-kit y los tests.
const migrationsUrl = process.env.DATABASE_URL_MIGRATIONS;
if (!migrationsUrl) throw new Error('Falta DATABASE_URL_MIGRATIONS (conexión de ventas_owner para migrar)');

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/*.ts',
  out: './drizzle',
  dbCredentials: { url: migrationsUrl },
  migrations: { schema: 'drizzle', table: '__drizzle_migrations' },
  strict: true,
  verbose: true,
});
