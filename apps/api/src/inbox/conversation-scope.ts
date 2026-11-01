import { Injectable } from '@nestjs/common';
import { roleCan } from '@ventas/shared';
import { sql, type SQL } from 'drizzle-orm';
import { TenantConfigService } from '../ai/config/tenant-config.service.js';
import type { AppTx, TenantContext } from '../db/tenant-context.js';

export type Scope = { all: true } | { all: false; channelIds: string[] };

/**
 * Qué números (canales) puede ver el usuario del request. Es EL control de visibilidad de la bandeja: lo
 * usan la lista, el detalle, los mensajes y reactivar la IA (y lo van a usar el envío de la 024 y los
 * eventos de la 025). La RLS de 0015 (channel_visibility) repite la regla como red de seguridad.
 *   - read_all en libs/shared (owner, admin) → todos;
 *   - seller → los de channel_members, o todos si la config vigente tiene inbox.sellers_see_all_channels.
 * Una conversación que no entra en el scope responde 404, igual que una que no existe.
 */
@Injectable()
export class ConversationScope {
  constructor(private readonly configs: TenantConfigService) {}

  async resolve(tx: AppTx, context: TenantContext): Promise<Scope> {
    if (roleCan(context.role, { conversation: ['read_all'] })) return { all: true };
    if (!roleCan(context.role, { conversation: ['read'] })) return { all: false, channelIds: [] };
    if (context.role === 'seller') {
      const lookup = await this.configs.latest(tx);
      if (lookup.kind === 'ok' && lookup.config.inbox?.sellers_see_all_channels === true)
        return { all: true };
    }
    const result = await tx.execute<{ channel_id: string }>(sql`
      SELECT channel_id FROM channel_members WHERE user_id = ${context.userId}
    `);
    return { all: false, channelIds: result.rows.map((row) => row.channel_id) };
  }
}

/** Condición SQL sobre una columna channel_id (por ejemplo sql`c.channel_id`). */
export function scopeCondition(scope: Scope, channelColumn: SQL): SQL {
  if (scope.all) return sql`true`;
  if (scope.channelIds.length === 0) return sql`false`;
  return sql`${channelColumn} = ANY (${sql.param(scope.channelIds)}::uuid[])`;
}
