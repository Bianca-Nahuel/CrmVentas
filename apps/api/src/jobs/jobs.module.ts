import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

/** Instancia de pg-boss compartida (encolar desde los controllers, trabajar desde los workers). */
export const BOSS = Symbol('BOSS');

/** Colas. Se crean en las migraciones (drizzle/0004_pgboss.sql, 0007, 0009, 0012), nunca desde la app. */
export const QUEUES = {
  whatsappInbound: 'whatsapp-inbound',
  whatsappOutbound: 'whatsapp-outbound',
  aiReply: 'ai-reply',
  catalogRefresh: 'catalog-refresh',
} as const;

// pg-boss corre como ventas_app (DATABASE_URL) sobre el schema pgboss que crea ventas_owner en la
// migración: sin crear schema, sin migrar y sin REINDEX (ventas_app no es dueño de nada ahí).
// Sin estadísticas ni warnings persistidos: no hacen falta y crearían particiones (DDL).
export function createBoss(env: Env): PgBoss {
  return new PgBoss({
    connectionString: env.DATABASE_URL,
    application_name: 'ventas-jobs',
    max: 4,
    schema: 'pgboss',
    createSchema: false,
    migrate: false,
    reindex: false,
    persistWarnings: false,
    persistQueueStats: false,
    schedule: false,
    // Los trabajos llevan datos personales: el borrado de vencidos corre cada hora (default: 1 día).
    maintenanceIntervalSeconds: 3600,
    instanceName: 'api',
  });
}

// Arranca en la factory: quien inyecte BOSS (controllers, workers) lo recibe ya iniciado, sin depender
// del orden de los hooks de los módulos.
async function startBoss(env: Env): Promise<PgBoss> {
  const logger = new Logger('Jobs');
  const boss = createBoss(env);
  // Solo el mensaje: los errores de pg-boss no incluyen el contenido de los trabajos.
  boss.on('error', (error) => logger.error(`pg-boss: ${error.message}`));
  await boss.start();
  for (const name of Object.values(QUEUES)) {
    if (!(await boss.getQueue(name))) {
      await boss.stop({ graceful: false });
      throw new Error(`Falta la cola ${name}: correr npm run db:migrate`);
    }
  }
  return boss;
}

@Global()
@Module({
  providers: [{ provide: BOSS, inject: [ENV], useFactory: startBoss }],
  exports: [BOSS],
})
export class JobsModule implements OnApplicationShutdown {
  constructor(@Inject(BOSS) private readonly boss: PgBoss) {}

  async onApplicationShutdown(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }
}
