// Crea un canal de WhatsApp no oficial (WAHA) de desarrollo y su sesión en WAHA, con el webhook
// firmado. Uso: npm run dev:create-channel -- --tenant <slug> --name <nombre>
// Lo mismo que "Conectar un número" en la pantalla Canales del panel (tarea 011), que es el camino normal.
//
// - El external_id (nombre de la sesión de WAHA) lo genera este script: 'ch_' + id del canal sin
//   guiones. Nunca se acepta por parámetro (ver "Secuestro de número entre empresas" en decisiones.md).
// - El riesgo de la conexión no oficial lo acepta el owner de la empresa: risk_accepted_by sale de
//   app.user_id, no de un parámetro.
// - El canal se inserta como ventas_app con la empresa activa (RLS). Si WAHA no crea la sesión, la
//   transacción hace rollback y no queda un canal sin sesión.
// - Sin número: el canal queda pending y el número sale del escaneo del QR (me.id de session.status
//   WORKING, decisión #27). El QR se escanea desde el panel (/canales → Ver QR) o el dashboard de WAHA.
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
const { WahaProvider } = await import('../src/whatsapp/providers/waha/waha.provider.js');

const USAGE = 'Uso: npm run dev:create-channel -- --tenant <slug> --name <nombre>';

const { values } = parseArgs({
  options: {
    tenant: { type: 'string' },
    name: { type: 'string' },
  },
  strict: true,
});
const tenantSlug = values.tenant?.trim();
const channelName = values.name?.trim();
if (!tenantSlug || !channelName) {
  console.error(USAGE);
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
const waha = new WahaProvider(new WahaClient(env.WAHA_BASE_URL, env.WAHA_API_KEY), {
  webhookUrl: env.WAHA_WEBHOOK_URL,
  hmacKey: env.WAHA_WEBHOOK_HMAC_KEY,
});

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
      const externalId = waha.sessionIdFor(channelId);
      await tx.insert(channels).values({
        id: channelId,
        tenantId: owner.tenantId,
        name: channelName,
        phoneNumber: null,
        provider: waha.id,
        connectionType: waha.connectionType,
        externalId,
        status: 'pending',
        riskAcceptedAt: sql`now()`,
        riskAcceptedBy: sql`app_user_id()`,
      });
      const opened = await waha.openSession(externalId);
      if (!opened.ok) throw new Error(`WAHA respondió ${opened.code} al crear la sesión`);
      return { channelId, externalId };
    },
  );

  console.log(`Canal creado (${session.channelId}). Sesión de WAHA: ${session.externalId}`);
  console.log('Escaneá el QR desde el panel (Canales → Ver QR) o desde el dashboard de WAHA.');
} catch (error) {
  // Los errores de Drizzle traen la consulta con sus parámetros: solo se muestra el código.
  const failure = error as { message?: string; code?: string; cause?: { code?: string } };
  const code = failure.cause?.code ?? failure.code;
  if (failure.message?.startsWith('WAHA respondió')) {
    console.error(`No se pudo crear el canal: ${failure.message}`);
  } else {
    console.error(`No se pudo crear el canal (código ${code ?? 'desconocido'}).`);
  }
  process.exitCode = 1;
} finally {
  await Promise.all([appDatabase.close(), authDatabase.close()]);
}
