import { Inject, Injectable } from '@nestjs/common';
import { DEFAULT_AUTO_CLOSE_DAYS } from '@ventas/shared';
import { sql } from 'drizzle-orm';
import { TenantConfigService } from '../ai/config/tenant-config.service.js';
import { APP_DB, type AppDatabase } from '../db/database.module.js';
import { withTenantTransaction } from '../db/tenant-context.js';
import { closeLockedConversation } from '../inbox/close-conversation.js';

/** Conversaciones que cierra cada transacción del cierre automático. */
const AUTO_CLOSE_BATCH = 200;

/**
 * Cierre por inactividad (tarea 026): las conversaciones abiertas sin mensajes en
 * inbox.auto_close_after_days días se cierran con auto_inactive y sin autor. null = nunca. Sin config
 * vigente (o inválida) usa el valor por defecto.
 */
@Injectable()
export class AutoCloseService {
  constructor(
    @Inject(APP_DB) private readonly database: AppDatabase,
    private readonly configs: TenantConfigService,
  ) {}

  async run(tenantId: string): Promise<{ closed: number }> {
    let closed = 0;
    for (;;) {
      const batch = await withTenantTransaction(this.database.db, { tenantId }, async (tx) => {
        const lookup = await this.configs.latest(tx);
        const days =
          lookup.kind === 'ok' ? lookup.config.inbox.auto_close_after_days : DEFAULT_AUTO_CLOSE_DAYS;
        if (days === null) return 0;
        // SKIP LOCKED: una conversación que en este momento bloquea otro trabajo (un entrante, la IA) se
        // deja para mañana; ese trabajo le acaba de dar actividad.
        const due = await tx.execute<{ id: string; channel_id: string }>(sql`
          SELECT c.id, c.channel_id FROM conversations c
          WHERE c.status = 'open' AND c.last_message_at < now() - make_interval(days => ${days})
          ORDER BY c.last_message_at, c.id
          LIMIT ${AUTO_CLOSE_BATCH}
          FOR UPDATE SKIP LOCKED
        `);
        for (const row of due.rows) {
          await closeLockedConversation(
            tx,
            { tenantId, conversationId: row.id, channelId: row.channel_id },
            { outcome: 'auto_inactive', note: null, userId: null },
          );
        }
        return due.rows.length;
      });
      closed += batch;
      if (batch < AUTO_CLOSE_BATCH) return { closed };
    }
  }
}
