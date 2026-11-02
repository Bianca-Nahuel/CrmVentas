import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { AppTx, TenantContext } from '../db/tenant-context.js';
import { publishNotice } from '../realtime/publish.js';
import type { channelWithMembersSchema } from './channels.contracts.js';

export type ChannelWithMembers = z.infer<typeof channelWithMembersSchema>;
type MemberRef = ChannelWithMembers['sellers'][number];

// Fecha en ISO 8601 con zona, como el resto de la API (ver inbox.service.ts).
const iso = (column: SQL) => sql`to_json(${column}) #>> '{}'`;

/** Asignación de números a vendedores (owner y admin; el permiso lo controla el guard). */
@Injectable()
export class ChannelsService {
  async list(tx: AppTx, channelId?: string): Promise<ChannelWithMembers[]> {
    // number_in_use: el último rechazo dice si el número está en esta empresa (y en qué canal, visible por
    // RLS) o en otra. La pausa: until null si es sin vencimiento ('infinity'); vencida = sin pausa.
    const channels = await tx.execute<{
      id: string;
      name: string;
      phone_number: string | null;
      status: ChannelWithMembers['status'];
      connected_at: string | null;
      disconnected_at: string | null;
      disconnect_reason: ChannelWithMembers['disconnectReason'];
      in_use_scope: 'same_tenant' | 'other_tenant' | null;
      in_use_channel: string | null;
      paused: boolean;
      paused_until: string | null;
      paused_reason: string | null;
    }>(sql`
      SELECT ch.id, ch.name, ch.phone_number, ch.status,
             ${iso(sql`ch.connected_at`)} AS connected_at,
             ${iso(sql`ch.disconnected_at`)} AS disconnected_at,
             ch.disconnect_reason,
             rejection.data ->> 'scope' AS in_use_scope,
             other.name AS in_use_channel,
             (ch.sending_paused_until > now()) AS paused,
             CASE WHEN ch.sending_paused_until <> 'infinity'
               THEN ${iso(sql`ch.sending_paused_until`)} END AS paused_until,
             ch.sending_paused_reason AS paused_reason
      FROM channels ch
      LEFT JOIN LATERAL (
        SELECT e.data FROM channel_events e
        WHERE ch.disconnect_reason = 'number_in_use' AND e.channel_id = ch.id AND e.type = 'number_in_use'
        ORDER BY e.created_at DESC LIMIT 1
      ) rejection ON true
      LEFT JOIN channels other ON other.id = (rejection.data ->> 'otherChannelId')::uuid
      WHERE ${channelId === undefined ? sql`true` : sql`ch.id = ${channelId}`}
      ORDER BY ch.name, ch.id
    `);
    const sellers = await this.assignedSellers(tx);
    return channels.rows.map((row) => ({
      id: row.id,
      name: row.name,
      phoneNumber: row.phone_number,
      status: row.status,
      connectedAt: row.connected_at,
      disconnectedAt: row.disconnected_at,
      disconnectReason: row.disconnect_reason,
      numberInUse: row.in_use_scope ? { scope: row.in_use_scope, channelName: row.in_use_channel } : null,
      sendingPause: row.paused
        ? { until: row.paused_until, blockedRisk: (row.paused_reason ?? '').startsWith('blocked_risk') }
        : null,
      sellers: sellers.get(row.id) ?? [],
    }));
  }

  /** Un canal de la empresa activa (404 si no existe o es de otra empresa). */
  async get(tx: AppTx, channelId: string): Promise<ChannelWithMembers> {
    const [channel] = await this.list(tx, channelId);
    if (!channel) throw new NotFoundException({ code: 'NOT_FOUND' });
    return channel;
  }

  /** Vendedores con membresía activa: los únicos que se pueden asignar. */
  async sellerOptions(tx: AppTx): Promise<MemberRef[]> {
    const result = await tx.execute<{ user_id: string; name: string; email: string }>(sql`
      SELECT m.user_id, u.name, u.email
      FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = app_tenant_id() AND m.status = 'active' AND m.role = 'seller'
      ORDER BY u.name, m.user_id
    `);
    return result.rows.map((row) => ({ userId: row.user_id, name: row.name, email: row.email }));
  }

  /**
   * Reemplaza los vendedores de un número. Cada uno tiene que tener membresía activa con rol seller en la
   * empresa activa; si alguno no cumple (o está repetido), 400 y no cambia nada.
   */
  async setMembers(
    tx: AppTx,
    context: TenantContext,
    channelId: string,
    userIds: string[],
  ): Promise<ChannelWithMembers> {
    const channel = await tx.execute(sql`SELECT 1 FROM channels WHERE id = ${channelId} FOR UPDATE`);
    if (channel.rows.length === 0) throw new NotFoundException({ code: 'NOT_FOUND' });

    const unique = [...new Set(userIds)];
    if (unique.length !== userIds.length) throw new BadRequestException({ code: 'INVALID_MEMBERS' });
    if (unique.length > 0) {
      const valid = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM memberships
        WHERE tenant_id = app_tenant_id() AND status = 'active' AND role = 'seller'
          AND user_id = ANY (${sql.param(unique)}::uuid[])
      `);
      if ((valid.rows[0]?.n ?? 0) !== unique.length)
        throw new BadRequestException({ code: 'INVALID_MEMBERS' });
    }

    // Solo cambia lo que cambió: los que siguen conservan quién y cuándo los asignó.
    await tx.execute(sql`
      DELETE FROM channel_members
      WHERE channel_id = ${channelId} AND user_id <> ALL (${sql.param(unique)}::uuid[])
    `);
    if (unique.length > 0) {
      await tx.execute(sql`
        INSERT INTO channel_members (tenant_id, channel_id, user_id, created_by)
        SELECT app_tenant_id(), ${channelId}, user_id, ${context.userId}
        FROM unnest(${sql.param(unique)}::uuid[]) AS user_id
        ON CONFLICT (channel_id, user_id) DO NOTHING
      `);
    }
    // Tiempo real: los streams de la empresa recalculan qué números ven (a un seller sin el número se le
    // cortan sus eventos). Se entrega con el commit; si algo falla después, no se avisa nada.
    await publishNotice(tx, { kind: 'access', tenantId: context.tenantId });
    return this.get(tx, channelId);
  }

  private async assignedSellers(tx: AppTx): Promise<Map<string, MemberRef[]>> {
    const result = await tx.execute<{ channel_id: string; user_id: string; name: string; email: string }>(sql`
      SELECT cm.channel_id, cm.user_id, u.name, u.email
      FROM channel_members cm
      JOIN memberships m ON m.tenant_id = cm.tenant_id AND m.user_id = cm.user_id
      JOIN users u ON u.id = cm.user_id
      WHERE m.status = 'active' AND m.role = 'seller'
      ORDER BY u.name, cm.user_id
    `);
    const byChannel = new Map<string, MemberRef[]>();
    for (const row of result.rows) {
      const list = byChannel.get(row.channel_id) ?? [];
      list.push({ userId: row.user_id, name: row.name, email: row.email });
      byChannel.set(row.channel_id, list);
    }
    return byChannel;
  }
}
