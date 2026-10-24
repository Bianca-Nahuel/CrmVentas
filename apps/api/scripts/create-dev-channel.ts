// Crea un canal de WhatsApp no oficial (WAHA) de desarrollo y su sesión en WAHA, con el webhook
// firmado. Uso: npm run dev:create-channel -- --tenant <slug> --name <nombre> --phone <+54...>
//
// - El external_id (nombre de la sesión de WAHA) lo genera este script: 'ch_' + id del canal sin
//   guiones. Nunca se acepta por parámetro (ver "Secuestro de número entre empresas" en decisiones.md).
// - El riesgo de la conexión no oficial lo acepta el owner de la empresa: risk_accepted_by sale de
//   app.user_id, no de un parámetro.
// - El canal se inserta como ventas_app con la empresa activa (RLS). Si WAHA no crea la sesión, la
//   transacción hace rollback y no queda un canal sin sesión.
// - Provisorio: --phone no se verifica contra el teléfono que escanea el QR. En la tarea 008 el número
//   sale del escaneo (me.id de session.status WORKING); ver decisión #27 en docs/decisiones.md.
// Solo para desarrollo: no corre con NODE_ENV=production ni contra una base que no sea local.
import { parseArgs } from 'node:util';
import { and, asc, eq, sql } from 'drizzle-orm';
import { loadLocalEnv } from '../src/config/load-env.js';

if (process.env.NODE_ENV === 'production') {
  console.error('dev:create-channel no se ejecuta con NODE_ENV=production.');
  process.exit(1);
}
loadLocalEnv();

const { parseEnv } = await import('../src/config/env.js');
const { createAppDatabase, createAuthDatabase } = await import('../src/db/pools.js');
const { withTenantTransaction } = await import('../src/db/tenant-context.js');
const { memberships, tenants } = await import('../src/db/schema/auth.js');
const { channels } = await import('../src/db/schema/messaging.js');
const { WahaClient } = await import('../src/whatsapp/providers/waha/waha-client.js');
const { wahaSessionFor } = await import('./lib/waha-session.js');

const USAGE = 'Uso: npm run dev:create-channel -- --tenant <slug> --name <nombre> --phone <+54...>';

const { values } = parseArgs({
  options: {
    tenant: { type: 'string' },
    name: { type: 'string' },
    phone: { type: 'string' },
  },
  strict: true,
});
const tenantSlug = values.tenant?.trim();
const channelName = values.name?.trim();
const phone = values.phone?.trim();
if (!tenantSlug || !channelName || !phone) {
  console.error(USAGE);
  process.exit(1);
}
if (!/^\+[1-9][0-9]{6,14}$/.test(phone)) {
  console.error('--phone tiene que estar en formato E.164 (por ejemplo +5491122334455).');
  process.exit(1);
}
if (channelName.length > 100) {
  console.error('--name admite hasta 100 caracteres.');
  process.exit(1);
}

const env = parseEnv();
const isLocalHost = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
if (env.NODE_ENV === 'production' || !isLocalHost(env.DATABASE_URL) || !isLocalHost(env.DATABASE_URL_AUTH)) {
  console.error('dev:create-channel solo se ejecuta en desarrollo, contra una base local.');
  process.exit(1);
}

const authDatabase = createAuthDatabase(env.DATABASE_URL_AUTH);
const appDatabase = createAppDatabase(env.DATABASE_URL);
const waha = new WahaClient(env.WAHA_BASE_URL, env.WAHA_API_KEY);

try {
  // Empresa y owner (tablas de autenticación: pool de ventas_auth).
  const [owner] = await authDatabase.db
    .select({ tenantId: tenants.id, userId: memberships.userId })
    .from(tenants)
    .innerJoin(memberships, eq(memberships.tenantId, tenants.id))
    .where(
      and(
        eq(tenants.slug, tenantSlug),
        eq(tenants.status, 'active'),
        eq(memberships.role, 'owner'),
        eq(memberships.status, 'active'),
      ),
    )
    .orderBy(asc(memberships.createdAt))
    .limit(1);
  if (!owner) {
    console.error(`No hay una empresa activa con slug "${tenantSlug}" y un owner activo.`);
    process.exit(1);
  }

  const session = await withTenantTransaction(
    appDatabase.db,
    { tenantId: owner.tenantId, userId: owner.userId },
    async (tx) => {
      const idResult = await tx.execute<{ id: string }>(sql`SELECT uuidv7() AS id`);
      const channelId = idResult.rows[0]!.id;
      // Letras, números y guion bajo: válido como nombre de sesión de WAHA.
      const externalId = `ch_${channelId.replaceAll('-', '')}`;
      await tx.insert(channels).values({
        id: channelId,
        tenantId: owner.tenantId,
        name: channelName,
        phoneNumber: phone,
        provider: 'waha',
        connectionType: 'unofficial',
        externalId,
        status: 'pending',
        riskAcceptedAt: sql`now()`,
        riskAcceptedBy: sql`app_user_id()`,
      });
      await waha.createSession(wahaSessionFor(env, externalId));
      return externalId;
    },
  );

  console.log(`Canal creado. Sesión de WAHA: ${session}`);
  console.log(`Escaneá el QR desde el dashboard: ${new URL('/dashboard', env.WAHA_BASE_URL).href}`);
} catch (error) {
  // Los errores de Drizzle traen la consulta con sus parámetros (el teléfono): solo se muestra el código.
  const failure = error as { message?: string; code?: string; cause?: { code?: string } };
  const code = failure.cause?.code ?? failure.code;
  if (code === '23505') {
    console.error('Esa empresa ya tiene un canal con ese número.');
  } else if (failure.message?.startsWith('WAHA respondió')) {
    console.error(`No se pudo crear el canal: ${failure.message}`);
  } else {
    console.error(`No se pudo crear el canal (código ${code ?? 'desconocido'}).`);
  }
  process.exitCode = 1;
} finally {
  await Promise.all([appDatabase.close(), authDatabase.close()]);
}
